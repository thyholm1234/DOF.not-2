# archive_pageviews.py
import sys
from datetime import datetime, timedelta
import pytz

# Importer server.py fra samme mappe
import server

if __name__ == "__main__":
    tz = pytz.timezone("Europe/Copenhagen")
    yesterday = (datetime.now(tz) - timedelta(days=1)).strftime("%Y-%m-%d")
    print(f"Archiving pageviews for {yesterday} ...")
    server.archive_and_reset_pageview_log(for_date=yesterday, reset_log=True)
    print("Done.")