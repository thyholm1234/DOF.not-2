import sqlite3
from fastapi import FastAPI, Request, status, HTTPException, WebSocket, WebSocketDisconnect, Body, Header
from fastapi.responses import JSONResponse, FileResponse, PlainTextResponse, HTMLResponse
import json
import os
import glob
from datetime import datetime, timedelta
from fastapi.staticfiles import StaticFiles
from pywebpush import webpush, WebPushException
import unicodedata
import re
import html
import urllib.request
from urllib.parse import urljoin, urlparse, parse_qs
from fastapi import Query  # Kun hvis du stadig bruger Query i nogle endpoints
from contextlib import asynccontextmanager, suppress
from dotenv import load_dotenv
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List
import threading
from collections import defaultdict
import time
import asyncio
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import Request as StarletteRequest
import pytz
import logging
import subprocess

load_dotenv()

VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY")
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY")

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "web", "obs"))
BLACKLIST_PATH = os.path.join(os.path.dirname(__file__), "blacklist.json")
MAX_BODY_SIZE = 2 * 1024 * 1024  # 2 MB
SYNC_PATH = os.path.join(os.path.dirname(__file__), "request_sync.json")

comment_file_locks = defaultdict(threading.Lock)
dk_time = datetime.now(pytz.timezone("Europe/Copenhagen")).isoformat()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Oprydning i baggrundstråd (blocking) – uændret
    def run_and_repeat():
        while True:
            try:
                cleanup_dirs(os.path.join(web_dir, "payload"), days=3)
                cleanup_dirs(os.path.join(web_dir, "obs"), days=3)
                database_maintenance()
            except Exception as e:
                logging.exception(f"[cleanup] Fejl under oprydning: {e}")
            time.sleep(3600)

    t = threading.Thread(target=run_and_repeat, daemon=True)
    t.start()

    yield  # appen kører


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://notifikation.dofbasen.dk"],  # eller ["*"] for test, men ikke i produktion!
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    body = await request.body()
    if len(body) > MAX_BODY_SIZE:
        return JSONResponse({"error": "Request body for stor"}, status_code=413)
    request._body = body  # så body stadig kan læses senere
    return await call_next(request)

DB_PATH = os.path.join(os.path.dirname(__file__), "users.db")

logging.basicConfig(
    filename="server.log",
    format="%(message)s",
    level=logging.INFO,
)

def db_init():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_prefs (
                user_id TEXT PRIMARY KEY,
                prefs TEXT,
                ts INTEGER
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS subscriptions (
                user_id TEXT,
                device_id TEXT,
                subscription TEXT,
                PRIMARY KEY (user_id, device_id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS thread_subs (
                day TEXT,
                thread_id TEXT,
                user_id TEXT,
                device_id TEXT,
                PRIMARY KEY (day, thread_id, user_id, device_id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS thread_unsubs (
                day TEXT,
                thread_id TEXT,
                user_id TEXT,
                device_id TEXT,
                PRIMARY KEY (day, thread_id, user_id, device_id)
            )
        """)
db_init()

def cleanup_user_prefs_without_subscriptions():
    """
    Slet alle user_prefs hvor user_id ikke findes i subscriptions.
    """
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            DELETE FROM user_prefs
            WHERE user_id NOT IN (SELECT DISTINCT user_id FROM subscriptions)
        """)
        conn.commit()

def cleanup_dirs(base_dir, days=3):
    now = datetime.now()
    for name in os.listdir(base_dir):
        dir_path = os.path.join(base_dir, name)
        if not os.path.isdir(dir_path):
            continue
        try:
            dir_date = datetime.strptime(name, "%d-%m-%Y")
        except ValueError:
            continue
        if (now - dir_date).days >= days:
            print(f"Sletter: {dir_path}")
            import shutil
            shutil.rmtree(dir_path)

def database_maintenance():
    with sqlite3.connect(DB_PATH) as conn:
        # Slet KUN thread_subs og thread_unsubs for dage der ikke længere findes i obs
        for table in ["thread_subs", "thread_unsubs"]:
            days = conn.execute(f"SELECT DISTINCT day FROM {table}").fetchall()
            for (day,) in days:
                obs_dir = os.path.join(web_dir, "obs", day)
                if not os.path.isdir(obs_dir):
                    print(f"Sletter {table} for dag {day} (mappe findes ikke)")
                    conn.execute(f"DELETE FROM {table} WHERE day=?", (day,))
        conn.commit()
    # Ryd op i user_prefs uden tilknyttede subscriptions
    cleanup_user_prefs_without_subscriptions()  

def send_push(sub, push_payload, user_id, device_id):
    try:
        webpush(
            subscription_info=sub,
            data=json.dumps(push_payload),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={"sub": "mailto:kontakt@dofnot.dk"},
            ttl=3600,
            headers={"Urgency": "high"}  # <-- Tilføj urgency high
        )
    except WebPushException as ex:
        should_delete = False
        if hasattr(ex, "response") and ex.response and getattr(ex.response, "status_code", None) == 410:
            should_delete = True
        elif "unsubscribed" in str(ex).lower() or "expired" in str(ex).lower():
            should_delete = True
        if should_delete:
            print(f"Sletter abonnement for {user_id}/{device_id} pga. push-fejl: {ex}")
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute(
                    "DELETE FROM subscriptions WHERE user_id=? AND device_id=?",
                    (user_id, device_id)
                )
                conn.execute(
                    "DELETE FROM thread_subs WHERE user_id=? AND device_id=?",
                    (user_id, device_id)
                )
                conn.execute(
                    "DELETE FROM thread_unsubs WHERE user_id=? AND device_id=?",
                    (user_id, device_id)
                )
                # Slet user_prefs hvis der ikke er flere subscriptions for user_id
                remaining = conn.execute(
                    "SELECT 1 FROM subscriptions WHERE user_id=? LIMIT 1",
                    (user_id,)
                ).fetchone()
                if not remaining:
                    conn.execute(
                        "DELETE FROM user_prefs WHERE user_id=?",
                        (user_id,)
                    )
                conn.commit()
        else:
            print(f"Push-fejl til {user_id}/{device_id}: {ex}")

def get_prefs(user_id):
    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute("SELECT prefs FROM user_prefs WHERE user_id=?", (user_id,))
        row = cur.fetchone()
        return json.loads(row[0]) if row else {}

def set_prefs(user_id, prefs):
    ts = int(datetime.now().timestamp())
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO user_prefs (user_id, prefs, ts) VALUES (?, ?, ?)",
            (user_id, json.dumps(prefs), ts)
        )

@app.get("/share/{day}/{thread_id}", response_class=HTMLResponse)
async def share_thread(day: str, thread_id: str, user_agent: str = Header(None)):
    import html
    import pytz
    from datetime import datetime

    thread_path = os.path.join(web_dir, "obs", day, "threads", thread_id, "thread.json")
    if not os.path.isfile(thread_path):
        return HTMLResponse("<h1>Ikke fundet</h1>", status_code=404)
    with open(thread_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    thread = data.get("thread", {})
    art = thread.get("art", "").strip()
    lok = thread.get("lok", "").strip()
    images = thread.get("images", [])
    # Brug et billede på mindst 1200x630 px hvis muligt!
    og_image = images[0] if images else "https://notifikation.dofbasen.dk/icons/icon-2048.png"
    og_image_width = "2048"
    og_image_height = "2048"
    og_image_type = "image/png" if og_image.endswith(".png") else "image/jpeg"
    if art and lok:
        og_title = f"{art} - {lok}"
    elif art:
        og_title = art
    elif lok:
        og_title = lok
    else:
        og_title = "DOFbasen Notifikation"
    og_desc = f"Se observationen af {art or 'en fugl'} ved {lok or 'ukendt lokalitet'} i DOFbasen Notifikationer."
    # Sæt url og canonical til denne /share/...-side!
    url = f"https://notifikation.dofbasen.dk/share/{day}/{thread_id}"
    canonical = f'<link rel="canonical" href="{html.escape(url)}">'

    crawler_agents = [
        "facebookexternalhit", "facebookcatalog", "meta-webindexer",
        "meta-externalads", "meta-externalagent", "meta-externalfetcher", "bsky"
    ]
    is_crawler = user_agent and any(a in user_agent.lower() for a in crawler_agents)

    # Kun redirect for almindelige brugere, ikke crawlers
    meta_refresh = ""
    if user_agent and not is_crawler:
        # Omdiriger til traad.html for almindelige brugere
        traad_url = f"https://notifikation.dofbasen.dk/traad.html?date={day}&id={thread_id}&from_share=1"
        meta_refresh = f'<meta http-equiv="refresh" content="0; url={html.escape(traad_url)}">'

    html_out = f"""<!DOCTYPE html>
<html lang="da">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>{html.escape(og_title)}</title>
  <meta property="og:url" content="{html.escape(url)}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="{html.escape(og_title)}">
  <meta property="og:description" content="{html.escape(og_desc)}">
  <meta property="og:site_name" content="DOFbasen Notifikationer">
  <meta property="og:image" content="{html.escape(og_image)}">
  <meta property="og:image:type" content="{og_image_type}">
  <meta property="og:image:width" content="{og_image_width}">
  <meta property="og:image:height" content="{og_image_height}">
  <meta property="og:locale" content="da_DK">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{html.escape(og_title)}">
  <meta name="twitter:description" content="{html.escape(og_desc)}">
  <meta name="twitter:image" content="{html.escape(og_image)}">
  <meta name="twitter:image:alt" content="{html.escape(og_title)}">
  {canonical}
  {meta_refresh}
</head>
<body>
  <p>Omdirigerer til <a href="https://notifikation.dofbasen.dk/traad.html?date={day}&id={thread_id}">https://notifikation.dofbasen.dk/traad.html?date={day}&id={thread_id}</a>...</p>
</body>
</html>
"""
    return HTMLResponse(content=html_out, status_code=200)

@app.post("/api/log-pageview")
async def log_pageview(data: dict, request: Request):
    url = data.get("url")
    user_id = data.get("user_id")
    os_info = data.get("os", "Unknown")
    browser = data.get("browser", "Unknown")
    is_pwa = data.get("is_pwa", False)
    from_sharelink = data.get("from_sharelink", False)
    ip = request.client.host
    dk_time = datetime.now(pytz.timezone("Europe/Copenhagen")).isoformat()
    with open("pageviews.log", "a", encoding="utf-8") as f:
        f.write(f"{dk_time} {ip} {user_id} {url} OS: {os_info}  BROWSER: {browser}  PWA: {is_pwa}{'  SHARELINK: True' if from_sharelink else ''}\n")
    return {"ok": True}

@app.post("/api/admin/superadmin")
async def superadmins(data: dict = Body(None)):
    action = (data or {}).get("action", "get")
    user_id = (data or {}).get("user_id", "")
    obserkode = ((data or {}).get("obserkode") or "").strip().upper()
    try:
        superadmins = load_superadmins()
        # Hent protected-listen direkte fra filen (hvis du bruger den)
        with open("./superadmin.json", "r", encoding="utf-8") as f:
            file_data = json.load(f)
        protected = set(file_data.get("protected", []))
        requester_obserkode = get_obserkode_from_userprefs(user_id)
        if requester_obserkode not in superadmins:
            raise HTTPException(status_code=403, detail="Kun hovedadmin")
        if action == "get":
            return {"superadmins": sorted(superadmins)}
        elif action == "toggle":
            if not obserkode:
                raise HTTPException(status_code=400, detail="Obserkode mangler")
            if obserkode in protected:
                raise HTTPException(status_code=400, detail="Denne superadmin kan ikke fjernes")
            if obserkode in superadmins:
                superadmins.remove(obserkode)
            else:
                superadmins.add(obserkode)
            file_data["superadmins"] = sorted(superadmins)
            with open("./superadmin.json", "w", encoding="utf-8") as f:
                json.dump(file_data, f, ensure_ascii=False, indent=2)
            return {"ok": True, "superadmins": file_data["superadmins"]}
        else:
            raise HTTPException(status_code=400, detail="Ugyldig action")
    except Exception as e:
        return {"ok": False, "error": str(e), "superadmins": []}

@app.post("/api/prefs")
async def api_prefs(request: Request):
    data = await request.json()
    user_id = data.get("user_id")
    new_prefs = data.get("prefs")
    if new_prefs is not None:
        # Opdater kun afdelingsnøgler
        old_prefs = get_prefs(user_id)
        for afd in new_prefs:
            old_prefs[afd] = new_prefs[afd]
        set_prefs(user_id, old_prefs)
        return {"ok": True}
    # Hvis ingen prefs i body, returner prefs for user
    prefs = get_prefs(user_id)
    return JSONResponse(prefs)
    

@app.post("/api/subscribe")
async def api_subscribe(request: Request):
    data = await request.json()
    user_id = data.get("user_id") or data.get("userid")
    device_id = data.get("device_id") or data.get("deviceid")
    subscription = data.get("subscription")
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO subscriptions (user_id, device_id, subscription) VALUES (?, ?, ?)",
            (user_id, device_id, json.dumps(subscription))
        )
    return {"ok": True}

@app.post("/api/unsubscribe")
async def api_unsubscribe(request: Request):
    data = await request.json()
    user_id = data.get("user_id")
    device_id = data.get("device_id")
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "DELETE FROM subscriptions WHERE user_id=? AND device_id=?",
            (user_id, device_id)
        )
    return {"ok": True}



# Stier
web_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "web"))
payload_dir = os.path.join(web_dir, "payload")
latest_symlink_path = os.path.join(web_dir, "payload", "latest.json")

def _parse_dt_from_row(row: dict) -> datetime:
    time_keys = ["Obstidtil", "Obstidfra", "Turtidtil", "Turtidfra"]
    date_str = (row.get("Dato") or "").strip()
    if not date_str:
        return datetime.min
    time_str = ""
    for k in time_keys:
        v = (row.get(k) or "").strip()
        if v:
            time_str = v
            break
    if not time_str:
        time_str = "00:00"
    try:
        return datetime.strptime(f"{date_str} {time_str}", "%d-%m-%Y %H:%M")
    except Exception:
        try:
            return datetime.strptime(date_str, "%d-%m-%Y")
        except Exception:
            return datetime.min
        
def should_include_obs(obs, species_filters):
    artnavn = (obs.get("Artnavn") or "").strip().lower()
    # Ekskluderede arter har altid højeste prioritet
    if artnavn in [a.lower() for a in species_filters.get("exclude", [])]:
        return False
    # Minimumsantal (hvis sat)
    min_count = species_filters.get("counts", {}).get(artnavn)
    if min_count is not None:
        try:
            antal = int(obs.get("Antal") or 0)
            if antal < int(min_count):
                return False
        except Exception:
            return False
    # Hvis ikke ekskluderet og evt. antal opfyldt, så inkluder
    return True

def _latest_from_data(data):
    if isinstance(data, list) and data:
        try:
            return max(data, key=_parse_dt_from_row)
        except Exception:
            return data[-1]
    if isinstance(data, dict):
        return data
    return {}

def _ts() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")

def _save_payload(payload) -> str:
    # Opret dato-mappe i format DD-MM-YYYY
    today = datetime.now().strftime("%d-%m-%Y")
    datedir = os.path.join(payload_dir, today)
    os.makedirs(datedir, exist_ok=True)
    fname = f"payload_{_ts()}.json"
    fpath = os.path.join(datedir, fname)
    with open(fpath, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False)
    # Skriv/overskriv "latest.json" for nem hentning (stadig i payload_dir)
    with open(latest_symlink_path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False)
    return fpath

