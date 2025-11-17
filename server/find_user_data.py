import sqlite3
import sys

DB_PATH = "users.db"

def get_tables(conn):
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table';").fetchall()
    return [r[0] for r in rows]

def get_columns(conn, table):
    pragma = conn.execute(f"PRAGMA table_info({table});").fetchall()
    # Returner alle kolonnenavne uanset type
    return [col[1] for col in pragma]

def search_user_id_everywhere(user_id):
    with sqlite3.connect(DB_PATH) as conn:
        tables = get_tables(conn)
        found = False
        for table in tables:
            columns = get_columns(conn, table)
            for col in columns:
                try:
                    rows = conn.execute(
                        f"SELECT rowid, * FROM {table} WHERE CAST({col} AS TEXT) LIKE ?", (f"%{user_id}%",)
                    ).fetchall()
                    if rows:
                        found = True
                        print(f"\n--- {table}.{col} ---")
                        for row in rows:
                            print(row)
                except Exception as e:
                    # Mange kolonner kan ikke sammenlignes med LIKE, ignorer fejl
                    continue
        if not found:
            print("Ingen forekomster fundet i nogen kolonner.")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Brug: python find_user_data.py <user_id>")
        sys.exit(1)
    user_id = sys.argv[1]
    search_user_id_everywhere(user_id)