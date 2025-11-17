import sqlite3
import json
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "users.db")

with sqlite3.connect(DB_PATH) as conn:
    rows = conn.execute("SELECT user_id, prefs FROM user_prefs").fetchall()
    for uid, prefs_json in rows:
        try:
            prefs = json.loads(prefs_json)
            adv = prefs.get("advanced", None)
            print(f"user_id={uid} advanced={adv!r}")
        except Exception as e:
            print(f"user_id={uid} advanced=ERROR ({e})")