def _get_latest_payload_path() -> str | None:
    # Foretræk latest.json hvis den findes
    if os.path.exists(latest_symlink_path) and os.path.getsize(latest_symlink_path) > 0:
        return latest_symlink_path
    # Ellers find seneste payload_*.json
    pattern = os.path.join(payload_dir, "payload_*.json")
    files = glob.glob(pattern)
    if not files:
        return None
    return max(files, key=os.path.getmtime)

def _load_latest_payload():
    path = _get_latest_payload_path()
    if not path:
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None
    
def normalize(s):
    if not isinstance(s, str):
        return ""
    s = s.lower()
    s = s.replace("æ", "ae").replace("ø", "oe").replace("å", "aa")
    s = unicodedata.normalize("NFKD", s)
    return s

_IMG_URL_RE = re.compile(
    r"""(?:"|')(?P<u>(?:https?:)?//dofbasen\.dk/image_proxy\.php\?[^"']+|/image_proxy\.php\?[^"']+)["']""",
    re.IGNORECASE,
)

def _fetch_html(url: str, timeout: float = 10.0) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (DOF.not server) AppleWebKit/537.36 Chrome/119 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        ctype = resp.headers.get("Content-Type", "")

    # Try charset from header, then meta, then fallbacks
    m = re.search(r"charset=([\w\-]+)", ctype, re.I)
    enc = m.group(1) if m else None
    if not enc:
        m2 = re.search(rb"<meta[^>]+charset=['\"]?([\w\-]+)", raw, re.I)
        enc = (m2.group(1).decode("ascii", "ignore") if m2 else None)
    for candidate in [enc, "windows-1252", "iso-8859-1", "utf-8"]:
        try:
            return raw.decode(candidate or "utf-8", errors="strict")
        except Exception:
            continue
    return raw.decode("utf-8", errors="replace")

def _image_proxy_to_service_url(u: str, base: str = "https://dofbasen.dk") -> str | None:
    """
    Map image_proxy.php?… → https://service.dofbasen.dk/media/image/o/<filename>.jpg
    Handles HTML entities (&amp;) and stray %3B in query delimiters.
    """
    if not u:
        return None
    s = html.unescape(str(u))
    # Fix cases like ?mode=o&amp%3Bpic=... (remove encoded ';' after & or ?)
    s = re.sub(r'([?&])%3B', r'\1', s, flags=re.IGNORECASE)
    absu = urljoin(base, s)
    pu = urlparse(absu)
    if not pu.path.lower().endswith("/image_proxy.php"):
        return None
    qs = parse_qs(pu.query, keep_blank_values=True)
    # keys may be like 'pic' or weirdly prefixed; normalize
    pic = None
    for k, vals in qs.items():
        kk = k.lower().lstrip(' ;')
        if kk == "pic" and vals:
            pic = vals[0]
            break
    if not pic:
        return None
    filename = str(pic).split("/")[-1]
    if not filename:
        return None
    return f"https://service.dofbasen.dk/media/image/o/{filename}"

def _extract_service_image_urls(html_text: str) -> list[str]:
    seen = set()
    out: list[str] = []
    for m in _IMG_URL_RE.finditer(html_text or ""):
        raw_u = m.group("u")
        svc = _image_proxy_to_service_url(raw_u)
        if not svc:
            continue
        key = svc.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(svc)
    return out

ALLOWED_CSV_FILES = {
    "data/arter_filter_klassificeret.csv",
    "data/bornholm_bemaerk_parsed.csv",
    "data/faenologi.csv",
    "data/fyn_bemaerk_parsed.csv",
    "data/koebenhavn_bemaerk_parsed.csv",
    "data/nordjylland_bemaerk_parsed.csv",
    "data/nordsjaelland_bemaerk_parsed.csv",
    "data/nordvestjylland_bemaerk_parsed.csv",
    "data/oestjylland_bemaerk_parsed.csv",
    "data/soenderjylland_bemaerk_parsed.csv",
    "data/storstroem_bemaerk_parsed.csv",
    "data/sydoestjylland_bemaerk_parsed.csv",
    "data/sydvestjylland_bemaerk_parsed.csv",
    "data/vestjylland_bemaerk_parsed.csv",
    "data/vestsjaelland_bemaerk_parsed.csv",
    "web/data/arter_filter_klassificeret.csv",
    "data/arter_dof_content.csv"
}

@app.post("/api/admin/csv")
async def admin_csv(request: Request):
    data = await request.json()
    file = data.get("file")
    user_id = data.get("user_id", "")
    device_id = data.get("device_id", "")
    action = data.get("action", "read")  # "read" eller "write"
    if file not in ALLOWED_CSV_FILES:
        raise HTTPException(status_code=403, detail="Ugyldig filsti")
    obserkode = get_obserkode_from_userprefs(user_id)
    superadmins = load_superadmins()
    if obserkode not in superadmins:
        raise HTTPException(status_code=403, detail="Kun hovedadmin")

    path = os.path.join(os.path.dirname(__file__), "..", file)
    if action == "read":
        if not os.path.isfile(path):
            raise HTTPException(status_code=404, detail="File not found")
        with open(path, "r", encoding="utf-8") as f:
            return PlainTextResponse(f.read())
    elif action == "write":
        content = data.get("content", "")
        # Skriv til begge hvis det er arter_filter_klassificeret.csv
        if file.endswith("arter_filter_klassificeret.csv"):
            path1 = os.path.join(os.path.dirname(__file__), "..", "data", "arter_filter_klassificeret.csv")
            path2 = os.path.join(os.path.dirname(__file__), "..", "web", "data", "arter_filter_klassificeret.csv")
            for p in {path1, path2}:
                with open(p, "w", encoding="utf-8") as f:
                    f.write(content)
        else:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
        return {"ok": True}
    else:
        raise HTTPException(status_code=400, detail="Ugyldig action")

def append_line_robust(path, line):
    needs_newline = False
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with open(path, "rb") as f:
            try:
                f.seek(-1, os.SEEK_END)
                last_char = f.read(1)
                if last_char not in (b'\n', b'\r'):
                    needs_newline = True
            except OSError:
                pass
    with open(path, "a", encoding="utf-8") as f:
        if needs_newline:
            f.write("\n")
        f.write(line if line.endswith("\n") else line + "\n")

@app.api_route("/api/admin/fetch-faenologi-csv", methods=["GET", "POST"])
async def fetch_faenologi_csv(request: Request):
    import urllib.request
    import re
    import html

    urls = {
        "sommer": "https://dofbasen.dk/opslag/wsdata.php?tid=sommer",
        "vinter": "https://dofbasen.dk/opslag/wsdata.php?tid=vinter"
    }
    rows = []
    for season, url in urls.items():
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (DOF.not server)",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            html_text = resp.read().decode("windows-1252", errors="replace")
        for m in re.finditer(
            r"<tr><td>(\d+)</td><td[^>]*>.*?</td><td>(?:<span[^>]*>)?([^<]+)(?:</span>)?</td><td>\(([\d/]+)-([\d/]+)\)</td></tr>",
            html_text
        ):
            artnr, artnavn, datofra, datotil = m.groups()
            artnavn = html.unescape(artnavn)
            def fix_date(s):
                d, m = s.split("/")
                return f"{int(d):02d}-{int(m):02d}"
            datofra = fix_date(datofra)
            datotil = fix_date(datotil)
            rows.append([artnr, artnavn, datofra, datotil])

    csv_header = "Artnr;Artnavn;Datofra;Datotil\n"
    csv_content = csv_header + "\n".join(";".join(row) for row in rows) + "\n"

    # Skriv til begge placeringer hvis ændret
    csv_paths = [
        os.path.join(os.path.dirname(__file__), "..", "data", "faenologi.csv"),
        os.path.join(os.path.dirname(__file__), "..", "web", "data", "faenologi.csv"),
    ]
    old_content = ""
    if os.path.exists(csv_paths[0]):
        with open(csv_paths[0], "r", encoding="utf-8-sig") as f:
            old_content = f.read()
    changed = (csv_content != old_content)

    if changed:
        for path in csv_paths:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8-sig", newline="") as f:
                f.write(csv_content)
        try:
            subprocess.run(
                ["python", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "update_version.py")), "small"],
                check=True,
                cwd=os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
            )
        except Exception as e:
            return {"ok": True, "rows": len(rows), "changed": changed, "update_version_error": str(e)}
    return {"ok": True, "rows": len(rows), "changed": changed}

@app.api_route("/api/admin/fetch-all-bemaerk-csv", methods=["GET", "POST"])
async def fetch_all_bemaerk_csv(request: Request):
    import os
    import subprocess
    import urllib.request
    import re
    import html
    import unicodedata
    import hashlib

    # Mapping fra list-param til filnavn
    region_map = {
        "kbh": "koebenhavn_bemaerk_parsed.csv",
        "nsjl": "nordsjaelland_bemaerk_parsed.csv",
        "vsjl": "vestsjaelland_bemaerk_parsed.csv",
        "ss": "storstroem_bemaerk_parsed.csv",
        "b": "bornholm_bemaerk_parsed.csv",
        "f": "fyn_bemaerk_parsed.csv",
        "sdrj": "soenderjylland_bemaerk_parsed.csv",
        "soej": "sydoestjylland_bemaerk_parsed.csv",
        "svj": "sydvestjylland_bemaerk_parsed.csv",
        "vj": "vestjylland_bemaerk_parsed.csv",
        "oej": "oestjylland_bemaerk_parsed.csv",
        "nvj": "nordvestjylland_bemaerk_parsed.csv",
        "nj": "nordjylland_bemaerk_parsed.csv",
    }

    base_url = "https://dofbasen.dk/opslag/bemaerk.php?list={}"
    results = {}
    changed_any = False

    # Regex: <tr><td>ART</td><td align="right">KOL2</td>
    row_re = re.compile(
        r"""
        <tr>\s*
           <td>\s*(?:<span[^>]*>)?        # evt. <span ...>
               (?P<art>[^<]+?)            # artsnavn (tekst)
           (?:</span>)?\s*</td>\s*
           <td[^>]*\balign=["']right["'][^>]*>\s*
               (?P<col2>[0-9][0-9\ \.,]*) # kolonne 2: tal med evt. separators
           \s*</td>
        """,
        re.IGNORECASE | re.DOTALL | re.VERBOSE,
    )

    def clean_text(s: str) -> str:
        """Hård normalisering: unescape, Unicode NFKC, NBSP->space, kollaps whitespace."""
        if s is None:
            return ""
        s = html.unescape(s)
        s = unicodedata.normalize("NFKC", s)
        s = s.replace("\u00A0", " ")          # NBSP -> normal space
        s = re.sub(r"[ \t\r\f\v]+", " ", s)   # kollaps horisontal whitespace
        return s.strip()

    def normalize_number(s: str) -> str:
        """Fjern tusind-separatorer/mellemrum -> behold kun cifre."""
        return re.sub(r"[^\d]", "", s or "")

    def normalize_for_diff(s: str) -> str:
        """Diff-normalisering af hele filindholdet."""
        if s is None:
            return ""
        s = s.lstrip("\ufeff")                # fjern BOM
        s = s.replace("\r\n", "\n")           # CRLF -> LF
        s = s.replace("\r", "\n")             # ensret CR -> LF
        s = unicodedata.normalize("NFKC", s)
        s = s.replace("\u00A0", " ")          # NBSP -> space

        # Trim trailing spaces pr. linje
        s = "\n".join(line.rstrip(" \t") for line in s.split("\n"))
        # Fjern afsluttende blanke linjer
        s = s.rstrip("\n")
        return s

    def hash_str(s: str) -> str:
        return hashlib.md5(s.encode("utf-8")).hexdigest()

    for region, filename in region_map.items():
        url = base_url.format(region)
        region_result = {
            "file": filename,
            "rows_total": 0,
            "numeric_rows": 0,
            "changed": False,
            "error": None,
            "reason": None,
        }
        try:
            # Hent HTML
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (DOF.not server; fetch-bemaerk-csv)",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                },
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                charset = resp.headers.get_content_charset() or "windows-1252"
                html_text = resp.read().decode(charset, errors="replace")

            # Parse rækker
            all_rows = []
            numeric_rows = []
            for m in row_re.finditer(html_text):
                art_raw = m.group("art")
                col2_raw = m.group("col2")
                art = clean_text(art_raw)
                col2_clean = clean_text(col2_raw)
                num = normalize_number(col2_clean)

                all_rows.append((art, col2_clean))
                if num.isdigit():
                    numeric_rows.append((art, num))

            region_result["rows_total"] = len(all_rows)
            region_result["numeric_rows"] = len(numeric_rows)

            # Ingen numeriske rækker? Skriv ikke.
            if not numeric_rows:
                region_result["reason"] = "no-numeric-second-column"
                results[region] = region_result
                continue

            # Gør output deterministisk: sortér rækker
            numeric_rows.sort(key=lambda x: (x[0].casefold(), int(x[1])))

            # Byg CSV
            lines = ["artsnavn;bemaerk_antal"]
            for art, num in numeric_rows:
                lines.append(f"{art};{num}")
            csv_content = "\n".join(lines) + "\n"

            # Sammenlign med eksisterende fil
            csv_path = os.path.join(os.path.dirname(__file__), "..", "data", filename)
            old_content = ""
            if os.path.exists(csv_path):
                with open(csv_path, "r", encoding="utf-8", newline="") as f:
                    old_content = f.read()

            old_norm = normalize_for_diff(old_content)
            new_norm = normalize_for_diff(csv_content)
            changed = (new_norm != old_norm)
            region_result["changed"] = changed

            # (Valgfrit) medtag hashes i results for nem fejlsøgning
            if changed:
                region_result["old_md5"] = hash_str(old_norm)
                region_result["new_md5"] = hash_str(new_norm)

                # Skriv deterministisk: UTF-8 uden BOM og LF
                with open(csv_path, "w", encoding="utf-8", newline="\n") as f:
                    f.write(csv_content)
                changed_any = True
            else:
                region_result["old_md5"] = hash_str(old_norm)
                region_result["new_md5"] = region_result["old_md5"]

            results[region] = region_result

        except Exception as e:
            region_result["error"] = str(e)
            results[region] = region_result
            # fortsæt til næste region

    # Kør update_version.py small hvis noget ændret
    if changed_any:
        try:
            subprocess.run(
                [
                    "python",
                    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "update_version.py")),
                    "small",
                ],
                check=True,
                cwd=os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
            )
        except Exception as e:
            return {"ok": True, "results": results, "update_version_error": str(e)}

    return {"ok": True, "results": results}

@app.get("/api/lok_koordinater")
async def lok_koordinater(loknr: str):
    """
    Henter koordinater for en lokalitet fra dofbasen.dk/poplok.php?loknr=...
    Returnerer laengde og bredde (float) eller fejl.
    """
    import urllib.request
    import re

    url = f"https://dofbasen.dk/poplok.php?loknr={loknr}"
    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (DOF.not server)",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            html_text = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        return {"ok": False, "error": f"Kunne ikke hente HTML: {e}"}

    m_lon = re.search(r'<span id="lok_center_lon">([0-9\.\-]+)</span>', html_text)
    m_lat = re.search(r'<span id="lok_center_lat">([0-9\.\-]+)</span>', html_text)
    if not m_lon or not m_lat:
        return {"ok": False, "error": "Koordinater ikke fundet"}

    try:
        laengde = float(m_lon.group(1))
        bredde = float(m_lat.group(1))
    except Exception as e:
        return {"ok": False, "error": f"Ugyldige koordinater: {e}"}

    return {"ok": True, "laengde": laengde, "bredde": bredde}

