import time
from datetime import datetime, timedelta
import pytz
import server
import os
import requests
import json

def cleanup_old_obsid_birthtimes(log_path, birthtimes_path, days=3):
    # Indlæs log
    with open(log_path, "r", encoding="utf-8") as f:
        log = json.load(f)
    # Indlæs birthtimes
    with open(birthtimes_path, "r", encoding="utf-8") as f:
        birthtimes = json.load(f)

    cutoff = datetime.now() - timedelta(days=days)
    to_delete = []
    for obsid, entry in log.items():
        dato_str = entry.get("dato", "")
        try:
            dato = datetime.strptime(dato_str, "%Y-%m-%d")
        except Exception:
            continue
        if dato < cutoff:
            to_delete.append(obsid)

    # Slet obsid fra begge filer
    for obsid in to_delete:
        log.pop(obsid, None)
        birthtimes.pop(obsid, None)

    # Gem tilbage
    with open(log_path, "w", encoding="utf-8") as f:
        json.dump(log, f, ensure_ascii=False, indent=2)
    with open(birthtimes_path, "w", encoding="utf-8") as f:
        json.dump(birthtimes, f, ensure_ascii=False, indent=2)

def wait_until_next_run():
    tz = pytz.timezone("Europe/Copenhagen")
    import sqlite3
    while True:
        now = datetime.now(tz)
        next_run = (now + timedelta(days=1)).replace(hour=0, minute=0, second=1, microsecond=0)
        seconds = (next_run - now).total_seconds()
        print(f"Venter {int(seconds)} sekunder til næste kørsel ({next_run})")
        time.sleep(seconds)
        yesterday = (datetime.now(tz) - timedelta(days=1)).strftime("%Y-%m-%d")
        print(f"Archiving pageviews for {yesterday} ...")
        server.archive_and_reset_pageview_log(for_date=yesterday, reset_log=True)
        # Slet server.log
        log_path = os.path.join(os.path.dirname(__file__), "server.log")
        try:
            if os.path.exists(log_path):
                with open(log_path, "w", encoding="utf-8") as f:
                    pass  # Tøm filen
                print("server.log tømt.")
            else:
                print("server.log findes ikke.")
        except Exception as e:
            print(f"Kunne ikke slette server.log: {e}")
        # Oprydning i stats_notifications (slet data ældre end 1 år)
        try:
            db_path = os.path.join(os.path.dirname(__file__), "users.db")  # Ret evt. filnavn
            cutoff = (datetime.now() - timedelta(days=365)).strftime("%Y-%m-%d")
            with sqlite3.connect(db_path) as conn:
                conn.execute(
                    "DELETE FROM stats_notifications WHERE date < ?",
                    (cutoff,)
                )
                conn.commit()
            print("Oprydning i stats_notifications udført.")
        except Exception as e:
            print(f"Fejl ved oprydning i stats_notifications: {e}")

        # Oprydning i obsid_birthtimes og log
        try:
            cleanup_old_obsid_birthtimes(
                log_path=os.path.join("web", "obsid_birthtimes_log.json"),
                birthtimes_path=os.path.join("web", "obsid_birthtimes.json"),
                days=3
            )
            print("Oprydning i obsid_birthtimes udført.")
        except Exception as e:
            print(f"Fejl ved oprydning i obsid_birthtimes: {e}")

        # Kald endpoints
        try:
            for url in [
                "https://notifikation.dofbasen.dk/api/admin/fetch-arter-csv",
                "https://notifikation.dofbasen.dk/api/admin/fetch-faenologi-csv",
                "https://notifikation.dofbasen.dk/api/admin/fetch-all-bemaerk-csv",
            ]:
                print(f"Kald: {url}")
                r = requests.post(url, timeout=120)
                print(f"Status: {r.status_code}")
        except Exception as e:
            print(f"Fejl ved kald af endpoints: {e}")
        print("Done.")

if __name__ == "__main__":
    wait_until_next_run()