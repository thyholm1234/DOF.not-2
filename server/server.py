import sqlite3
from fastapi import FastAPI, Request, status, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
import json
import os
import glob
import datetime
from fastapi.staticfiles import StaticFiles
from pywebpush import webpush, WebPushException
import unicodedata
import re
import html
import urllib.request
from urllib.parse import urljoin, urlparse, parse_qs
from fastapi import Query, Depends
import threading
import time
from contextlib import asynccontextmanager
from dotenv import load_dotenv
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List

load_dotenv()

VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY")
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY")

app = FastAPI()
DB_PATH = os.path.join(os.path.dirname(__file__), "users.db")

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
    now = datetime.datetime.now()
    for name in os.listdir(base_dir):
        dir_path = os.path.join(base_dir, name)
        if not os.path.isdir(dir_path):
            continue
        try:
            dir_date = datetime.datetime.strptime(name, "%d-%m-%Y")
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

@asynccontextmanager
async def lifespan(app: FastAPI):
    def run_and_repeat():
        while True:
            try:
                cleanup_dirs(os.path.join(web_dir, "payload"), days=3)
                cleanup_dirs(os.path.join(web_dir, "obs"), days=3)
                database_maintenance()
            except Exception as e:
                print(f"Fejl under oprydning: {e}")
            time.sleep(3600)
    t = threading.Thread(target=run_and_repeat, daemon=True)
    t.start()
    yield  # Lifespan fortsætter mens app kører

app = FastAPI(lifespan=lifespan)

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
    ts = int(datetime.datetime.now().timestamp())
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO user_prefs (user_id, prefs, ts) VALUES (?, ?, ?)",
            (user_id, json.dumps(prefs), ts)
        )

@app.post("/api/prefs")
async def api_set_prefs(request: Request):
    data = await request.json()
    user_id = data.get("user_id")
    new_prefs = data.get("prefs")
    # Hent eksisterende prefs og opdater kun afdelingsvalg
    old_prefs = get_prefs(user_id)
    # Opdater kun afdelingsnøgler
    for afd in new_prefs:
        old_prefs[afd] = new_prefs[afd]
    set_prefs(user_id, old_prefs)
    return {"ok": True}

@app.get("/api/prefs")
async def api_get_prefs(user_id: str):
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
        return datetime.datetime.strptime(f"{date_str} {time_str}", "%d-%m-%Y %H:%M")
    except Exception:
        try:
            return datetime.datetime.strptime(date_str, "%d-%m-%Y")
        except Exception:
            return datetime.datetime.min
        
def get_species_filters_for_user(user_id: str) -> dict:
    prefs = get_prefs(user_id)
    return prefs.get("species_filters") or {"include": [], "exclude": [], "counts": {}}        

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
    return datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

def _save_payload(payload) -> str:
    # Opret dato-mappe i format DD-MM-YYYY
    today = datetime.datetime.now().strftime("%d-%m-%Y")
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

@app.get("/api/notifications/enabled")
async def notifications_enabled(user_id: str, device_id: str):
    """
    Returnerer om notifikationer er slået til for denne bruger+device.
    """
    # Findes der et subscription for denne user+device?
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT 1 FROM subscriptions WHERE user_id=? AND device_id=?",
            (user_id, device_id)
        ).fetchone()
    # Tjek også om brugeren har slået notificationsEnabled fra i localStorage (valgfrit, hvis du vil synkronisere)
    enabled = bool(row)
    return {"enabled": enabled}

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