@app.api_route("/api/admin/fetch-arter-csv", methods=["GET", "POST"])
async def fetch_arter_csv(request: Request):
    url = "https://statistik.dofbasen.dk/arter?aar=&slutAar=&startAar=&afdeling=&kommune=&lokalitet=&obser=&visArter=ja&_visArter=on&visHybrider=ja&_visHybrider=on&visUbestemte=ja&_visUbestemte=on&_visAndre=on"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (DOF.not server)",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        html_text = resp.read().decode("utf-8", errors="replace")

    # Find tabel med arter (id="table")
    m_table = re.search(r'<table[^>]*id=["\']table["\'][^>]*>(.*?)</table>', html_text, re.DOTALL | re.IGNORECASE)
    if not m_table:
        raise HTTPException(status_code=500, detail="Kunne ikke finde tabel i HTML")
    table_html = m_table.group(1)

    # Find alle rækker (skip header)
    rows = re.findall(r'<tr[^>]*>(.*?)</tr>', table_html, re.DOTALL | re.IGNORECASE)[1:]
    data_rows = []
    for row_html in rows:
        tds = re.findall(r'<td([^>]*)>(.*?)</td>', row_html, re.DOTALL | re.IGNORECASE)
        if len(tds) < 3:
            continue
        artsid = html.unescape(re.sub(r'<[^>]+>', '', tds[0][1])).strip().lstrip("0") or "0"
        td1_class = tds[1][0]
        artnavn = html.unescape(re.sub(r'<[^>]+>', '', tds[1][1])).strip()
        m_class = re.search(r'class=["\']([^"\']+)["\']', td1_class)
        kategori = ""
        if m_class:
            for cls in m_class.group(1).split():
                if cls in ("su", "subart", "hybrid_sp"):
                    kategori = cls
        # Map kategori til ønsket output
        if kategori == "su":
            kategori_out = "SU"
        elif kategori == "subart":
            kategori_out = "SUB"
        else:
            kategori_out = "Alm"
        data_rows.append([artsid, artnavn, kategori_out])

    # Byg nyt CSV-indhold som tekst
    csv_header = "artsid;artsnavn;klassifikation\n"
    csv_content = csv_header + "\n".join(";".join(row) for row in data_rows) + "\n"

    # Sammenlign med eksisterende fil (data/arter_filter_klassificeret.csv)
    csv_path = os.path.join(os.path.dirname(__file__), "..", "data", "arter_filter_klassificeret.csv")
    old_content = ""
    if os.path.exists(csv_path):
        with open(csv_path, "r", encoding="utf-8") as f:
            old_content = f.read()
    changed = (csv_content != old_content)

    # Skriv til CSV begge steder hvis ændret
    csv_paths = [
        os.path.join(os.path.dirname(__file__), "..", "data", "arter_filter_klassificeret.csv"),
        os.path.join(os.path.dirname(__file__), "..", "web", "data", "arter_filter_klassificeret.csv"),
    ]
    if changed:
        for path in csv_paths:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(csv_content)
        # Kør update_version.py small i roden hvis ændret
        try:
            subprocess.run(
                ["python", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "update_version.py")), "small"],
                check=True,
                cwd=os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
            )
        except Exception as e:
            return {"ok": True, "rows": len(data_rows), "changed": changed, "update_version_error": str(e)}
    return {"ok": True, "rows": len(data_rows), "changed": changed}

@app.get("/api/obs/full")
async def api_obs_full(obsid: str = Query(..., min_length=3, description="DOFbasen observation id")):
    """
    Returnerer DKU-status, billeder og lydklip for observationen.
    """
    url = f"https://dofbasen.dk/popobs.php?obsid={obsid}&summering=tur&obs=obs"
    try:
        html_page = _fetch_html(url, timeout=10.0)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Kunne ikke hente kilde: {e}")

    # DKU-status
    m = re.search(r'<acronym[^>]*class=["\']behandl["\'][^>]*title=["\']([^"\']+)["\']', html_page, re.IGNORECASE)
    status = m.group(1) if m else ""

    # Billeder
    images = _extract_service_image_urls(html_page)

    # Lydklip
    matches = re.findall(r"""<a[^>]+href=['"]([^'"]*sound_proxy\.php[^'"]+)['"]""", html_page, re.IGNORECASE)
    sound_urls = []
    for href in matches:
        href = html.unescape(href)
        if href.startswith("/"):
            sound_url = "https://dofbasen.dk" + href
        else:
            sound_url = href
        sound_urls.append(sound_url)

    return {
        "obsid": obsid,
        "status": status,
        "images": images,
        "sound_urls": sound_urls
    }

@app.post("/api/thread/{day}/{thread_id}/subscribe")
async def subscribe_thread(day: str, thread_id: str, request: Request):
    data = await request.json()
    user_id = data.get("user_id")
    device_id = data.get("device_id")
    if not user_id or not device_id:
        raise HTTPException(status_code=400, detail="user_id og device_id kræves")
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "INSERT OR IGNORE INTO thread_subs (day, thread_id, user_id, device_id) VALUES (?, ?, ?, ?)",
            (day, thread_id, user_id, device_id)
        )
    return {"ok": True}

@app.post("/api/thread/{day}/{thread_id}/unsubscribe")
async def unsubscribe_thread(day: str, thread_id: str, request: Request):
    data = await request.json()
    user_id = data.get("user_id")
    device_id = data.get("device_id")
    if not user_id or not device_id:
        raise HTTPException(status_code=400, detail="user_id og device_id kræves")
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
                "DELETE FROM thread_subs WHERE day=? AND thread_id=? AND user_id=? AND device_id=?",
                (day, thread_id, user_id, device_id)
        )
        conn.execute(
            "INSERT OR IGNORE INTO thread_unsubs (day, thread_id, user_id, device_id) VALUES (?, ?, ?, ?)",
            (day, thread_id, user_id, device_id)
        )
    return {"ok": True}

@app.post("/api/thread/{day}/{thread_id}/subscription")
async def get_subscription_post(day: str, thread_id: str, data: dict = Body(...)):
    user_id = data.get("user_id")
    device_id = data.get("device_id")
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT 1 FROM thread_subs WHERE day=? AND thread_id=? AND user_id=? AND device_id=?",
            (day, thread_id, user_id, device_id)
        ).fetchone()
    return {"subscribed": bool(row)}

@app.post("/api/update")
async def update_data(request: Request):
    payload = await request.json()
    _save_payload(payload)
    tasks = []

    def push_task(sub, push_payload, user_id, device_id):
        try:
            webpush(
                subscription_info=sub,
                data=json.dumps(push_payload),
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={"sub": "mailto:kontakt@dofnot.dk"},
                ttl=3600,
                headers={"Urgency": "high"}
            )
        except WebPushException as ex:
            should_delete = False
            status = None
            if hasattr(ex, "response") and ex.response:
                status = getattr(ex.response, "status_code", None)
                if status is None:
                    status = getattr(ex.response, "status", None)
                print(f"[DEBUG] WebPushException status={status}, body={getattr(ex.response, 'content', '')}")
            if status == 410:
                should_delete = True
            elif "unsubscribed" in str(ex).lower() or "expired" in str(ex).lower():
                should_delete = True
            if should_delete:
                print(f"Sletter abonnement for {user_id}/{device_id} pga. push-fejl: {ex}")
                with sqlite3.connect(DB_PATH) as conn2:
                    conn2.execute(
                        "DELETE FROM subscriptions WHERE user_id=? AND device_id=?",
                        (user_id, device_id)
                    )
                    conn2.execute(
                        "DELETE FROM thread_subs WHERE user_id=? AND device_id=?",
                        (user_id, device_id)
                    )
                    conn2.execute(
                        "DELETE FROM thread_unsubs WHERE user_id=? AND device_id=?",
                        (user_id, device_id)
                    )
                    # Slet user_prefs hvis der ikke er flere subscriptions for user_id
                    remaining = conn2.execute(
                        "SELECT 1 FROM subscriptions WHERE user_id=? LIMIT 1",
                        (user_id,)
                    ).fetchone()
                    if not remaining:
                        conn2.execute(
                            "DELETE FROM user_prefs WHERE user_id=?",
                            (user_id,)
                        )
                    conn2.commit()
            else:
                print(f"Push-fejl til {user_id}/{device_id}: {ex}")

    with ThreadPoolExecutor(max_workers=8) as executor, sqlite3.connect(DB_PATH) as conn:
        for obs in payload:
            afd = obs.get("DOF_afdeling")
            kat = obs.get("kategori")
            statechanged = int(obs.get("statechanged", 0))
            thread_id = obs.get("tag")  # eller obs.get("thread_id")
            day = datetime.strptime(obs.get("Dato"), "%Y-%m-%d").strftime("%d-%m-%Y")
            title = f"{obs.get('Antal','?')} {obs.get('Artnavn','')}, {obs.get('Loknavn','')}"
            body = f"{obs.get('Adfbeskrivelse','')}, {obs.get('Fornavn','')} {obs.get('Efternavn','')}"
            push_payload = {
                "title": title,
                "body": body,
                "url": obs.get("url", "https://dofbasen.dk"),
                "tag": obs.get("tag") or ""
            }

            if statechanged == 1:
                # Send til alle med prefs (uændret)
                rows = conn.execute(
                    "SELECT user_prefs.user_id, subscriptions.device_id, user_prefs.prefs, subscriptions.subscription "
                    "FROM user_prefs JOIN subscriptions ON user_prefs.user_id = subscriptions.user_id"
                ).fetchall()
                for user_id, device_id, prefs_json, sub_json in rows:
                    prefs = json.loads(prefs_json)
                    sub = json.loads(sub_json)
                    species_filters = prefs.get("species_filters") or {"include": [], "exclude": [], "counts": {}}
                    # Find brugerens obserkode
                    user_obserkode = prefs.get("obserkode", "").strip().upper()
                    # Hent obserstate som liste af koder (kan være None)
                    obs_obserstate = obs.get("obserstate") or []
                    if isinstance(obs_obserstate, str):
                        obs_obserstate = [obs_obserstate]
                    obs_obserstate = [k.strip().upper() for k in obs_obserstate if k]
                    # Spring over hvis brugerens obserkode findes i obserstate-listen
                    if user_obserkode and user_obserkode in obs_obserstate:
                        continue
                    if should_notify(prefs, afd, kat) and should_include_obs(obs, species_filters):
                        tasks.append(
                            executor.submit(push_task, sub, push_payload, user_id, device_id)
                        )
            else:
                # Send kun til thread-subscribers, men KUN hvis obs matcher trådens art og lokation
                if not thread_id:
                    continue
                # Hent tråd-info
                thread_path = os.path.join(web_dir, "obs", day, "threads", thread_id, "thread.json")
                if not os.path.isfile(thread_path):
                    continue
                try:
                    with open(thread_path, "r", encoding="utf-8") as f:
                        thread_data = json.load(f)
                    thread_info = thread_data.get("thread", {})
                    thread_art = (thread_info.get("art") or "").strip().lower()
                    thread_lok = (thread_info.get("lok") or "").strip().lower()
                except Exception:
                    continue
                obs_art = (obs.get("Artnavn") or "").strip().lower()
                obs_lok = (obs.get("Loknavn") or "").strip().lower()
                # Kun hvis både art og lokation matcher
                if obs_art != thread_art or obs_lok != thread_lok:
                    continue
                rows = conn.execute(
                    "SELECT user_id, device_id FROM thread_subs WHERE day=? AND thread_id=?",
                    (day, thread_id)
                ).fetchall()
                # --- NY LOGIK: filtrer brugere fra hvis deres obserkode findes i obserstate ---
                obs_obserstate = obs.get("obserstate") or []
                if isinstance(obs_obserstate, str):
                    obs_obserstate = [obs_obserstate]
                obs_obserstate = [k.strip().upper() for k in obs_obserstate if k]
                for user_id, device_id in rows:
                    # Find brugerens obserkode
                    prefs = get_prefs(user_id)
                    user_obserkode = (prefs.get("obserkode") or "").strip().upper()
                    # Hvis obserstate ikke er tom og brugerens obserkode findes i listen, så spring over
                    if obs_obserstate and user_obserkode and user_obserkode in obs_obserstate:
                        continue
                    sub_row = conn.execute(
                        "SELECT subscription FROM subscriptions WHERE user_id=? AND device_id=?",
                        (user_id, device_id)
                    ).fetchone()
                    if not sub_row:
                        continue
                    sub = json.loads(sub_row[0])
                    tasks.append(
                        executor.submit(push_task, sub, push_payload, user_id, device_id)
                    )
        for t in tasks:
            t.result()
    return {"ok": True}

@app.post("/api/users-overview")
async def users_overview(data: dict = Body(...)):
    user_id = data.get("user_id")
    device_id = data.get("device_id")
    # Tjek superadmin
    obserkode = get_obserkode_from_userprefs(user_id)
    superadmins = load_superadmins()
    if obserkode not in superadmins:
        raise HTTPException(status_code=403, detail="Kun hovedadmin")
    users = []
    with sqlite3.connect(DB_PATH) as conn:
        # Find alle user_ids fra både user_prefs og subscriptions
        user_ids = set()
        rows = conn.execute("SELECT user_id FROM user_prefs").fetchall()
        user_ids.update(uid for (uid,) in rows)
        rows = conn.execute("SELECT user_id FROM subscriptions").fetchall()
        user_ids.update(uid for (uid,) in rows)
        for uid in sorted(user_ids):
            # Hent prefs hvis de findes
            cur = conn.execute("SELECT prefs FROM user_prefs WHERE user_id=?", (uid,))
            row = cur.fetchone()
            if row and row[0]:
                try:
                    prefs = json.loads(row[0])
                except Exception:
                    prefs = {}
            else:
                prefs = {}
            lokalafdelinger = {afd: val for afd, val in prefs.items() if val in ("Ingen", "SU", "SUB", "Bemærk")}
            obserkode = prefs.get("obserkode", "")
            species_filters = prefs.get("species_filters", {})
            # Tjek om der er indhold i include, exclude eller counts
            sf_active = 0
            if (
                isinstance(species_filters, dict)
                and (
                    species_filters.get("include")
                    or species_filters.get("exclude")
                    or (species_filters.get("counts") and len(species_filters.get("counts")) > 0)
                )
            ):
                sf_active = 1

            subs = conn.execute("SELECT subscription FROM subscriptions WHERE user_id=?", (uid,)).fetchall()
            subscriptions = [json.loads(s[0]) for s in subs if s and s[0]]
            users.append({
                "user_id": uid,
                "lokalafdelinger": lokalafdelinger,
                "obserkode": obserkode,
                "advanced": sf_active
            })
    return users

@app.post("/api/admin/blacklist")
async def admin_blacklist(data: dict = Body(...)):
    obsid = data.get("obsid")
    user_id = data.get("user_id")
    reason = data.get("reason", "").strip()
    navn = data.get("navn", "").strip()
    body = data.get("body", "").strip()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    prefs = get_prefs(user_id)
    admins = load_admins()
    admin_obserkode = prefs.get("obserkode", "")
    if admin_obserkode not in admins:
        return JSONResponse({"ok": False, "error": "Not admin"}, status_code=403)

    if not obsid:
        try:
            with open("./blacklist.json", "r", encoding="utf-8") as f:
                bl = json.load(f)
            return bl
        except Exception as e:
            print("Blacklist read error:", e)
            return []
    if not reason:
        return {"ok": False, "error": "Årsag til blacklistning mangler"}
    try:
        try:
            with open("./blacklist.json", "r", encoding="utf-8") as f:
                bl = json.load(f)
        except Exception:
            bl = []
        bl = [entry for entry in bl if entry.get("obserkode") != obsid]
        bl.append({
            "obserkode": obsid,
            "navn": navn,
            "reason": reason,
            "body": body,
            "time": now,
            "admin_obserkode": admin_obserkode
        })
        with open("./blacklist.json", "w", encoding="utf-8") as f:
            json.dump(bl, f, ensure_ascii=False, indent=2)
        return {"ok": True}
    except Exception as e:
        print("Blacklist error:", e)
        return {"ok": False, "error": "Server error"}

