import sqlite3
import json
import os
import sys
import csv

DB_PATH = os.path.join(os.path.dirname(__file__), "server", "users.db")
kategori_rank = {"Bemærk": 1, "SUB": 2, "SU": 3}

output_json = "--json" in sys.argv
output_csv = "--csv" in sys.argv

with sqlite3.connect(DB_PATH) as conn:
    rows = conn.execute("SELECT user_id, prefs FROM user_prefs").fetchall()
    sub_rows = conn.execute("SELECT DISTINCT user_id FROM subscriptions").fetchall()
    sub_user_ids = [row[0] for row in sub_rows]
    prefs_map = {user_id: json.loads(prefs_json) for user_id, prefs_json in rows}

result = []

for user_id in sub_user_ids:
    prefs = prefs_map.get(user_id)
    obserkode = prefs.get("obserkode", "") if prefs else ""
    navn = prefs.get("navn", "") if prefs else ""

    su_count = sub_count = bem_count = 0
    if prefs:
        for afd, kat in prefs.items():
            if afd in ("obserkode", "navn", "species_filters"):
                continue
            if str(kat) == "SU":
                su_count += 1
            elif str(kat) == "SUB":
                sub_count += 1
            elif str(kat) == "Bemærk":
                bem_count += 1

    laveste_kategori = None
    laveste_rank = 99
    afdelinger_med_laveste = []

    if prefs:
        for afd, kat in prefs.items():
            if afd in ("obserkode", "navn", "species_filters"):
                continue
            rank = kategori_rank.get(str(kat), 99)
            if rank < laveste_rank:
                laveste_rank = rank
                laveste_kategori = kat
        for afd, kat in prefs.items():
            if afd in ("obserkode", "navn", "species_filters"):
                continue
            if kategori_rank.get(str(kat), 99) == laveste_rank:
                afdelinger_med_laveste.append(afd)

    # Avanceret filtrering felter
    avanceret_exclude = 0
    avanceret_count = 0
    if prefs and isinstance(prefs.get("species_filters"), dict):
        species_filters = prefs["species_filters"]
        exclude = species_filters.get("exclude", [])
        counts = species_filters.get("counts", {})
        if isinstance(exclude, list):
            avanceret_exclude = len(exclude)
        if isinstance(counts, dict):
            avanceret_count = len(counts)

    entry = {
        "user_id": user_id,
        "obserkode": obserkode or "-",
        "navn": navn or "-",
        "SU": su_count,
        "SUB": sub_count,
        "Bemærk": bem_count,
        "laveste_kategori": laveste_kategori,
        "afdelinger_med_laveste": ", ".join(afdelinger_med_laveste),
        "avanceret_exclude": avanceret_exclude,
        "avanceret_count": avanceret_count,
    }
    result.append(entry)

if output_json:
    with open("list_users.json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print("Gemte som list_users.json")
elif output_csv:
    with open("list_users.csv", "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "user_id", "obserkode", "navn", "SU", "SUB", "Bemærk",
            "laveste_kategori", "afdelinger_med_laveste", "avanceret_exclude", "avanceret_count"
        ])
        writer.writeheader()
        for row in result:
            writer.writerow(row)
    print("Gemte som list_users.csv")
else:
    print(f"\nAntal unikke user_id i subscriptions: {len(sub_user_ids)}\n")
    print("user_id i subscriptions:")
    for entry in result:
        line = (
            f"{entry['user_id']} | Obserkode: {entry['obserkode']} | Navn: {entry['navn']}"
            f" | SU: {entry['SU']} SUB: {entry['SUB']} Bemærk: {entry['Bemærk']}"
            f" | Laveste kategori: {entry['laveste_kategori']} (i: {entry['afdelinger_med_laveste']})"
        )
        if entry['avanceret_exclude'] or entry['avanceret_count']:
            avanceret_parts = []
            if entry['avanceret_exclude']:
                avanceret_parts.append(f"Exclude: {entry['avanceret_exclude']}")
            if entry['avanceret_count']:
                avanceret_parts.append(f"Count: {entry['avanceret_count']}")
            line += " | Avanceret | " + " | ".join(avanceret_parts)
        print(line)