@app.get("/api/thread/{day}/{thread_id}/subscription")
async def get_subscription(day: str, thread_id: str, user_id: str, device_id: str):
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
                    conn2.commit()
            else:
                print(f"Push-fejl til {user_id}/{device_id}: {ex}")

    with ThreadPoolExecutor(max_workers=8) as executor, sqlite3.connect(DB_PATH) as conn:
        for obs in payload:
            afd = obs.get("DOF_afdeling")
            kat = obs.get("kategori")
            statechanged = int(obs.get("statechanged", 0))
            thread_id = obs.get("tag")  # eller brug obs.get("thread_id") hvis det findes
            day = datetime.datetime.strptime(obs.get("Dato"), "%Y-%m-%d").strftime("%d-%m-%Y")
            title = f"{obs.get('Antal','?')} {obs.get('Artnavn','')}, {obs.get('Loknavn','')}"
            body = f"{obs.get('Adfbeskrivelse','')}, {obs.get('Fornavn','')} {obs.get('Efternavn','')}"
            push_payload = {
                "title": title,
                "body": body,
                "url": obs.get("url", "https://dofbasen.dk"),
                "tag": obs.get("tag") or ""
            }

            if statechanged == 1:
                # Send til alle med prefs
                rows = conn.execute(
                    "SELECT user_prefs.user_id, subscriptions.device_id, user_prefs.prefs, subscriptions.subscription "
                    "FROM user_prefs JOIN subscriptions ON user_prefs.user_id = subscriptions.user_id"
                ).fetchall()
                for user_id, device_id, prefs_json, sub_json in rows:
                    prefs = json.loads(prefs_json)
                    sub = json.loads(sub_json)
                    species_filters = prefs.get("species_filters") or {"include": [], "exclude": [], "counts": {}}
                    if should_notify(prefs, afd, kat) and should_include_obs(obs, species_filters):
                        tasks.append(
                            executor.submit(push_task, sub, push_payload, user_id, device_id)
                        )
            else:
                # Send kun til thread-subscribers
                if not thread_id:
                    continue
                rows = conn.execute(
                    "SELECT user_id, device_id FROM thread_subs WHERE day=? AND thread_id=?",
                    (day, thread_id)
                ).fetchall()
                for user_id, device_id in rows:
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
                
   
@app.get("/api/lookup_obserkode")
async def lookup_obserkode(obserkode: str = Query(...)):
    import requests
    url = f"https://dofbasen.dk/popobser.php?obserkode={obserkode}"
    try:
        r = requests.get(url, timeout=10)
        if r.status_code != 200:
            return {"navn": ""}
        # Find linjen med "Navn" og tag næste <td>
        html = r.text
        navn = ""
        idx = html.find("Navn</acronym>:</td><td valign=\"top\">")
        if idx != -1:
            start = idx + len("Navn</acronym>:</td><td valign=\"top\">")
            end = html.find("</td>", start)
            if end != -1:
                navn = html[start:end].strip()
        return {"navn": navn}
    except Exception:
        return {"navn": ""}

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

@app.get("/api/thread/{day}/{thread_id}")
async def api_thread(day: str, thread_id: str):
    """Returner thread.json for en given dag og tråd-id."""
    thread_path = os.path.join(web_dir, "obs", day, "threads", thread_id, "thread.json")
    if not os.path.isfile(thread_path):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    with open(thread_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return JSONResponse(data)

@app.get("/api/userinfo")
async def get_userinfo(user_id: str, device_id: str):
    prefs = get_prefs(user_id)
    return {
        "user_id": user_id,
        "device_id": device_id,
        "obserkode": prefs.get("obserkode", ""),
        "navn": prefs.get("navn", "")
    }

@app.post("/api/userinfo")
async def save_userinfo(data: dict):
    user_id = data.get("user_id")
    device_id = data.get("device_id")
    obserkode = data.get("obserkode", "")
    navn = data.get("navn", "")
    prefs = get_prefs(user_id)
    prefs["obserkode"] = obserkode
    prefs["navn"] = navn
    set_prefs(user_id, prefs)
    return {"ok": True}

@app.get("/api/userinfo")
async def get_userinfo(user_id: str, device_id: str):
    prefs = get_prefs(user_id)
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

@app.get("/api/thread/{day}/{thread_id}/comments")
async def get_comments(day: str, thread_id: str):
    thread_dir = os.path.join(web_dir, "obs", day, "threads", thread_id)
    comments_path = os.path.join(thread_dir, "kommentar.json")
    if not os.path.isfile(comments_path):
        return []
    with open(comments_path, "r", encoding="utf-8") as f:
        return json.load(f)

@app.post("/api/thread/{day}/{thread_id}/comments")
async def post_comment(day: str, thread_id: str, request: Request):
    import sqlite3

    data = await request.json()
    navn = data.get("navn", "Ukendt")
    body = data.get("body", "").strip()
    user_id = data.get("user_id")
    device_id = data.get("device_id")
    if not body:
        raise HTTPException(status_code=400, detail="Besked må ikke være tom")
    if not user_id or not device_id:
        raise HTTPException(status_code=400, detail="user_id og device_id kræves")

    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    comment = {
        "navn": navn,
        "body": body,
        "ts": ts,
        "thumbs": 0,
        "thumbs_users": [],
        "user_id": user_id,
        "device_id": device_id
    }
    thread_dir = os.path.join(web_dir, "obs", day, "threads", thread_id)
    os.makedirs(thread_dir, exist_ok=True)
    comments_path = os.path.join(thread_dir, "kommentar.json")
    comments = []
    if os.path.isfile(comments_path):
        with open(comments_path, "r", encoding="utf-8") as f:
            comments = json.load(f)
    comments.append(comment)
    with open(comments_path, "w", encoding="utf-8") as f:
        json.dump(comments, f, ensure_ascii=False, indent=2)

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
                                    continue  # Brugeren har aktivt afmeldt, så spring over
                                conn.execute(
                                    "INSERT OR IGNORE INTO thread_subs (day, thread_id, user_id, device_id) VALUES (?, ?, ?, ?)",
                                    (day, thread_id, u_id, dev_id)
                                )
                    except Exception:
                        continue
            conn.commit()
    # --- SLUT AUTO-SUBSCRIBE ---

    # Find alle abonnenter for tråden (for dagen)
    with sqlite3.connect(DB_PATH) as conn:
        subs = conn.execute(
            "SELECT user_id, device_id FROM thread_subs WHERE day=? AND thread_id=?",
            (day, thread_id)
        ).fetchall()

    # Find artnavn og loknavn fra thread.json (hvis muligt)
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

    # Send push til alle abonnenter
    for sub_user_id, sub_device_id in subs:
        # Spring forfatteren over
        if sub_user_id == user_id and sub_device_id == device_id:
            continue
        # Find subscription-info
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
                headers={"Urgency": "high"}  # <-- Tilføj urgency high
            )
        except Exception as ex:
            print(f"Push-fejl til {sub_user_id}/{sub_device_id}: {ex}")

    return {"ok": True}   