@app.post("/api/admin/unblacklist")
async def admin_unblacklist(data: dict = Body(...)):
    obsid = data.get("obsid")
    user_id = data.get("user_id")
    if not obsid or not user_id:
        return {"ok": False, "error": "Missing obsid or user_id"}
    # Tjek admin-status
    prefs = get_prefs(user_id)
    admins = load_admins()
    if prefs.get("obserkode") not in admins:
        return {"ok": False, "error": "Not admin"}
    try:
        with open("./blacklist.json", "r", encoding="utf-8") as f:
            bl = json.load(f)
        # Fjern entry med denne obserkode
        bl = [entry for entry in bl if entry.get("obserkode") != obsid]
        with open("./blacklist.json", "w", encoding="utf-8") as f:
            json.dump(bl, f, ensure_ascii=False, indent=2)
        return {"ok": True}
    except Exception as e:
        print("Unblacklist error:", e)
        return {"ok": False, "error": "Server error"}
    
@app.post("/api/admin/remove-comment")
async def admin_remove_comment(data: dict = Body(...)):
    user_id = data.get("user_id")
    device_id = data.get("device_id")
    ts = data.get("ts")
    admin_user_id = data.get("admin_user_id")
    thread_id = data.get("thread_id")
    day = data.get("day")
    if not user_id or not device_id or not ts or not admin_user_id or not thread_id or not day:
        return {"ok": False, "error": "Missing data"}
    prefs = get_prefs(admin_user_id)
    admins = load_admins()
    if prefs.get("obserkode") not in admins:
        return {"ok": False, "error": "Not admin"}
    try:
        base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "web", "obs"))
        kommentar_path = os.path.join(base_dir, day, "threads", thread_id, "kommentar.json")
        if not os.path.exists(kommentar_path):
            return {"ok": False, "error": "File not found"}
        with open(kommentar_path, "r", encoding="utf-8") as f:
            comments = json.load(f)
        comments = [
            c for c in comments
            if not (
                c.get("user_id") == user_id and
                c.get("device_id") == device_id and
                c.get("ts") == ts
            )
        ]
        with open(kommentar_path, "w", encoding="utf-8") as f:
            json.dump(comments, f, ensure_ascii=False, indent=2)
        return {"ok": True}
    except Exception as e:
        print("Remove comment error:", e)
        return {"ok": False, "error": "Server error"}

@app.get("/api/threads/{day}")
async def api_threads_index(day: str):
    """
    Returner index.json for en given dag, inkl. comment_count for hver tråd.
    Understøtter både array og objekt med "threads".
    """
    index_path = os.path.join(web_dir, "obs", day, "index.json")
    threads_dir = os.path.join(web_dir, "obs", day, "threads")
    if not os.path.isfile(index_path):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    with open(index_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Hvis data er en liste, brug den direkte
    if isinstance(data, list):
        threads = data
        out = threads
    # Hvis data er et objekt med "threads", brug det
    elif isinstance(data, dict) and "threads" in data:
        threads = data["threads"]
        out = data
    else:
        return JSONResponse({"detail": "Ugyldigt index-format"}, status_code=500)

    # Tilføj comment_count til hver tråd
    for thread in threads:
        thread_id = thread.get("thread_id")
        if not thread_id:
            thread["comment_count"] = 0
            continue
        thread_dir = os.path.join(threads_dir, thread_id)
        comments_path = os.path.join(thread_dir, "kommentar.json")
        comment_count = 0
        if os.path.isfile(comments_path):
            try:
                with open(comments_path, "r", encoding="utf-8") as f2:
                    comments = json.load(f2)
                comment_count = len(comments)
            except Exception:
                comment_count = 0
        thread["comment_count"] = comment_count

    return JSONResponse(out)

@app.get("/share/obsid/{obsid}/", response_class=HTMLResponse)
async def share_obsid(obsid: str, user_agent: str = Header(None)):
    import html
    from fastapi.testclient import TestClient

    # Brug TestClient til at kalde /api/dofbasen internt
    client = TestClient(app)
    resp = client.get(f"/api/dofbasen?obsid={obsid}")
    if resp.status_code != 200:
        print(f"[DEBUG] /api/dofbasen fejl: {resp.text}")
        return HTMLResponse("<h1>Observation ikke fundet</h1>", status_code=404)
    data = resp.json()

    antal = (data.get("antal") or "").strip()
    art = (data.get("art") or "").strip()
    lok = (data.get("loknavn") or "").strip()
    og_title = f"{antal} {art} - {lok}".strip(" -")

    og_image = "https://notifikation.dofbasen.dk/icons/icon-2048.png"
    og_image_width = "2048"
    og_image_height = "2048"
    og_image_type = "image/png" if og_image.endswith(".png") else "image/jpeg"
    og_desc = f"Se observationen af {antal} {art or 'en fugl'} ved {lok or 'ukendt lokalitet'} i DOFbasen Notifikationer."
    url = f"https://notifikation.dofbasen.dk/obsid.html?obsid={obsid}"
    canonical = f'<link rel="canonical" href="{html.escape(url)}">'

    crawler_agents = [
        "facebookexternalhit", "facebookcatalog", "meta-webindexer",
        "meta-externalads", "meta-externalagent", "meta-externalfetcher", "bsky"
    ]
    is_crawler = user_agent and any(a in user_agent.lower() for a in crawler_agents)

    # Kun redirect for almindelige brugere, ikke crawlers
    meta_refresh = ""
    if user_agent and not is_crawler:
        obsid_url = f"https://notifikation.dofbasen.dk/obsid.html?obsid={obsid}&from_share=1"
        meta_refresh = f'<meta http-equiv="refresh" content="0; url={html.escape(obsid_url)}">'

    html_out = f"""<!DOCTYPE html>
    <html lang="da">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <title>{html.escape(og_title)}</title>
    <meta property="og:url" content="{html.escape(url)}"> 
    <meta property="og:type" content="article">
    <meta property="og:title" content="{html.escape(og_title)}">
    <meta property="og:description" content="{html.escape(og_desc)}">
    <meta property="og:site_name" content="DOFbasen Notifikationer">
    <meta property="og:image" content="{html.escape(og_image)}">
    <meta property="og:image:type" content="{og_image_type}">
    <meta property="og:image:width" content="{og_image_width}">
    <meta property="og:image:height" content="{og_image_height}">
    <meta property="og:locale" content="da_DK">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="{html.escape(og_title)}">
    <meta name="twitter:description" content="{html.escape(og_desc)}">
    <meta name="twitter:image" content="{html.escape(og_image)}">
    <meta name="twitter:image:alt" content="{html.escape(og_title)}">
    {canonical}
    {meta_refresh}
    </head>
    <body>
    <p>Omdirigerer til <a href="https://notifikation.dofbasen.dk/obsid.html?obsid={obsid}">https://notifikation.dofbasen.dk/obsid.html?obsid={obsid}</a>...</p>
    </body>
    </html>
    """
    print(f"[DEBUG] share_obsid: returnerer HTML ({len(html_out)} bytes)")
    return HTMLResponse(content=html_out, status_code=200)
    
@app.get("/api/dofbasen")
async def dofbasen_tur(obsid: str = Query(...)):
    import urllib.request
    import html
    import re

    url = f"https://dofbasen.dk/popobs.php?obsid={obsid}&summering=tur&obs=obs"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (DOF.not server)",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        raw = resp.read()
        html_text = raw.decode("ISO-8859-1", errors="replace")

    def clean(val):
        return html.unescape(re.sub(r'<[^>]+>', '', val)).strip()

    # DKU-status
    m = re.search(r'<acronym[^>]*class=["\']behandl["\'][^>]*title=["\']([^"\']+)["\']', html_text, re.IGNORECASE)
    status = m.group(1) if m else ""

    # Billeder
    images = _extract_service_image_urls(html_text)

    # Lydklip
    matches = re.findall(r"""<a[^>]+href=['"]([^'"]*sound_proxy\.php[^'"]+)['"]""", html_text, re.IGNORECASE)
    sound_urls = []
    for href in matches:
        href = html.unescape(href)
        if href.startswith("/"):
            sound_url = "https://dofbasen.dk" + href
        else:
            sound_url = href
        sound_urls.append(sound_url)

    # Art (dansk og latin) - også SU
    art_match = re.search(r'<font class="(?:subart|defaultart|su)">([^<]+)</font>(?:\s*\(SU\))?\s*\(<i>([^<]+)</i>\)', html_text)
    art_dansk = art_match.group(1) if art_match else None
    art_latin = art_match.group(2) if art_match else None

    # Antal (første <td valign="top"> efter art)
    antal = None
    if art_match:
        end = art_match.end()
        m_antal = re.search(r'<td[^>]*valign="top"[^>]*>(\d+)</td>', html_text[end:])
        if m_antal:
            antal = m_antal.group(1)

    # Adfærd
    adfaerd_match = re.search(r'Adfærd</acronym>:</td><td[^>]*>([^<]+)</td>', html_text)
    adfaerd = adfaerd_match.group(1) if adfaerd_match else None

    # Tid (obstid)
    tid_match = re.search(r'Tid</acronym>:</td><td[^>]*>([^<]+)</td>', html_text)
    obstid = tid_match.group(1) if tid_match else None

    # Kommentar til tur
    tur_note_match = re.search(
        r'Kommentar til tur</acronym>:</td[^>]*><td[^>]*>(.*?)</td>',
        html_text, re.DOTALL | re.IGNORECASE
    )
    kommentar_til_tur = None
    if tur_note_match:
        raw = tur_note_match.group(1)
        kommentar_til_tur = html.unescape(re.sub(r'<[^>]+>', '', raw)).strip()

    # Kommentar til obs.
    obsnote_match = re.search(r'Kommentar til obs\.</acronym>:</td><td[^>]*>([^<]+)</td>', html_text)
    obsnote = obsnote_match.group(1) if obsnote_match else None

    # Lokalitet, loknr, loknavn, turtid (turtid valgfri)
    lok_match = re.search(
        r"loknr=(\d+)[^>]+title=\"Information om ([^\"]+)\">([^<]+)</a>(?:\s*&nbsp;\(([\d: \-]+)\))?",
        html_text
    )
    loknr = lok_match.group(1) if lok_match else None
    loknavn = lok_match.group(3) if lok_match else None
    loklink = f"https://dofbasen.dk/poplok.php?loknr={loknr}" if loknr else None
    turtid = lok_match.group(4) if lok_match and lok_match.lastindex >= 4 else None

    # Koordinater
    koord_match = re.search(r'lng=([0-9.]+)&lat=([0-9.]+)', html_text)
    lng = koord_match.group(1) if koord_match else None
    lat = koord_match.group(2) if koord_match else None
    koordinater = {"lng": float(lng), "lat": float(lat)} if lng and lat else None

    # Observatør
    obs_match = re.search(r'Observatør</acronym>:</td><td[^>]*>.*?title="([^"]+)">([^<]+)</a>', html_text)
    observatoer = obs_match.group(2) if obs_match else None

    # Observatør (obserkode og obserlink)
    obs_match = re.search(
        r"href=['\"]javascript:openwin\('(/popobser\.php\?obserkode=([A-Z0-9]+)[^']*)'",
        html_text
    )
    obs_match = re.search(
        r"openwin\('(/popobser\.php\?obserkode=([A-Z0-9]+)[^']*)'",
        html_text
    )
    obserlink = None
    obserkode = None
    if obs_match:
        obserlink = "https://dofbasen.dk" + obs_match.group(1)
        obserkode = obs_match.group(2)

    # Medobservatør
    medobs_match = re.search(r'Medobservatør</acronym>:</td><td[^>]*>([^<]+)</td>', html_text)
    medobservatoer = medobs_match.group(1) if medobs_match else None

    # Indtastet
    indtastet_match = re.search(r'Indtastet</acronym>:</td><td[^>]*>([^<]+)', html_text)
    indtastet = indtastet_match.group(1).strip() if indtastet_match else None

    # Find dato i header
    m = re.search(r'DATA FOR OBSERVATION NR\. \d+ - (\d{2}/\d{2}/\d{4})', html_text)
    dato = m.group(1) if m else None

    result = {
        "dato": dato,
        "art": art_dansk,
        "latin": art_latin,
        "antal": antal,
        "adfaerd": adfaerd,
        "obstid": obstid,
        "loknr": loknr,
        "loknavn": loknavn,
        "loklink": loklink,
        "turtid": turtid,
        "turnote": kommentar_til_tur,
        "obsnote": obsnote,
        "obstid_param": obsid,
        "naal": koordinater,
        "navn": observatoer,
        "obserkode": obserkode,
        "obserlink": obserlink,
        "medobservatør": medobservatoer,
        "indtastet": indtastet,
        "status": status,
        "images": images,
        "sound_urls": sound_urls
    }

    return JSONResponse(result)


# In-memory rate limiting: user_id -> [timestamps]
login_attempts = defaultdict(list)

@app.post("/api/validate-login")
async def validate_login(data: dict = Body(...)):
    import requests

    user_id = data.get("user_id")
    device_id = data.get("device_id")
    obserkode = data.get("obserkode")
    adgangskode = data.get("adgangskode")

    # --- RATE LIMITING: max 5 forsøg pr. 10 min pr. user_id ---
    now = time.time()
    attempts = login_attempts[user_id]
    # Fjern forsøg ældre end 10 min (600 sek)
    attempts = [t for t in attempts if now - t < 600]
    if len(attempts) >= 5:
        return {"ok": False, "error": "For mange loginforsøg. Prøv igen om 10 minutter."}
    attempts.append(now)
    login_attempts[user_id] = attempts
    # ---------------------------------------------------------

    # Send til DOFbasen API
    url = "https://krydslister.dofbasen.dk/api/v1/login"
    payload = { "username": obserkode, "password": adgangskode }
    try:
        r = requests.post(url, json=payload, timeout=10)
        if r.status_code != 200:
            return { "ok": False, "error": "Login fejlede" }
        token = r.json().get("token")
        if not token:
            return { "ok": False, "error": "Token mangler" }
    except Exception as e:
        return { "ok": False, "error": str(e) }

    # Hent navn fra DOFbasen (valgfrit, hvis du vil vise det)
    navn = ""
    try:
        navn_res = requests.get(f"https://dofbasen.dk/popobser.php?obserkode={obserkode}", timeout=10)
        if navn_res.status_code == 200:
            html = navn_res.text
            idx = html.find("Navn</acronym>:</td><td valign=\"top\">")
            if idx != -1:
                start = idx + len("Navn</acronym>:</td><td valign=\"top\">")
                end = html.find("</td>", start)
                if end != -1:
                    navn = html[start:end].strip()
    except Exception:
        navn = ""

    # Gem obserkode og navn i prefs (adgangskode gemmes IKKE)
    prefs = get_prefs(user_id)
    prefs["obserkode"] = obserkode
    prefs["navn"] = navn
    set_prefs(user_id, prefs)

    return { "ok": True, "token": token, "navn": navn }

@app.post("/api/remove-connection")
async def remove_connection(data: dict = Body(...)):
    user_id = data.get("user_id")
    if not user_id:
        return {"ok": False, "error": "user_id mangler"}
    prefs = get_prefs(user_id)
    prefs.pop("obserkode", None)
    prefs.pop("navn", None)
    set_prefs(user_id, prefs)
    return {"ok": True}

def load_admins():
    try:
        with open("./admin.json", "r", encoding="utf-8") as f:
            data = json.load(f)
            return set(data.get("admins", []))
    except Exception:
        return set()

def get_obserkode_from_userprefs(user_id):
    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute("SELECT prefs FROM user_prefs WHERE user_id=?", (user_id,))
        row = cur.fetchone()
        if row:
            try:
                prefs = json.loads(row[0])
                return prefs.get("obserkode", "")
            except Exception:
                return ""
    return ""

@app.post("/api/request_sync")
async def api_request_sync(request: Request):
    data = await request.json()
    user_id = data.get("user_id")
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id mangler")

    obserkode = get_obserkode_from_userprefs(user_id)
    superadmins = load_superadmins()
    if obserkode not in superadmins:
        raise HTTPException(status_code=403, detail="Kun hovedadmin")

    # Skriv sync-request (overskriver evt. eksisterende)
    with open(SYNC_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f)
    return {"status": "ok", "written": data}

@app.post("/api/is-app-user")
async def api_is_app_user(data: dict = Body(...)):
    obserkode = (data.get("obserkode") or "").strip().upper()
    if not obserkode:
        return {"is_app_user": False}
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute("SELECT prefs FROM user_prefs").fetchall()
    for (prefs_json,) in rows:
        try:
            prefs = json.loads(prefs_json)
            kode = (prefs.get("obserkode") or "").strip().upper()
            if kode == obserkode:
                return {"is_app_user": True}
        except Exception:
            continue
    return {"is_app_user": False}

@app.get("/api/admin/traffic-diffs")
async def traffic_diffs_public():
    import datetime
    import pytz
    import os
    import json
    import collections
    import sqlite3

    masterlog_path = os.path.join(os.path.dirname(__file__), "pageview_masterlog.jsonl")
    log_path = os.path.join(os.path.dirname(__file__), "pageviews.log")

    def parse_date(s):
        try:
            return datetime.datetime.strptime(s, "%Y-%m-%d").date()
        except Exception:
            return None

    # Læs alle linjer og byg dict med dato -> sidste obj (fra masterlog)
    days_dict = {}
    if os.path.isfile(masterlog_path):
        with open(masterlog_path, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    obj = json.loads(line)
                    d = parse_date(obj.get("date", ""))
                    if d:
                        days_dict[d] = obj  # overskriv, så sidste vinder
                except Exception:
                    continue

    # Beregn dagens statistik fra pageviews.log (samme logik som archive_and_reset_pageview_log)
    tz = pytz.timezone("Europe/Copenhagen")
    today = datetime.datetime.now(tz).strftime("%Y-%m-%d")
    today_date = datetime.datetime.strptime(today, "%Y-%m-%d").date()

    def count_comments_and_threads_for_day(day_date):
        comment_count = 0
        su_count = 0
        sub_count = 0
        base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "web", "obs"))
        threads_dir = os.path.join(base_dir, day_date.strftime("%d-%m-%Y"), "threads")
        if os.path.isdir(threads_dir):
            for thread_folder in os.listdir(threads_dir):
                kommentar_path = os.path.join(threads_dir, thread_folder, "kommentar.json")
                if os.path.isfile(kommentar_path):
                    try:
                        with open(kommentar_path, "r", encoding="utf-8") as f:
                            comments = json.load(f)
                        comment_count += len(comments)
                    except Exception:
                        continue
                thread_json_path = os.path.join(threads_dir, thread_folder, "thread.json")
                if os.path.isfile(thread_json_path):
                    try:
                        with open(thread_json_path, "r", encoding="utf-8") as f:
                            thread_data = json.load(f)
                        kategori = (thread_data.get("thread", {}).get("last_kategori") or "").strip().upper()
                        if kategori == "SU":
                            su_count += 1
                        elif kategori == "SUB":
                            sub_count += 1
                    except Exception:
                        continue
        return comment_count, su_count, sub_count

    # For både i dag og i går
    comments_today, su_threads_today, sub_threads_today = count_comments_and_threads_for_day(today_date)
    comments_yesterday, su_threads_yesterday, sub_threads_yesterday = count_comments_and_threads_for_day(today_date - datetime.timedelta(days=1))

    # --- Diffs/statistik ---
    # (kopieret fra din eksisterende kode)
    if os.path.isfile(log_path):
        stats = collections.defaultdict(lambda: {"total": 0, "unique": set()})
        all_users = set()
        total_views = 0
        unique_obserkoder = set()
        with open(log_path, encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) < 4:
                    continue
                ts = parts[0]
                if not ts.startswith(today):
                    continue
                user_id = parts[2]
                all_users.add(user_id)
                total_views += 1
                okode = get_obserkode_from_userprefs(user_id)
                if okode:
                    unique_obserkoder.add(okode)
        stats_out = {
            "date": today,
            "unique_users_total": len(all_users),
            "total_views": total_views,
            "unique_obserkoder": len(unique_obserkoder)
        }
        # Tæl brugere i databasen
        with sqlite3.connect(DB_PATH) as conn:
            rows = conn.execute("SELECT prefs FROM user_prefs").fetchall()
            total_users = 0
            users_with_obserkode = 0
            users_without_obserkode = 0
            all_db_obserkoder = set()
            for (prefs_json,) in rows:
                try:
                    prefs = json.loads(prefs_json)
                    total_users += 1
                    obserkode = prefs.get("obserkode")
                    if obserkode:
                        users_with_obserkode += 1
                        all_db_obserkoder.add(obserkode)
                    else:
                        users_without_obserkode += 1
                except Exception:
                    continue
        stats_out["users_total"] = total_users
        stats_out["users_with_obserkode"] = users_with_obserkode
        stats_out["users_without_obserkode"] = users_without_obserkode
        stats_out["unique_obserkoder_total_db"] = len(all_db_obserkoder)
        days_dict[today_date] = stats_out

    # Sortér efter dato
    days = sorted(days_dict.items(), key=lambda x: x[0])
    # Sidste 365 dage (pr. dag)
    last365 = []
    for d, obj in days[-365:]:
        last365.append({
            "date": d.strftime("%Y-%m-%d"),
            "unique_users_total": obj.get("unique_users_total", 0),
            "users_with_obserkode": obj.get("users_with_obserkode", 0),
            "users_without_obserkode": obj.get("users_without_obserkode", 0),
            "unique_obserkoder": obj.get("unique_obserkoder", 0),
            "unique_obserkoder_total_db": obj.get("unique_obserkoder_total_db", 0),
            "users_total": obj.get("users_total", 0),
            "total_views": obj.get("total_views", 0),
        })

    def pct_diff(now, prev):
        if prev == 0:
            return 100.0 if now > 0 else 0.0
        return ((now - prev) / prev) * 100

    def safe_get(lst, idx, key):
        if -len(lst) <= idx < len(lst):
            return lst[idx].get(key, 0)
        return 0

    stats_keys = [
        ("unique_users_total", "Unikke besøgende"),
        ("unique_obserkoder_total_db", "Unikke obserkoder"),
        ("users_total", "Antal enheder"),
        ("total_views", "Sidevisninger"),
    ]
    diffs = {}

    for key, label in stats_keys:
        today_val = safe_get(last365, -1, key)
        yesterday = safe_get(last365, -2, key)
        week_ago_vals = [safe_get(last365, -i, key) for i in (7, 8, 9)]
        week_ago_vals_nonzero = [v for v in week_ago_vals if v is not None]
        week_ago_avg = sum(week_ago_vals_nonzero) / len(week_ago_vals_nonzero) if week_ago_vals_nonzero else None

        month_ago_vals = [safe_get(last365, -i, key) for i in (30, 31, 32)]
        month_ago_vals_nonzero = [v for v in month_ago_vals if v is not None and v != 0]
        if month_ago_vals_nonzero:
            month_ago_avg = sum(month_ago_vals_nonzero) / len(month_ago_vals_nonzero)
        else:
            month_ago_avg = None

        diff_yesterday = today_val - yesterday if yesterday is not None else None

        diffs[key] = {
            "label": label,
            "today": today_val,
            "diff_yesterday": diff_yesterday,
            "pct_yesterday": pct_diff(today_val, yesterday) if yesterday else None,
            "diff_week": today_val - week_ago_avg if week_ago_avg is not None else None,
            "pct_week": pct_diff(today_val, week_ago_avg) if week_ago_avg else None,
            "diff_month": today_val - month_ago_avg if month_ago_avg is not None else None,
            "pct_month": pct_diff(today_val, month_ago_avg) if month_ago_avg else None,
        }

    return {
        "diffs": diffs,
        "comments_today": comments_today,
        "su_threads_today": su_threads_today,
        "sub_threads_today": sub_threads_today,
        "comments_yesterday": comments_yesterday,
        "su_threads_yesterday": su_threads_yesterday,
        "sub_threads_yesterday": sub_threads_yesterday
    }

