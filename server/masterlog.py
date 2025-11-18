import time
from datetime import datetime, timedelta
import pytz
import server

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
        print("Done.")

if __name__ == "__main__":
    wait_until_next_run()