import time
from datetime import datetime, timedelta
import pytz
import server
import os
import requests

def wait_until_next_run():
    tz = pytz.timezone("Europe/Copenhagen")
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