@app.post("/api/admin/traffic-graphs")
async def admin_traffic_graphs(data: dict = Body(None)):
    data = data or {}
    user_id = data.get("user_id", "")
    # Kun superadmins må tilgå dette endpoint
    obserkode = get_obserkode_from_userprefs(user_id)
    superadmins = load_superadmins()
    if obserkode not in superadmins:
        raise HTTPException(status_code=403, detail="Kun hovedadmin")
    masterlog_path = os.path.join(os.path.dirname(__file__), "pageview_masterlog.jsonl")
    log_path = os.path.join(os.path.dirname(__file__), "pageviews.log")
    import datetime
    import collections
    import json
    import sqlite3

    def parse_date(s):
        try:
            return datetime.datetime.strptime(s, "%Y-%m-%d").date()
        except Exception:
            return None

    # Læs alle linjer og byg dict med dato -> sidste obj (fra masterlog)
    days_dict = {}
    if os.path.isfile(masterlog_path):
        with open(masterlog_path, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    obj = json.loads(line)
                    d = parse_date(obj.get("date", ""))
                    if d:
                        days_dict[d] = obj  # overskriv, så sidste vinder
                except Exception:
                    continue

    # Beregn dagens statistik fra pageviews.log (samme logik som archive_and_reset_pageview_log)
    today = datetime.datetime.now(pytz.timezone("Europe/Copenhagen")).strftime("%Y-%m-%d")
    today_date = datetime.datetime.strptime(today, "%Y-%m-%d").date()
    if os.path.isfile(log_path):
        stats = collections.defaultdict(lambda: {"total": 0, "unique": set()})
        traad_total = {"total": 0, "unique": set()}
        traad_per_thread = collections.defaultdict(lambda: {"total": 0, "unique": set()})
        all_users = set()
        total_views = 0
        unique_obserkoder = set()
        with open(log_path, encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) < 4:
                    continue
                ts = parts[0]
                if not ts.startswith(today):
                    continue
                user_id = parts[2]
                url = parts[3]
                all_users.add(user_id)
                total_views += 1
                # Find obserkode for user_id
                okode = get_obserkode_from_userprefs(user_id)
                if okode:
                    unique_obserkoder.add(okode)
                m = re.search(r"https?://[^/]+/([^?#]+)", url)
                page = m.group(1) if m else url
                if page.startswith("info.html"):
                    page = "info.html"
                if url in ("https://notifikation.dofbasen.dk/", "https://notifikation.dofbasen.dk/index.html") or page == "index.html":
                    page = "index.html"
                if page.startswith("traad.html"):
                    traad_total["total"] += 1
                    traad_total["unique"].add(user_id)
                    m_id = re.search(r"id=([a-z0-9\-]+)", url)
                    m_date = re.search(r"date=([0-9\-]+)", url)
                    if m_id and m_date:
                        key = f"{m_id.group(1)}-{m_date.group(1)}"
                        traad_per_thread[key]["total"] += 1
                        traad_per_thread[key]["unique"].add(user_id)
                stats[page]["total"] += 1
                stats[page]["unique"].add(user_id)
        stats_out = {
            "date": today,
            "unique_users_total": len(all_users),
            "total_views": total_views,
            "unique_obserkoder": len(unique_obserkoder)
        }
        for page, d in stats.items():
            stats_out[page] = {
                "total": d["total"],
                "unique": len(d["unique"])
            }
        stats_out["traad.html"] = {
            "total": traad_total["total"],
            "unique": len(traad_total["unique"]),
            "threads": {
                k: {"total": v["total"], "unique": len(v["unique"])}
                for k, v in traad_per_thread.items()
            }
        }
        # Tæl brugere i databasen
        with sqlite3.connect(DB_PATH) as conn:
            rows = conn.execute("SELECT prefs FROM user_prefs").fetchall()
            total_users = 0
            users_with_obserkode = 0
            users_without_obserkode = 0
            all_db_obserkoder = set()
            for (prefs_json,) in rows:
                try:
                    prefs = json.loads(prefs_json)
                    total_users += 1
                    obserkode = prefs.get("obserkode")
                    if obserkode:
                        users_with_obserkode += 1
                        all_db_obserkoder.add(obserkode)
                    else:
                        users_without_obserkode += 1
                except Exception:
                    continue
        stats_out["users_total"] = total_users
        stats_out["users_with_obserkode"] = users_with_obserkode
        stats_out["users_without_obserkode"] = users_without_obserkode
        stats_out["unique_obserkoder_total_db"] = len(all_db_obserkoder)
        # Opdater days_dict for i dag
        days_dict[today_date] = stats_out

    # Sortér efter dato
    days = sorted(days_dict.items(), key=lambda x: x[0])

    # Sidste 7 dage (inkl. i dag)
    last7 = []
    for i in range(6, -1, -1):
        d = datetime.datetime.now(pytz.timezone("Europe/Copenhagen")).date() - datetime.timedelta(days=i)
        obj = days_dict.get(d)
        if obj:
            last7.append({
                "date": d.strftime("%Y-%m-%d"),
                "unique_users_total": obj.get("unique_users_total", 0),
                "users_with_obserkode": obj.get("users_with_obserkode", 0),
                "users_without_obserkode": obj.get("users_without_obserkode", 0),
                "unique_obserkoder": obj.get("unique_obserkoder", 0),
                "unique_obserkoder_total_db": obj.get("unique_obserkoder_total_db", 0),
                "users_total": obj.get("users_total", 0),
                "total_views": obj.get("total_views", 0),  # <-- tilføj denne linje
            })
        else:
            last7.append({
                "date": d.strftime("%Y-%m-%d"),
                "unique_users_total": 0,
                "users_with_obserkode": 0,
                "users_without_obserkode": 0,
                "unique_obserkoder": 0,
                "unique_obserkoder_total_db": 0,
                "users_total": 0,
                "total_views": 0,  # <-- tilføj denne linje
            })

    # Sidste 365 dage (pr. dag)
    last365 = []
    for d, obj in days[-365:]:
        last365.append({
            "date": d.strftime("%Y-%m-%d"),
            "unique_users_total": obj.get("unique_users_total", 0),
            "users_with_obserkode": obj.get("users_with_obserkode", 0),
            "users_without_obserkode": obj.get("users_without_obserkode", 0),
            "unique_obserkoder": obj.get("unique_obserkoder", 0),
            "unique_obserkoder_total_db": obj.get("unique_obserkoder_total_db", 0),
            "users_total": obj.get("users_total", 0),
            "total_views": obj.get("total_views", 0),  # <-- tilføj denne linje
        })

    # Uge-totaler for sidste 52 uger
    week_stats = collections.OrderedDict()
    for dt, obj in days:
        year, week, _ = dt.isocalendar()
        key = f"{year}-W{week:02d}"
        if key not in week_stats:
            week_stats[key] = {
                "unique_users_total": 0,
                "users_with_obserkode": 0,
                "users_without_obserkode": 0
            }
        week_stats[key]["unique_users_total"] += obj.get("unique_users_total", 0)
        week_stats[key]["users_with_obserkode"] += obj.get("users_with_obserkode", 0)
        week_stats[key]["users_without_obserkode"] += obj.get("users_without_obserkode", 0)

    week_keys = list(week_stats.keys())[-52:]
    week_data = []
    for k in week_keys:
        v = week_stats[k]
        week_data.append({
            "week": k,
            "unique_users_total": v["unique_users_total"],
            "users_with_obserkode": v["users_with_obserkode"],
            "users_without_obserkode": v["users_without_obserkode"]
        })

    # --- Userplatforms statistik (samme logik som last-user-platforms) ---
    userplatforms = {}
    last_seen = {}
    if os.path.isfile(log_path):
        with open(log_path, encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) < 4:
                    continue
                user_id = parts[2]
                m = re.search(r'OS:\s*([^\s]+)\s+BROWSER:\s*([^\s]+)\s+PWA:\s*([^\s]+)', line)
                if m:
                    os_info = m.group(1)
                    browser = m.group(2)
                    is_pwa = m.group(3)
                    last_seen[user_id] = (os_info, browser, is_pwa)
        combo_counter = collections.Counter()
        pwa_installed = 0
        pwa_not_installed = 0
        for os_info, browser, is_pwa in last_seen.values():
            combo_counter[(os_info, browser)] += 1
            if is_pwa == "True":
                pwa_installed += 1
            else:
                pwa_not_installed += 1
        combos = [
            {"os": os_info, "browser": browser, "count": count}
            for (os_info, browser), count in combo_counter.items()
        ]
        userplatforms = {
            "unique_users": len(last_seen),
            "platform_combinations": combos,
            "pwa_installed": pwa_installed,
            "pwa_not_installed": pwa_not_installed
        }

    # --- NYT: Udregn forskelle ---
    def pct_diff(now, prev):
        if prev == 0:
            return 100.0 if now > 0 else 0.0
        return ((now - prev) / prev) * 100

    def safe_get(lst, idx, key):
        if -len(lst) <= idx < len(lst):
            return lst[idx].get(key, 0)
        return 0

    stats_keys = [
        ("unique_users_total", "Unikke besøgende"),
        ("unique_obserkoder_total_db", "Unikke obserkoder"),
        ("users_total", "Antal enheder"),
        ("total_views", "Sidevisninger"),  # <-- tilføj denne linje
    ]
    diffs = {}

    for key, label in stats_keys:
        today = safe_get(last365, -1, key)
        yesterday = safe_get(last365, -2, key)
        week_ago_vals = [safe_get(last365, -i, key) for i in (7, 8, 9)]
        week_ago_vals_nonzero = [v for v in week_ago_vals if v is not None]
        week_ago_avg = sum(week_ago_vals_nonzero) / len(week_ago_vals_nonzero) if week_ago_vals_nonzero else None

        month_ago_vals = [safe_get(last365, -i, key) for i in (30, 31, 32)]
        month_ago_vals_nonzero = [v for v in month_ago_vals if v is not None and v != 0]
        if month_ago_vals_nonzero:
            month_ago_avg = sum(month_ago_vals_nonzero) / len(month_ago_vals_nonzero)
        else:
            month_ago_avg = None

        # Nu er det bare en simpel differens for alle tre nøgler
        diff_yesterday = today - yesterday if yesterday is not None else None

        diffs[key] = {
            "label": label,
            "today": today,
            "yesterday": yesterday,
            "diff_yesterday": diff_yesterday,
            "pct_yesterday": pct_diff(today, yesterday) if yesterday else None,
            "week_ago_avg": week_ago_avg,
            "diff_week": today - week_ago_avg if week_ago_avg is not None else None,
            "pct_week": pct_diff(today, week_ago_avg) if week_ago_avg else None,
            "month_ago_avg": month_ago_avg,
            "diff_month": today - month_ago_avg if month_ago_avg is not None else None,
            "pct_month": pct_diff(today, month_ago_avg) if month_ago_avg else None,
        }

    return {
        "last7": last7,
        "last365": last365,
        "week_data": week_data,
        "userplatforms": userplatforms,
        "diffs": diffs
    }

@app.post("/api/is-app-user-bulk")
async def api_is_app_user_bulk(data: dict = Body(...)):
    obserkoder = [str(k).strip().upper() for k in data.get("obserkoder", []) if k]
    result = {k: False for k in obserkoder}
    if not obserkoder:
        return result
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute("SELECT prefs FROM user_prefs").fetchall()
    known = set()
    for (prefs_json,) in rows:
        try:
            prefs = json.loads(prefs_json)
            kode = (prefs.get("obserkode") or "").strip().upper()
            if kode:
                known.add(kode)
        except Exception:
            continue
    for k in obserkoder:
        if k in known:
            result[k] = True
    return result

@app.get("/api/admin/all-users")
async def admin_all_users(user_id: str = Query(...)):
    obserkode = get_obserkode_from_userprefs(user_id)
    superadmins = load_superadmins()
    if obserkode not in superadmins:
        raise HTTPException(status_code=403, detail="Kun hovedadmin")
    users = {}
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute("SELECT user_id, prefs FROM user_prefs").fetchall()
        for uid, prefs_json in rows:
            try:
                prefs = json.loads(prefs_json)
                navn = prefs.get("navn", "")
                kode = prefs.get("obserkode", "")
                kode_norm = (kode or "").strip().upper()
                if kode_norm:
                    if kode_norm not in users:
                        users[kode_norm] = {"navn": navn, "obserkode": kode, "antal_oprettede": 1}
                    else:
                        users[kode_norm]["antal_oprettede"] += 1
            except Exception:
                continue
    user_list = list(users.values())
    user_list.sort(key=lambda u: (u["navn"] or u["obserkode"] or "").upper())
    return user_list

@app.post("/api/admin/delete-user")
async def admin_delete_user(data: dict = Body(...)):
    requester_id = data.get("user_id")
    obserkode = (data.get("obserkode") or "").strip().upper()
    target_user_id = data.get("target_user_id") or data.get("delete_user_id") or data.get("delete_userid") or None

    # Tjek om requester er superadmin
    requester_obserkode = get_obserkode_from_userprefs(requester_id)
    superadmins = load_superadmins()
    if requester_obserkode not in superadmins:
        raise HTTPException(status_code=403, detail="Kun hovedadmin kan slette brugere")

    deleted = 0
    with sqlite3.connect(DB_PATH) as conn:
        user_ids = []
        # Hvis obserkode angivet: find alle user_ids med denne obserkode
        if obserkode:
            rows = conn.execute("SELECT user_id, prefs FROM user_prefs").fetchall()
            for uid, prefs_json in rows:
                try:
                    prefs = json.loads(prefs_json)
                    kode = (prefs.get("obserkode") or "").strip().upper()
                    if kode == obserkode:
                        user_ids.append(uid)
                except Exception:
                    continue
        # Hvis user_id angivet og ikke allerede fundet
        elif target_user_id:
            user_ids.append(target_user_id)
        else:
            raise HTTPException(status_code=400, detail="Obserkode eller user_id mangler")

        # Slet fra alle relevante tabeller
        for uid in user_ids:
            conn.execute("DELETE FROM user_prefs WHERE user_id=?", (uid,))
            conn.execute("DELETE FROM subscriptions WHERE user_id=?", (uid,))
            conn.execute("DELETE FROM thread_subs WHERE user_id=?", (uid,))
            conn.execute("DELETE FROM thread_unsubs WHERE user_id=?", (uid,))
            deleted += 1
        conn.commit()
    return {"ok": True, "deleted_users": deleted}

@app.post("/api/is-admin")
async def is_admin(data: dict = Body(...)):
    user_id = data.get("user_id")
    device_id = data.get("device_id")
    admins = load_admins()
    obserkode = get_obserkode_from_userprefs(user_id)
    return {"admin": obserkode in admins, "obserkode": obserkode}

def load_superadmins():
    try:
        with open("./superadmin.json", "r", encoding="utf-8") as f:
            data = json.load(f)
            return set(data.get("superadmins", []))
    except Exception:
        return set()

@app.post("/api/is-subscribed")
async def is_subscribed(data: dict = Body(...)):
    user_id = data.get("user_id")
    device_id = data.get("device_id")
    # Tjek om user_id findes i subscriptions (tilpas evt. logik)
    import sqlite3
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT 1 FROM subscriptions WHERE user_id=? OR device_id=? LIMIT 1",
            (user_id, device_id)
        ).fetchone()
        is_subscribed = bool(row)
    return {"isSubscribed": is_subscribed}

