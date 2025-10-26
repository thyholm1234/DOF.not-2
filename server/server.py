import sqlite3
from fastapi import FastAPI, Request, status, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
import json
import os
import glob
from fastapi.staticfiles import StaticFiles
import json, os, datetime
from pywebpush import webpush

VAPID_PRIVATE_KEY = "An73heQXWe62IL_wrlyz6N102d_9yH-tZKCohrDNRTY"
VAPID_PUBLIC_KEY = "BHU3aBbXkYu7_KGJtKMEWCPU43gF1b6L0DKGVv-n_5-iybitwM5dodQdR2GkIec8OOWcJlwCEMSMzpfRX_RBUkA"

app = FastAPI()
DB_PATH = os.path.join(os.path.dirname(__file__), "users.db")

def db_init():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                userid TEXT PRIMARY KEY,
                deviceid TEXT,
                prefs TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS subscriptions (
                userid TEXT,
                deviceid TEXT,
                subscription TEXT,
                PRIMARY KEY (userid, deviceid)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_prefs (
                user_id TEXT PRIMARY KEY,
                prefs TEXT,
                ts INTEGER
            )
        """)
db_init()

def get_prefs(userid):
    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute("SELECT prefs FROM users WHERE userid=?", (userid,))
        row = cur.fetchone()
        return json.loads(row[0]) if row else {}

def set_prefs(userid, deviceid, prefs):
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("INSERT OR REPLACE INTO users (userid, deviceid, prefs) VALUES (?, ?, ?)",
                     (userid, deviceid, json.dumps(prefs)))
        
@app.get("/app.js")
async def app_js():
    return FileResponse(os.path.join(web_dir, "app.js"), media_type="application/javascript")

@app.get("/threads.js")
async def threads_js():
    return FileResponse(os.path.join(web_dir, "threads.js"), media_type="application/javascript")

@app.get("/thread.js")
async def threads_js():
    return FileResponse(os.path.join(web_dir, "threads.js"), media_type="application/javascript")

@app.post("/api/prefs")
async def api_set_prefs(request: Request):
    data = await request.json()
    userid = data.get("userid")
    deviceid = data.get("deviceid")
    prefs = data.get("prefs")
    set_prefs(userid, deviceid, prefs)
    return {"ok": True}

@app.get("/api/prefs")
async def api_get_prefs(userid: str):
    prefs = get_prefs(userid)
    return JSONResponse(prefs)

@app.post("/api/unsubscribe")
async def api_unsubscribe(request: Request):
    # Her fjernes evt. push subscription info
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

@app.post("/api/update")
async def update_data(request: Request):
    payload = await request.json()  # Liste af observationer
    _save_payload(payload)
    # Hent alle brugere med prefs og subscription
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT users.userid, users.deviceid, users.prefs, subscriptions.subscription "
            "FROM users JOIN subscriptions ON users.userid = subscriptions.userid AND users.deviceid = subscriptions.deviceid"
        ).fetchall()
    for userid, deviceid, prefs_json, sub_json in rows:
        prefs = json.loads(prefs_json)
        sub = json.loads(sub_json)
        for obs in payload:
            afd = obs.get("DOF_afdeling")
            kat = obs.get("kategori")
            if should_notify(prefs, afd, kat):
                # Byg push payload
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
                        data=json.dumps(push_payload, ensure_ascii=False),
                        vapid_private_key=VAPID_PRIVATE_KEY,
                        vapid_claims={"sub": "mailto:cvh.privat@gmail.com"},
                        ttl=60
                    )
                except Exception as ex:
                    print(f"Push-fejl til {userid}/{deviceid}: {ex}")
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

@app.post("/api/subscribe")
async def api_subscribe(request: Request):
    data = await request.json()
    userid = data.get("userid")
    deviceid = data.get("deviceid")
    subscription = data.get("subscription")
    # Gem subscription i database (fx tabel: subscriptions)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO subscriptions (userid, deviceid, subscription) VALUES (?, ?, ?)",
            (userid, deviceid, json.dumps(subscription))
        )
    return {"ok": True}

@app.post("/api/debug-push")
async def debug_push(request: Request):
    data = await request.json()
    userid = data.get("userid")
    deviceid = data.get("deviceid")

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
                "SELECT subscription FROM subscriptions WHERE userid=? AND deviceid=?",
                (userid, deviceid)
            ).fetchone()
        if not row:
            return JSONResponse({"error": f"Ingen subscription fundet for {userid} / {deviceid}"}, status_code=404)
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
    valg = prefs.get(afdeling, "Ingen")
    if valg == "Ingen":
        return False
    if valg == "SU":
        return kategori == "SU"
    if valg == "SUB":
        return kategori in ("SU", "SUB")
    if valg == "Bemærk":
        return kategori in ("SU", "SUB", "Bemærk")
    return False

app.mount("/", StaticFiles(directory=web_dir, html=True), name="web")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)