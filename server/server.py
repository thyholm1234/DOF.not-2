import sqlite3
from fastapi import FastAPI, Request, status, HTTPException
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
from fastapi import Query

VAPID_PRIVATE_KEY = "An73heQXWe62IL_wrlyz6N102d_9yH-tZKCohrDNRTY"
VAPID_PUBLIC_KEY = "BHU3aBbXkYu7_KGJtKMEWCPU43gF1b6L0DKGVv-n_5-iybitwM5dodQdR2GkIec8OOWcJlwCEMSMzpfRX_RBUkA"

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
db_init()

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
    prefs = data.get("prefs")
    set_prefs(user_id, prefs)
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
    os.makedirs(payload_dir, exist_ok=True)
    fname = f"payload_{_ts()}.json"
    fpath = os.path.join(payload_dir, fname)
    with open(fpath, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False)
    # Skriv/overskriv "latest.json" for nem hentning
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

@app.get("/api/obs/images")
def api_obs_images(
    obsid: str = Query(..., min_length=3, description="DOFbasen observation id"),
    url: str | None = Query(None, description="Optional override URL")
):
    """
    Returnér alle fuld-størrelse billed-URL'er som:
    https://service.dofbasen.dk/media/image/o/<filnavn>.jpg
    """
    src = url or f"https://dofbasen.dk/popobs.php?obsid={obsid}&summering=tur&obs=obs"
    try:
        html_page = _fetch_html(src, timeout=10.0)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Kunne ikke hente kilde: {e}")
    images = _extract_service_image_urls(html_page)
    return {"obsid": obsid, "source": src, "count": len(images), "images": images}

@app.post("/api/update")
async def update_data(request: Request):
    payload = await request.json()  # Liste af observationer
    _save_payload(payload)
    # Hent alle brugere med prefs og subscription
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT user_prefs.user_id, subscriptions.device_id, user_prefs.prefs, subscriptions.subscription "
            "FROM user_prefs JOIN subscriptions ON user_prefs.user_id = subscriptions.user_id"
        ).fetchall()
    for user_id, device_id, prefs_json, sub_json in rows:
        prefs = json.loads(prefs_json)
        sub = json.loads(sub_json)
        species_filters = prefs.get("species_filters") or {"include": [], "exclude": [], "counts": {}}
        for obs in payload:
            afd = obs.get("DOF_afdeling")
            kat = obs.get("kategori")
            if should_notify(prefs, afd, kat) and should_include_obs(obs, species_filters):
                # ... send push ...
                title = f"{obs.get('Antal','?')} {obs.get('Artnavn','')}, {obs.get('Loknavn','')}"
                body = f"{obs.get('Adfbeskrivelse','')}, {obs.get('Fornavn','')} {obs.get('Efternavn','')}"
                push_payload = {
                    "title": title,
                    "body": body,
                    "url": obs.get("url", "https://dofbasen.dk")
                }
                try:
                    webpush(
                        subscription_info=sub,
                        data=json.dumps(push_payload),
                        vapid_private_key=VAPID_PRIVATE_KEY,
                        vapid_claims={"sub": "mailto:kontakt@dofnot.dk"},
                        ttl=3600
                    )
                except WebPushException as ex:
                    if ex.response and ex.response.status_code == 410:
                        print(f"Sletter abonnement for {user_id}/{device_id} pga. 410 Gone")
                        with sqlite3.connect(DB_PATH) as conn:
                            conn.execute(
                                "DELETE FROM subscriptions WHERE user_id=? AND device_id=?",
                                (user_id, device_id)
                            )
                            # Hvis du også vil slette brugerens præferencer for denne device, kan du gøre det her:
                            # conn.execute(
                            #     "DELETE FROM user_prefs WHERE user_id=?",
                            #     (user_id,)
                            # )
                            conn.commit()
                    else:
                        print(f"Push-fejl til {user_id}/{device_id}: {ex}")
    return {"ok": True}

@app.get("/api/threads/{day}")
async def api_threads_index(day: str):
    """Returner index.json for en given dag."""
    index_path = os.path.join(web_dir, "obs", day, "index.json")
    if not os.path.isfile(index_path):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    with open(index_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return JSONResponse(data)

@app.get("/api/thread/{day}/{thread_id}")
async def api_thread(day: str, thread_id: str):
    """Returner thread.json for en given dag og tråd-id."""
    thread_path = os.path.join(web_dir, "obs", day, "threads", thread_id, "thread.json")
    if not os.path.isfile(thread_path):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    with open(thread_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return JSONResponse(data)

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
        "url": obs.get("url", "https://dofbasen.dk")
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
            ttl=3600  # 1 time
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

app.mount("/", StaticFiles(directory=web_dir, html=True), name="web")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)