@app.post("/api/is-superadmin")
async def is_superadmin(data: dict = Body(...)):
    user_id = data.get("user_id")
    device_id = data.get("device_id")
    obserkode = get_obserkode_from_userprefs(user_id)
    superadmins = load_superadmins()
    return {
        "superadmin": obserkode in superadmins,
        "obserkode": obserkode
    }

def archive_and_reset_pageview_log(for_date=None, reset_log=True):
    tz = pytz.timezone("Europe/Copenhagen")
    today = datetime.now(tz).strftime("%Y-%m-%d")  # Dagens dato
    if for_date is None:
        for_date = (datetime.now(tz) - timedelta(days=1)).strftime("%Y-%m-%d")  # Gårsdagens dato
    log_path = os.path.join(os.path.dirname(__file__), "pageviews.log")
    masterlog_path = os.path.join(os.path.dirname(__file__), "pageview_masterlog.jsonl")

    stats_out = {}
    stats = defaultdict(lambda: {"total": 0, "unique": set()})
    traad_total = {"total": 0, "unique": set()}
    traad_per_thread = defaultdict(lambda: {"total": 0, "unique": set()})
    all_users = set()
    total_views = 0

    if not os.path.isfile(log_path):
        return

    unique_obserkoder = set()
    kept_lines = []

    with open(log_path, encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split()
            if len(parts) < 4:
                continue
            ts = parts[0]
            # Brug dansk dato
            if ts.startswith(for_date):
                user_id = parts[2]
                url = parts[3]
                all_users.add(user_id)
                total_views += 1
                # Find obserkode for user_id
                obserkode = get_obserkode_from_userprefs(user_id)
                if obserkode:
                    unique_obserkoder.add(obserkode)
                m = re.search(r"https?://[^/]+/([^?]+)", url)
                page = m.group(1) if m else url
                if url in ("https://notifikation.dofbasen.dk/", "https://notifikation.dofbasen.dk/index.html") or page == "index.html":
                    page = "index.html"
                if page.startswith("traad.html"):
                    traad_total["total"] += 1
                    traad_total["unique"].add(user_id)
                    m_id = re.search(r"id=([a-z0-9\-]+)", url)
                    m_date = re.search(r"date=([0-9\-]+)", url)
                    if m_id and m_date:
                        key = f"{m_id.group(1)}-{m_date.group(1)}"
                        traad_per_thread[key]["total"] += 1
                        traad_per_thread[key]["unique"].add(user_id)
                stats[page]["total"] += 1
                stats[page]["unique"].add(user_id)
            else:
                kept_lines.append(line)

    for page, d in stats.items():
        stats_out[page] = {
            "total": d["total"],
            "unique": len(d["unique"])
        }
    stats_out["traad.html"] = {
        "total": traad_total["total"],
        "unique": len(traad_total["unique"]),
        "threads": {
            k: {"total": v["total"], "unique": len(v["unique"])}
            for k, v in traad_per_thread.items()
        }
    }
    stats_out["unique_users_total"] = len(all_users)
    stats_out["total_views"] = total_views
    stats_out["unique_obserkoder"] = len(unique_obserkoder)

    # Tæl brugere i databasen
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute("SELECT prefs FROM user_prefs").fetchall()
        total_users = 0
        users_with_obserkode = 0
        users_without_obserkode = 0
        all_db_obserkoder = set()
        for (prefs_json,) in rows:
            try:
                prefs = json.loads(prefs_json)
                total_users += 1
                obserkode = prefs.get("obserkode")
                if obserkode:
                    users_with_obserkode += 1
                    all_db_obserkoder.add(obserkode)
                else:
                    users_without_obserkode += 1
            except Exception:
                continue
    stats_out["users_total"] = total_users
    stats_out["users_with_obserkode"] = users_with_obserkode
    stats_out["users_without_obserkode"] = users_without_obserkode
    stats_out["unique_obserkoder_total_db"] = len(all_db_obserkoder)

    # Skriv til masterlog
    log_entry = {
        "date": for_date,
        **stats_out,
    }
    with open(masterlog_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")

    # Overskriv pageviews.log med kun de linjer der IKKE matcher for_date
    if reset_log:
        with open(log_path, "w", encoding="utf-8") as f:
            for line in kept_lines:
                f.write(line if line.endswith("\n") else line + "\n")

@app.post("/api/admin/pageview-stats")
async def admin_pageview_stats(data: dict = Body(...)):
    user_id = data.get("user_id")
    device_id = data.get("device_id")
    obserkode = get_obserkode_from_userprefs(user_id)
    superadmins = load_superadmins()
    if obserkode not in superadmins:
        raise HTTPException(status_code=403, detail="Kun hovedadmin")

    today_dk = datetime.now(pytz.timezone("Europe/Copenhagen")).strftime("%Y-%m-%d")
    stats = defaultdict(lambda: {"total": 0, "unique": set()})
    traad_total = {"total": 0, "unique": set()}
    traad_per_thread = defaultdict(lambda: {"total": 0, "unique": set(), "sharelink": 0})
    all_users = set()
    total_views = 0
    unique_obserkoder = set()
    traad_sharelink_total = 0  # Samlet antal traad.html via sharelink

    log_path = os.path.join(os.path.dirname(__file__), "pageviews.log")
    if not os.path.isfile(log_path):
        return {}

    with open(log_path, encoding="utf-8") as f:
        for line in f:
            m_url = re.search(r"https?://[^\s]+", line)
            if not m_url:
                continue
            url = m_url.group(0)
            parts = line.strip().split()
            if len(parts) < 3:
                continue
            ts = parts[0]
            if not ts.startswith(today_dk):
                continue
            user_id = parts[2]
            all_users.add(user_id)
            total_views += 1
            okode = get_obserkode_from_userprefs(user_id)
            if okode:
                unique_obserkoder.add(okode)
            m = re.search(r"https?://[^/]+/([^?]+)", url)
            page = m.group(1) if m else url

            is_sharelink = "SHARELINK: True" in line

            # Både / og /index.html tælles som index.html
            if url in ("https://notifikation.dofbasen.dk/", "https://notifikation.dofbasen.dk/index.html") or page == "index.html":
                page = "index.html"

            if page.startswith("traad.html"):
                traad_total["total"] += 1
                traad_total["unique"].add(user_id)
                m_id = re.search(r"id=([a-z0-9\-]+)", url)
                m_date = re.search(r"date=([0-9\-]+)", url)
                if m_id and m_date:
                    key = f"{m_id.group(1)}-{m_date.group(1)}"
                    traad_per_thread[key]["total"] += 1
                    traad_per_thread[key]["unique"].add(user_id)
                    if is_sharelink:
                        traad_per_thread[key]["sharelink"] += 1
                        traad_sharelink_total += 1
                elif is_sharelink:
                    traad_sharelink_total += 1

            # --- obsid.html sharelink-tælling ---
            if page.startswith("obsid.html"):
                stats["obsid.html"]["total"] += 1
                stats["obsid.html"]["unique"].add(user_id)
                if "obsid=" in url:
                    m_obsid = re.search(r"obsid=([0-9]+)", url)
                    if m_obsid and is_sharelink:
                        stats.setdefault("obsid.html_sharelink", {"total": 0, "unique": set()})
                        stats["obsid.html_sharelink"]["total"] += 1
                        stats["obsid.html_sharelink"]["unique"].add(user_id)
            # Tæl ALLE andre sider også
            stats[page]["total"] += 1
            stats[page]["unique"].add(user_id)

    traad_unique_users = set()
    for v in traad_per_thread.values():
        traad_unique_users.update(v["unique"])

    obsid_stats = stats.get("obsid.html", {"total": 0, "unique": set()})
    obsid_sharelink = stats.get("obsid.html_sharelink", {"total": 0, "unique": set()})

    stats_out = {}

    # Tilføj obsid.html statistik samlet
    stats_out["obsid.html"] = {
        "total": obsid_stats["total"],
        "unique": len(obsid_stats["unique"]),
        "sharelink": obsid_sharelink["total"]
    }

    stats_out["traad.html"] = {
        "total": traad_total["total"],
        "unique": len(traad_unique_users),
        "sharelink": traad_sharelink_total,
        "threads": {
            k: {
                "total": v["total"],
                "unique": len(v["unique"]),
                "sharelink": v["sharelink"]
            }
            for k, v in traad_per_thread.items()
        }
    }

    # Tilføj statistik for alle andre sider (index.html, settings.html, info.html osv.)
    for page, d in stats.items():
        if page in ("obsid.html", "obsid.html_sharelink", "traad.html"):
            continue
        if page.startswith("info.html") and page != "info.html":
            continue  # spring alle info.html#... og info.html?... over
        stats_out[page] = {
            "total": d["total"],
            "unique": len(d["unique"])
        }

    stats_out["unique_users_total"] = len(all_users)
    stats_out["total_views"] = total_views
    return stats_out

@app.post("/api/admin/archive-pageview-log")
async def archive_pageview_log(data: dict = Body(...)):
    user_id = data.get("user_id")
    obserkode = get_obserkode_from_userprefs(user_id)
    superadmins = load_superadmins()
    if obserkode not in superadmins:
        raise HTTPException(status_code=403, detail="Kun hovedadmin")
    tz = pytz.timezone("Europe/Copenhagen")
    today = datetime.now(tz).strftime("%Y-%m-%d")
    archive_and_reset_pageview_log(for_date=today, reset_log=False)
    return {"status": "ok"}

@app.post("/api/admin/list-admins")
async def list_admins(data: dict = Body(...)):
    user_id = data.get("user_id", "")
    obserkode = get_obserkode_from_userprefs(user_id)
    superadmins = load_superadmins()
    if obserkode not in superadmins:
        raise HTTPException(status_code=403, detail="Kun hovedadmin")
    try:
        with open("./admin.json", "r", encoding="utf-8") as f:
            admin_data = json.load(f)
        admin_koder = admin_data.get("admins", [])
        # Hent navn for hver admin fra user_prefs
        admins = []
        with sqlite3.connect(DB_PATH) as conn:
            rows = conn.execute("SELECT prefs FROM user_prefs").fetchall()
            kode_to_navn = {}
            for (prefs_json,) in rows:
                try:
                    prefs = json.loads(prefs_json)
                    kode = (prefs.get("obserkode") or "").strip().upper()
                    navn = prefs.get("navn", "")
                    if kode:
                        kode_to_navn[kode] = navn
                except Exception:
                    continue
        for kode in admin_koder:
            admins.append({
                "obserkode": kode,
                "navn": kode_to_navn.get(kode, "")
            })
        return {"admins": admins}
    except Exception:
        return {"admins": []}

@app.post("/api/admin/add-admin")
async def add_admin(data: dict = Body(...)):
    user_id = data.get("user_id", "")
    new_obserkode = (data.get("obserkode") or "").strip().upper()
    obserkode = get_obserkode_from_userprefs(user_id)
    superadmins = load_superadmins()
    if obserkode not in superadmins:
        raise HTTPException(status_code=403, detail="Kun hovedadmin")
    if not new_obserkode or not re.match(r"^[A-Z0-9]+$", new_obserkode):
        raise HTTPException(status_code=400, detail="Ugyldig obserkode")
    try:
        with open("./admin.json", "r", encoding="utf-8") as f:
            data = json.load(f)
        admins = set(data.get("admins", []))
        admins.add(new_obserkode)
        data["admins"] = sorted(admins)
        with open("./admin.json", "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}

@app.post("/api/admin/remove-admin")
async def remove_admin(data: dict = Body(...)):
    user_id = data.get("user_id", "")
    remove_obserkode = (data.get("obserkode") or "").strip().upper()
    obserkode = get_obserkode_from_userprefs(user_id)
    superadmins = load_superadmins()
    if obserkode not in superadmins:
        raise HTTPException(status_code=403, detail="Kun hovedadmin")
    if not remove_obserkode:
        raise HTTPException(status_code=400, detail="Ugyldig obserkode")
    # Beskyt alle superadmins mod at blive fjernet
    if remove_obserkode in superadmins:
        raise HTTPException(status_code=400, detail="Kan ikke fjerne hovedadmin")
    try:
        with open("./admin.json", "r", encoding="utf-8") as f:
            data = json.load(f)
        protected_admins = set(data.get("protected", []))
        if remove_obserkode in protected_admins:
            raise HTTPException(status_code=400, detail="Kan ikke fjerne beskyttet admin")
        admins = set(data.get("admins", []))
        admins.discard(remove_obserkode)
        data["admins"] = sorted(admins)
        with open("./admin.json", "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def safe_comment(comment):
    return {
        "navn": html.escape(comment.get("navn", "")),
        "obserkode": html.escape(comment.get("obserkode", "")),
        "body": html.escape(comment.get("body", "")),
        "ts": comment.get("ts", ""),
        "thumbs": comment.get("thumbs", 0),
        "thumbs_users": comment.get("thumbs_users", []),
        "user_id": comment.get("user_id", ""),
        "device_id": comment.get("device_id", "")
    }

@app.get("/api/admin/comments")
async def admin_comments():
    today = datetime.now()
    days = [(today - timedelta(days=i)).strftime("%d-%m-%Y") for i in range(2)]
    threads = []

    for day in days:
        threads_dir = os.path.join(BASE_DIR, day, "threads")
        if not os.path.isdir(threads_dir):
            continue
        for thread_folder in os.listdir(threads_dir):
            thread_path = os.path.join(threads_dir, thread_folder)
            kommentar_file = os.path.join(thread_path, "kommentar.json")
            if os.path.isfile(kommentar_file):
                try:
                    with open(kommentar_file, "r", encoding="utf-8") as f:
                        comments = json.load(f)
                    # Escape alle kommentarer server-side
                    safe_comments = [safe_comment(c) for c in comments]
                    threads.append({
                        "art_lokation": thread_folder.replace("-", " "),
                        "day": day,
                        "comments": safe_comments
                    })
                except Exception:
                    continue
    return JSONResponse(threads)

@app.get("/api/thread/{day}/{thread_id}")
async def api_thread(day: str, thread_id: str, request: Request):
    """Returner thread.json for en given dag og tråd-id."""
    thread_path = os.path.join(web_dir, "obs", day, "threads", thread_id, "thread.json")
    if not os.path.isfile(thread_path):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    with open(thread_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return JSONResponse(data)

@app.post("/api/admin/download/{filename}")
async def download_admin_file(filename: str, data: dict = Body(...)):
    user_id = data.get("user_id", "")
    # Tjek superadmin
    obserkode = get_obserkode_from_userprefs(user_id)
    superadmins = load_superadmins()
    if obserkode not in superadmins:
        raise HTTPException(status_code=403, detail="Kun hovedadmin")
    # Brug absolut sti
    base_dir = os.path.dirname(__file__)
    allowed = {
        "pageview_masterlog.jsonl": os.path.join(base_dir, "pageview_masterlog.jsonl"),
        "pageviews.log": os.path.join(base_dir, "pageviews.log")
    }
    if filename not in allowed:
        raise HTTPException(status_code=404, detail="Ikke tilladt")
    if not os.path.isfile(allowed[filename]):
        raise HTTPException(status_code=404, detail="Filen findes ikke")
    return FileResponse(allowed[filename], filename=filename)

@app.middleware("http")
async def log_all_requests(request: Request, call_next):
    response = await call_next(request)
    log_line = f'{request.client.host} - "{request.method} {request.url.path} HTTP/{request.scope.get("http_version", "1.1")}" {response.status_code}'
    logging.info(log_line)
    return response

@app.post("/api/admin/serverlog")
async def get_server_log(data: dict = Body(...)):
    user_id = data.get("user_id", "")
    obserkode = get_obserkode_from_userprefs(user_id)
    superadmins = load_superadmins()
    if obserkode not in superadmins:
        raise HTTPException(status_code=403, detail="Kun hovedadmin")
    log_path = os.path.join(os.path.dirname(__file__), "server.log")
    if not os.path.isfile(log_path):
        return {"log": ""}
    with open(log_path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()[-1000:]
    return {"log": "".join(lines)}

@app.post("/api/userinfo")
async def get_or_save_userinfo(data: dict = Body(...)):
    user_id = data.get("user_id")
    device_id = data.get("device_id")
    # Hvis der er obserkode/navn, så gem, ellers hent
    obserkode = data.get("obserkode")
    navn = data.get("navn")
    prefs = get_prefs(user_id)
    if obserkode is not None or navn is not None:
        if obserkode is not None:
            prefs["obserkode"] = obserkode
        if navn is not None:
            prefs["navn"] = navn
        set_prefs(user_id, prefs)
        return {"ok": True}
    return {
        "user_id": user_id,
        "device_id": device_id,
        "obserkode": prefs.get("obserkode", ""),
        "navn": prefs.get("navn", "")
    }

@app.post("/api/thread/{day}/{thread_id}/comments/thumbsup")
async def thumbs_up_comment(day: str, thread_id: str, request: Request):
    data = await request.json()
    ts = data.get("ts")
    user_id = data.get("user_id")
    if not ts or not user_id:
        raise HTTPException(status_code=400, detail="Kommentar-tidspunkt eller bruger-id mangler")
    thread_dir = os.path.join(web_dir, "obs", day, "threads", thread_id)
    comments_path = os.path.join(thread_dir, "kommentar.json")
    if not os.path.isfile(comments_path):
        raise HTTPException(status_code=404, detail="Ingen kommentarer fundet")
    with open(comments_path, "r", encoding="utf-8") as f:
        comments = json.load(f)
    found = False
    for c in comments:
        if c.get("ts") == ts:
            thumbs_users = set(c.get("thumbs_users", []))
            already_thumbed = user_id in thumbs_users
            if already_thumbed:
                thumbs_users.remove(user_id)  # Fjern thumbs up
            else:
                thumbs_users.add(user_id)     # Tilføj thumbs up
            c["thumbs_users"] = list(thumbs_users)
            c["thumbs"] = len(thumbs_users)
            found = True

            # SEND PUSH HVIS NY THUMBS UP OG IKKE FRA EJEREN SELV
            if not already_thumbed and user_id != c.get("user_id"):
                owner_user_id = c.get("user_id")
                owner_device_id = c.get("device_id")
                if owner_user_id and owner_device_id:
                    # TJEK OM EJEREN ABONNERER PÅ TRÅDEN
                    with sqlite3.connect(DB_PATH) as conn:
                        sub_row = conn.execute(
                            "SELECT 1 FROM thread_subs WHERE day=? AND thread_id=? AND user_id=? AND device_id=?",
                            (day, thread_id, owner_user_id, owner_device_id)
                        ).fetchone()
                    if sub_row:
                        # Find subscription-info
                        with sqlite3.connect(DB_PATH) as conn:
                            row = conn.execute(
                                "SELECT subscription FROM subscriptions WHERE user_id=? AND device_id=?",
                                (owner_user_id, owner_device_id)
                            ).fetchone()
                        if row:
                            sub = json.loads(row[0])
                            # Find artnavn/loknavn til notifikation
                            thread_path = os.path.join(thread_dir, "thread.json")
                            artnavn = ""
                            loknavn = ""
                            if os.path.isfile(thread_path):
                                try:
                                    with open(thread_path, "r", encoding="utf-8") as f:
                                        thread_data = json.load(f)
                                    thread_info = thread_data.get("thread", {})
                                    artnavn = thread_info.get("art", "")
                                    loknavn = thread_info.get("lok", "")
                                except Exception:
                                    pass
                            payload = {
                                "title": f"👍 på dit indlæg: {artnavn} - {loknavn}",
                                "body": f"Dit indlæg har fået en thumbs up!",
                                "url": f"/traad.html?date={day}&id={thread_id}",
                                "tag": f"{thread_id}-thumbsup-{ts.replace(' ', '_').replace(':', '-')}"
                            }
                            try:
                                webpush(
                                    subscription_info=sub,
                                    data=json.dumps(payload, ensure_ascii=False),
                                    vapid_private_key=VAPID_PRIVATE_KEY,
                                    vapid_claims={"sub": "mailto:kontakt@dofnot.dk"},
                                    ttl=3600,
                                    headers={"Urgency": "high"}  # <-- Tilføj urgency high
                                )
                            except Exception as ex:
                                print(f"Push-fejl til {owner_user_id}/{owner_device_id}: {ex}")
            break
    if not found:
        raise HTTPException(status_code=404, detail="Kommentar ikke fundet")
    with open(comments_path, "w", encoding="utf-8") as f:
        json.dump(comments, f, ensure_ascii=False, indent=2)
    return {"ok": True, "thumbs": c["thumbs"]} 

@app.post("/api/prefs/user/species")
async def species_filters(request: Request):
    data = await request.json()
    user_id = data.get("user_id")
    filters = data.get("filters")
    prefs = get_prefs(user_id)
    if filters is not None:
        # Opdater artsfilter
        prefs["species_filters"] = filters
        set_prefs(user_id, prefs)
        return {"ok": True}
    # Returner artsfilter
    return JSONResponse(prefs.get("species_filters") or {"include": [], "exclude": [], "counts": {}})

@app.get("/api/payload")
async def api_payload():
    data = _load_latest_payload()
    if data is None:
        return JSONResponse([])
    return JSONResponse(data)

@app.get("/api/latest")
async def api_latest():
    data = _load_latest_payload()
    latest = _latest_from_data(data) if data is not None else {}
    return JSONResponse(latest)

@app.get("/obs/{day}/threads/{thread_id}")
async def get_thread_short(day: str, thread_id: str):
    thread_path = os.path.join(web_dir, "obs", day, "threads", thread_id, "thread.json")
    if not os.path.isfile(thread_path):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    return FileResponse(thread_path, media_type="application/json")

@app.post("/api/debug-push")
async def debug_push(request: Request):
    data = await request.json()
    user_id = data.get("user_id") or data.get("userid")
    device_id = data.get("device_id") or data.get("deviceid")

    # Indlæs latest.json og tag første observation
    try:
        with open(latest_symlink_path, "r", encoding="utf-8") as f:
            latest_list = json.load(f)
        if not latest_list or not isinstance(latest_list, list):
            return JSONResponse({"error": "Ingen observationer fundet eller forkert format"}, status_code=400)
        obs = latest_list[0]
    except Exception as e:
        return JSONResponse({"error": f"Kunne ikke læse latest.json: {e}"}, status_code=500)

    # Find subscription for denne bruger+device
    try:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                "SELECT subscription FROM subscriptions WHERE user_id=? AND device_id=?",
                (user_id, device_id)
            ).fetchone()
        if not row:
            return JSONResponse({"error": f"Ingen subscription fundet for {user_id} / {device_id}"}, status_code=404)
        sub = json.loads(row[0])
    except Exception as e:
        return JSONResponse({"error": f"DB-fejl: {e}"}, status_code=500)

    # Byg push payload
    title = f"{obs.get('Antal','?')} {obs.get('Artnavn','')}, {obs.get('Loknavn','')}"
    body = f"{obs.get('Adfbeskrivelse','')}, {obs.get('Fornavn','')} {obs.get('Efternavn','')}"
    payload = {
        "title": title,
        "body": body,
        "url": obs.get("url", "https://dofbasen.dk"),
        "tag": obs.get("tag") or ""
    }

    # Send push
    try:
        webpush(
            subscription_info=sub,
            data=json.dumps(payload, ensure_ascii=False),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={
                "sub": "mailto:cvh.privat@gmail.com",
                "publicKey": VAPID_PUBLIC_KEY  # valgfrit, men ikke som separat argument
            },
            ttl=3600,  # 1 time
            headers={"Urgency": "high"}  # <-- Tilføj urgency high
        )
    except Exception as ex:
        return JSONResponse({"error": f"webpush-fejl: {ex}"}, status_code=500)

    return {"ok": True}

def should_notify(prefs, afdeling, kategori):
    # Normaliser afdeling og kategori
    afdeling_norm = normalize(afdeling)
    prefs_norm = {normalize(k): v for k, v in prefs.items()}
    valg = prefs_norm.get(afdeling_norm, "Ingen")
    if valg == "Ingen":
        return False
    kat_norm = normalize(kategori)
    if valg == "SU":
        return kat_norm == "su"
    if valg == "SUB":
        return kat_norm in ("su", "sub")
    if valg == "Bemærk":
        return kat_norm in ("su", "sub", "bemaerk", "bemærk")
    return False

# --- WEBSOCKET CHAT/THUMBSUP ---

# In-memory mapping: (day, thread_id) -> [WebSocket, ...]
ws_connections: Dict[str, List[WebSocket]] = {}

def ws_key(day, thread_id):
    return f"{day}::{thread_id}"

def load_blacklisted_obsids():
    try:
        with open(BLACKLIST_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return set(entry["obserkode"] for entry in data if "obserkode" in entry)
    except Exception:
        return set()
    
def get_comment_lock(day, thread_id):
    return comment_file_locks[(day, thread_id)]

def get_comments_for_thread(day, thread_id):
    lock = get_comment_lock(day, thread_id)
    with lock:
        thread_dir = os.path.join(web_dir, "obs", day, "threads", thread_id)
        comments_path = os.path.join(thread_dir, "kommentar.json")
        if not os.path.isfile(comments_path):
            return []
        with open(comments_path, "r", encoding="utf-8") as f:
            return json.load(f)

def save_comments_for_thread(day, thread_id, comments):
    lock = get_comment_lock(day, thread_id)
    with lock:
        thread_dir = os.path.join(web_dir, "obs", day, "threads", thread_id)
        os.makedirs(thread_dir, exist_ok=True)
        comments_path = os.path.join(thread_dir, "kommentar.json")
        with open(comments_path, "w", encoding="utf-8") as f:
            json.dump(comments, f, ensure_ascii=False, indent=2)

def get_comments_for_user(thread_comments, current_user_id):
    blacklisted = load_blacklisted_obsids()
    filtered = []
    for c in thread_comments:
        if c.get("obserkode") in blacklisted:
            if c.get("user_id") == current_user_id:
                filtered.append(c)  # vis kun til afsender
        else:
            filtered.append(c)
    return filtered

@app.post("/api/admin/blacklist")
async def admin_blacklist(data: dict = Body(...)):
    obsid = data.get("obsid")
    user_id = data.get("user_id")
    if not obsid or not user_id:
        return {"ok": False, "error": "Missing obsid or user_id"}
    # Tjek admin-status
    prefs = get_prefs(user_id)
    admins = load_admins()
    if prefs.get("obserkode") not in admins:
        return {"ok": False, "error": "Not admin"}
    try:
        with open("./blacklist.json", "r", encoding="utf-8") as f:
            bl = json.load(f)
        if obsid not in bl["blacklisted_obsids"]:
            bl["blacklisted_obsids"].append(obsid)
            with open("./blacklist.json", "w", encoding="utf-8") as f:
                json.dump(bl, f, ensure_ascii=False, indent=2)
        return {"ok": True}
    except Exception as e:
        print("Blacklist error:", e)
        return {"ok": False, "error": "Server error"}
    
def is_blacklisted_obserkode(obserkode):
    return obserkode in load_blacklisted_obsids()

def is_valid_user_device(user_id, device_id):
    """Tjek at user_id/device_id findes i subscriptions-tabellen."""
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT 1 FROM subscriptions WHERE user_id=? AND device_id=?",
            (user_id, device_id)
        ).fetchone()
    return bool(row)

def is_thread_subscriber(day, thread_id, user_id, device_id):
    """Tjek at user_id/device_id er abonnent på tråden."""
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT 1 FROM thread_subs WHERE day=? AND thread_id=? AND user_id=? AND device_id=?",
            (day, thread_id, user_id, device_id)
        ).fetchone()
    return bool(row)

@app.websocket("/ws/thread/{day}/{thread_id}")
async def ws_thread(websocket: WebSocket, day: str, thread_id: str):
    await websocket.accept()
    key = ws_key(day, thread_id)
    ws_connections.setdefault(key, []).append(websocket)
    thread_dir = os.path.join(web_dir, "obs", day, "threads", thread_id)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)

            msg_type = msg.get("type")
            user_id = msg.get("user_id")
            device_id = msg.get("device_id")

            # Alle må læse kommentarer
            if msg_type == "get_comments":
                comments = get_comments_for_thread(day, thread_id)
                filtered = get_comments_for_user(comments, user_id)
                safe_comments = [safe_comment(c) for c in filtered]
                await websocket.send_json({"type": "comments", "comments": safe_comments})
                continue

            # Kun brugere med gyldig user_id/device_id må skrive/like
            if not user_id or not device_id or not is_valid_user_device(user_id, device_id):
                await websocket.send_json({"type": "error", "message": "Du skal være logget ind for at skrive eller like."})
                continue

            # Ny kommentar
            if msg_type == "new_comment":
                navn = msg.get("navn", "Ukendt")
                body = (msg.get("body") or "").strip()
                user_id = msg.get("user_id")
                device_id = msg.get("device_id")
                obserkode = msg.get("obserkode", "")
                blacklisted = load_blacklisted_obsids()
                if obserkode in blacklisted:
                    await websocket.send_json({"type": "error", "message": "Du er blacklistet og kan ikke skrive kommentarer."})
                    continue
                if not body or not user_id or not device_id:
                    continue
                ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                comment = {
                    "navn": navn,
                    "obserkode": obserkode,
                    "body": body,
                    "ts": ts,
                    "thumbs": 0,
                    "thumbs_users": [],
                    "user_id": user_id,
                    "device_id": device_id
                }
                comments = get_comments_for_thread(day, thread_id)
                comments.append(comment)
                save_comments_for_thread(day, thread_id, comments)

                # Log kommentaren til comments.log
                comment_log_entry = {
                    "day": day,
                    "thread_id": thread_id,
                    **comment
                }
                with open("comments.log", "a", encoding="utf-8") as logf:
                    logf.write(json.dumps(comment_log_entry, ensure_ascii=False) + "\n")

                # Tilføj forfatteren som abonnent på tråden (hvis ikke allerede)
                with sqlite3.connect(DB_PATH) as conn:
                    conn.execute(
                        "INSERT OR IGNORE INTO thread_subs (day, thread_id, user_id, device_id) VALUES (?, ?, ?, ?)",
                        (day, thread_id, user_id, device_id)
                    )

                # --- AUTO-SUBSCRIBE ALLE OBSERKODER FRA EVENTS PÅ TRÅDEN ---
                thread_path = os.path.join(thread_dir, "thread.json")
                obserkoder_on_thread = set()
                if os.path.isfile(thread_path):
                    try:
                        with open(thread_path, "r", encoding="utf-8") as f:
                            thread_data = json.load(f)
                        events = thread_data.get("events", [])
                        for ev in events:
                            kode = (ev.get("Obserkode") or ev.get("obserkode") or "").strip().upper()
                            if kode:
                                obserkoder_on_thread.add(kode)
                    except Exception:
                        pass

                if obserkoder_on_thread:
                    with sqlite3.connect(DB_PATH) as conn:
                        for kode in obserkoder_on_thread:
                            rows = conn.execute("SELECT user_id, prefs FROM user_prefs").fetchall()
                            for u_id, prefs_json in rows:
                                try:
                                    prefs = json.loads(prefs_json)
                                    bruger_kode = (prefs.get("obserkode") or "").strip().upper()
                                    if bruger_kode == kode:
                                        dev_rows = conn.execute("SELECT device_id FROM subscriptions WHERE user_id=?", (u_id,)).fetchall()
                                        for (dev_id,) in dev_rows:
                                            # Tjek om brugeren har afmeldt denne tråd
                                            skip = conn.execute(
                                                "SELECT 1 FROM thread_unsubs WHERE day=? AND thread_id=? AND user_id=? AND device_id=?",
                                                (day, thread_id, u_id, dev_id)
                                            ).fetchone()
                                            if skip:
                                                continue
                                            conn.execute(
                                                "INSERT OR IGNORE INTO thread_subs (day, thread_id, user_id, device_id) VALUES (?, ?, ?, ?)",
                                                (day, thread_id, u_id, dev_id)
                                            )
                                except Exception:
                                    continue
                        conn.commit()
                # --- SLUT AUTO-SUBSCRIBE ---

                # Send push til alle abonnenter (undtagen forfatteren)
                with sqlite3.connect(DB_PATH) as conn:
                    subs = conn.execute(
                        "SELECT user_id, device_id FROM thread_subs WHERE day=? AND thread_id=?",
                        (day, thread_id)
                    ).fetchall()
                thread_path = os.path.join(thread_dir, "thread.json")
                artnavn = ""
                loknavn = ""
                if os.path.isfile(thread_path):
                    try:
                        with open(thread_path, "r", encoding="utf-8") as f:
                            thread_data = json.load(f)
                        thread_info = thread_data.get("thread", {})
                        artnavn = thread_info.get("art", "")
                        loknavn = thread_info.get("lok", "")
                    except Exception:
                        pass
                for sub_user_id, sub_device_id in subs:
                    # Find obserkode for abonnent
                    sub_prefs = get_prefs(sub_user_id)
                    sub_obserkode = (sub_prefs.get("obserkode") or "").strip().upper()
                    # Find obserkode for forfatter
                    author_prefs = get_prefs(user_id)
                    author_obserkode = (author_prefs.get("obserkode") or "").strip().upper()
                    # Spring over hvis det er forfatteren selv eller en anden med samme obserkode
                    if (sub_user_id == user_id and sub_device_id == device_id) or (sub_obserkode and author_obserkode and sub_obserkode == author_obserkode):
                        continue
                    with sqlite3.connect(DB_PATH) as conn:
                        row = conn.execute(
                            "SELECT subscription FROM subscriptions WHERE user_id=? AND device_id=?",
                            (sub_user_id, sub_device_id)
                        ).fetchone()
                    if not row:
                        continue
                    sub = json.loads(row[0])
                    payload = {
                        "title": f"Nyt indlæg på: {artnavn} - {loknavn}",
                        "body": f"{navn}: {body}",
                        "url": f"/traad.html?date={day}&id={thread_id}",
                        "tag": f"{thread_id}-comment-{ts.replace(' ', '_').replace(':', '-')}"
                    }
                    try:
                        webpush(
                            subscription_info=sub,
                            data=json.dumps(payload, ensure_ascii=False),
                            vapid_private_key=VAPID_PRIVATE_KEY,
                            vapid_claims={"sub": "mailto:kontakt@dofnot.dk"},
                            ttl=3600,
                            headers={"Urgency": "high"}
                        )
                    except Exception as ex:
                        print(f"Push-fejl til {sub_user_id}/{sub_device_id}: {ex}")

                # Broadcast til alle websockets
                for ws in ws_connections.get(key, []):
                    try:
                        await ws.send_json({"type": "new_comment"})
                    except:
                        pass

            # Thumbs up
            elif msg.get("type") == "thumbsup":
                ts = msg.get("ts")
                user_id = msg.get("user_id")
                if not ts or not user_id:
                    continue
                comments = get_comments_for_thread(day, thread_id)
                found = False
                for c in comments:
                    if c.get("ts") == ts:
                        thumbs_users = set(c.get("thumbs_users", []))
                        already_thumbed = user_id in thumbs_users
                        if already_thumbed:
                            thumbs_users.remove(user_id)
                        else:
                            thumbs_users.add(user_id)
                        c["thumbs_users"] = list(thumbs_users)
                        c["thumbs"] = len(thumbs_users)
                        found = True

                        # Send push hvis ny thumbs up og ikke fra ejeren selv
                        if not already_thumbed and user_id != c.get("user_id"):
                            owner_user_id = c.get("user_id")
                            owner_device_id = c.get("device_id")
                            if owner_user_id and owner_device_id:
                                with sqlite3.connect(DB_PATH) as conn:
                                    sub_row = conn.execute(
                                        "SELECT 1 FROM thread_subs WHERE day=? AND thread_id=? AND user_id=? AND device_id=?",
                                        (day, thread_id, owner_user_id, owner_device_id)
                                    ).fetchone()
                                if sub_row:
                                    with sqlite3.connect(DB_PATH) as conn:
                                        row = conn.execute(
                                            "SELECT subscription FROM subscriptions WHERE user_id=? AND device_id=?",
                                            (owner_user_id, owner_device_id)
                                        ).fetchone()
                                    if row:
                                        sub = json.loads(row[0])
                                        thread_path = os.path.join(thread_dir, "thread.json")
                                        artnavn = ""
                                        loknavn = ""
                                        if os.path.isfile(thread_path):
                                            try:
                                                with open(thread_path, "r", encoding="utf-8") as f:
                                                    thread_data = json.load(f)
                                                thread_info = thread_data.get("thread", {})
                                                artnavn = thread_info.get("art", "")
                                                loknavn = thread_info.get("lok", "")
                                            except Exception:
                                                pass
                                        payload = {
                                            "title": f"👍 på dit indlæg: {artnavn} - {loknavn}",
                                            "body": f"Dit indlæg har fået en thumbs up!",
                                            "url": f"/traad.html?date={day}&id={thread_id}",
                                            "tag": f"{thread_id}-thumbsup-{ts.replace(' ', '_').replace(':', '-')}"
                                        }
                                        try:
                                            webpush(
                                                subscription_info=sub,
                                                data=json.dumps(payload, ensure_ascii=False),
                                                vapid_private_key=VAPID_PRIVATE_KEY,
                                                vapid_claims={"sub": "mailto:kontakt@dofnot.dk"},
                                                ttl=3600,
                                                headers={"Urgency": "high"}
                                            )
                                        except Exception as ex:
                                            print(f"Push-fejl til {owner_user_id}/{owner_device_id}: {ex}")
                        break
                if found:
                    save_comments_for_thread(day, thread_id, comments)
                    for ws in ws_connections.get(key, []):
                        try:
                            await ws.send_json({"type": "thumbs_update"})
                        except:
                            pass

    except WebSocketDisconnect:
        ws_connections[key].remove(websocket)
        if not ws_connections[key]:
            del ws_connections[key]

app.mount("/", StaticFiles(directory=web_dir, html=True), name="web")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)