@app.get("/api/prefs/user/species")
async def get_species_filters(user_id: str):
    prefs = get_prefs(user_id)
    # Returner kun artsfilter-delen hvis den findes, ellers tomt format
    return JSONResponse(prefs.get("species_filters") or {"include": [], "exclude": [], "counts": {}})

@app.post("/api/prefs/user/species")
async def set_species_filters(request: Request):
    data = await request.json()
    user_id = data.get("user_id")
    filters = data
    # Hent eksisterende prefs og opdater artsfilter-delen
    prefs = get_prefs(user_id)
    prefs["species_filters"] = filters
    set_prefs(user_id, prefs)
    return {"ok": True}

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

def get_comments_for_thread(day, thread_id):
    thread_dir = os.path.join(web_dir, "obs", day, "threads", thread_id)
    comments_path = os.path.join(thread_dir, "kommentar.json")
    if not os.path.isfile(comments_path):
        return []
    with open(comments_path, "r", encoding="utf-8") as f:
        return json.load(f)

def save_comments_for_thread(day, thread_id, comments):
    thread_dir = os.path.join(web_dir, "obs", day, "threads", thread_id)
    os.makedirs(thread_dir, exist_ok=True)
    comments_path = os.path.join(thread_dir, "kommentar.json")
    with open(comments_path, "w", encoding="utf-8") as f:
        json.dump(comments, f, ensure_ascii=False, indent=2)

@app.websocket("/ws/thread/{day}/{thread_id}")
async def ws_thread_comments(websocket: WebSocket, day: str, thread_id: str):
    await websocket.accept()
    key = ws_key(day, thread_id)
    ws_connections.setdefault(key, []).append(websocket)
    thread_dir = os.path.join(web_dir, "obs", day, "threads", thread_id)  # <-- Tilføj denne linje
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
            except Exception:
                continue

            # Tilføj denne blok:
            if msg.get("type") == "get_comments":
                comments = get_comments_for_thread(day, thread_id)
                await websocket.send_json({"type": "comments", "comments": comments})
                continue

            # Ny kommentar
            if msg.get("type") == "new_comment":
                navn = msg.get("navn", "Ukendt")
                body = (msg.get("body") or "").strip()
                user_id = msg.get("user_id")
                device_id = msg.get("device_id")
                if not body or not user_id or not device_id:
                    continue
                ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                comment = {
                    "navn": navn,
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

                # --- SEND PUSH TIL ALLE ABONNENTER (undtagen forfatteren) ---
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
                    if sub_user_id == user_id and sub_device_id == device_id:
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
                # --- SLUT PUSH ---

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

                        # --- SEND PUSH HVIS NY THUMBS UP OG IKKE FRA EJEREN SELV ---
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
                        # --- SLUT PUSH ---
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