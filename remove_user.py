import sqlite3
import os
import sys

if len(sys.argv) < 2:
    print("Brug: python remove_user.py <user_id>")
    sys.exit(1)

USER_ID = sys.argv[1]
DB_PATH = os.path.join(os.path.dirname(__file__), "server", "users.db")

print(f"Du er ved at slette brugeren: {USER_ID}")
confirm = input("Er du sikker? (y/n): ").strip().lower()
if confirm != "y":
    print("Annulleret.")
    sys.exit(0)

with sqlite3.connect(DB_PATH) as conn:
    conn.execute("DELETE FROM user_prefs WHERE user_id=?", (USER_ID,))
    conn.execute("DELETE FROM subscriptions WHERE user_id=?", (USER_ID,))
    conn.execute("DELETE FROM thread_subs WHERE user_id=?", (USER_ID,))
    conn.execute("DELETE FROM thread_unsubs WHERE user_id=?", (USER_ID,))
    conn.commit()

print(f"Bruger {USER_ID} er nu slettet fra databasen.")