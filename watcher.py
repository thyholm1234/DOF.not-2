import argparse
import io
import csv
import json
import glob
import time
import os
import re
import requests
from datetime import datetime
from typing import List, Dict, Tuple, Set
from collections import defaultdict

# DOF "excel"-endpoint. Dato indsættes dynamisk i DD-MM-YYYY
BASE_URL = (
    "https://dofbasen.dk/excel/search_result1.php"
    "?design=excel&soeg=soeg&periode=dato&dato={date}&obstype=observationer&species=alle&sortering=dato"
)

# Server endpoint der modtager JSON-array af ændrede observationer (hver med alle 38 kolonner + 'kategori')
SERVER_URL = "http://localhost:8001/api/update"
STATE_FILE = "/state/state.json"
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")  # NYT
WATCH_STATE_FILE = os.path.join(os.path.dirname(__file__), "state", "watch_state.json")  # NYT: separat state til watcher

# De 38 faste kolonner som skal
COLUMNS = [
    "Dato", "Turtidfra", "Turtidtil", "Loknr", "Loknavn", "Artnr", "Artnavn", "Latin", "Sortering",
    "Antal", "Koen", "Adfkode", "Adfbeskrivelse", "Alderkode", "Dragtkode", "Dragtbeskrivelse",
    "Obserkode", "Fornavn", "Efternavn", "Obser_by", "Medobser", "Turnoter", "Fuglnoter", "Metode",
    "Obstidfra", "Obstidtil", "Hemmelig", "Kvalitet", "Turid", "Obsid", "DOF_afdeling",
    "lok_laengdegrad", "lok_breddegrad", "obs_laengdegrad", "obs_breddegrad", "radius",
    "obser_laengdegrad", "obser_breddegrad",
]

# --- NYT: Klassifikation (SU/SUB) + bemærk-tærskler pr. afdeling ---
def load_klassifikation_map() -> Dict[str, str]:
    """Læs arter_filter_klassificeret.csv -> artsnavn -> klassifikation (SU/SUB/Alm)."""
    path = os.path.join(DATA_DIR, "arter_filter_klassificeret.csv")
    mapping: Dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f, delimiter=";")
            for row in reader:
                name = (row.get("artsnavn") or "").strip()
                klass = (row.get("klassifikation") or "").strip()
                if name:
                    mapping[name] = klass
    except Exception as e:
        print(f"[watcher] Kunne ikke læse klassifikationsfil: {e}")
    return mapping

def build_bemaerk_maps() -> Dict[str, Dict[str, int]]:
    """Læs alle *_bemaerk_parsed.csv -> {region_slug: {artsnavn: min_antal}}."""
    region_maps: Dict[str, Dict[str, int]] = {}
    try:
        pattern = os.path.join(DATA_DIR, "*_bemaerk_parsed.csv")
        for fp in glob.glob(pattern):
            slug = os.path.basename(fp).replace("_bemaerk_parsed.csv", "")
            # print(f"[watcher][bemaerk] Indlæser: {fp} (region: {slug})")  # DEBUG
            thresholds: Dict[str, int] = {}
            with open(fp, "r", encoding="utf-8-sig") as f:
                reader = csv.DictReader(f, delimiter=";")
                for row in reader:
                    an = (row.get("artsnavn") or "").strip()
                    t = (row.get("bemaerk_antal") or "").strip()
                    if not an or not t:
                        continue
                    try:
                        thresholds[an] = int(t)
                        # print(f"  - {an}: {t}")  # DEBUG
                    except ValueError:
                        continue
            region_maps[slug] = thresholds
    except Exception as e:
        print(f"[watcher] Kunne ikke læse bemærk-filer: {e}")
    return region_maps

KLASS_MAP = load_klassifikation_map()
BEMAERK_BY_REGION = build_bemaerk_maps()

def to_region_slug(dept: str) -> str:
    s = (dept or "").strip()
    if s.lower().startswith("dof "):
        s = s[4:]
    return slugify(s)

def compute_kategori(row: Dict[str, str]) -> str:
    """Returnér 'SU'/'SUB'/'bemaerk'/'alm' for en observation."""
    art = (row.get("Artnavn") or "").strip()
    # 1) Klassifikation SU/SUB fra arter_filter_klassificeret.csv
    klass = KLASS_MAP.get(art)
    if klass in ("SU", "SUB"):
        return klass
    # 2) Bemærk: pr. DOF-afdeling hvis antal >= tærskel
    region_slug = to_region_slug(row.get("DOF_afdeling") or "")
    thresholds = BEMAERK_BY_REGION.get(region_slug) or {}
    thr = thresholds.get(art)
    if thr is not None and parse_float(row.get("Antal")) >= float(thr):
        return "bemaerk"
    # 3) Fallback
    return "alm"

def enrich_with_kategori(rows: List[Dict[str, str]]) -> List[Dict[str, str]]:
    for r in rows:
        r["kategori"] = compute_kategori(r)
        obsid = r.get("Obsid", "").strip()
        art = (r.get("Artnavn") or "").strip()
        loknr = (r.get("Loknr") or "").strip()
        tag = f"{slugify(art)}-{loknr}" if art and loknr else ""
        r["tag"] = tag
        kat = r["kategori"].upper()
        obsdate = (r.get("Dato") or "").strip()
        # Formatér dato til DD-MM-YYYY hvis nødvendigt
        if re.match(r"^\d{4}-\d{2}-\d{2}$", obsdate):
            y, m, d = obsdate.split("-")
            obsdate_fmt = f"{d}-{m}-{y}"
        else:
            obsdate_fmt = obsdate
        dofnot2_url = f"https://dofnot2.chfotofilm.dk/traad.html?date={obsdate_fmt}&id={slugify(art)}-{loknr}"
        dofbasen_url = f"https://dofbasen.dk/popobs.php?obsid={obsid}&summering=tur&obs=obs" if obsid else ""
        if kat in ("SU", "SUB"):
            r["url"] = dofnot2_url
            r["url2"] = dofbasen_url
        elif kat in ("ALM", "BEMÆRK"):
            r["url"] = dofbasen_url
            if "url2" in r:
                del r["url2"]
        else:
            r["url"] = ""
            if "url2" in r:
                del r["url2"]
    return rows

def slugify(s):
    s = s.lower()
    s = s.replace("æ", "ae").replace("ø", "oe").replace("å", "aa")
    s = re.sub(r'[^a-z0-9]+', '-', s)
    return s.strip('-')

def group_and_sum_by_observer(obs_list):
    # key = (Fornavn, Efternavn, Artnavn, Loknr, Obserkode)
    grouped = defaultdict(lambda: None)
    for row in obs_list:
        key = (
            row.get("Fornavn", "").strip(),
            row.get("Efternavn", "").strip(),
            row.get("Artnavn", "").strip(),
            row.get("Loknr", "").strip(),
            row.get("Obserkode", "").strip(),
        )
        if grouped[key] is None:
            grouped[key] = dict(row)
            grouped[key]["Antal"] = parse_float(row.get("Antal"))
        else:
            grouped[key]["Antal"] += parse_float(row.get("Antal"))
    # Konverter Antal til string igen for konsistens
    for row in grouped.values():
        row["Antal"] = str(int(row["Antal"])) if row["Antal"].is_integer() else str(row["Antal"])
    return list(grouped.values())

def save_threads_and_index(rows: List[Dict[str, str]], day: str):
    import os
    import json

    base_dir = os.path.join("web", "obs", day)
    threads_dir = os.path.join(base_dir, "threads")
    os.makedirs(threads_dir, exist_ok=True)
    threads = {}

    # Saml SU/SUB-rækker i tråde
    for row in rows:
        if row.get("kategori") not in ("SU", "SUB"):
            continue
        art = (row.get("Artnavn") or "").strip()
        loknr = (row.get("Loknr") or "").strip()
        if not art or not loknr:
            continue
        thread_id = f"{slugify(art)}-{loknr}"
        threads.setdefault(thread_id, []).append(row)

    # Indlæs obsid_birthtimes
    birthtimes_path = os.path.join("web", "obsid_birthtimes.json")
    if os.path.exists(birthtimes_path):
        with open(birthtimes_path, "r", encoding="utf-8") as f:
            obsid_birthtimes = json.load(f)
    else:
        obsid_birthtimes = {}

    index = []
    for thread_id, obs_list in threads.items():
        # Find obsid'er for SU/SUB i denne tråd
        obsids = [row.get("Obsid", "").strip() for row in obs_list if row.get("kategori") in ("SU", "SUB")]
        obsidbirthtime = None
        for oid in obsids:
            if oid and oid in obsid_birthtimes:
                obsidbirthtime = obsid_birthtimes[oid]
                break  # Tag den første du finder

        # Find seneste og første observation i tråden
        latest = max(obs_list, key=_parse_dt_from_row)
        earliest = min(obs_list, key=_parse_dt_from_row)

        # Antal individer (sum af Antal)
        obs_by_observer = defaultdict(float)
        for row in obs_list:
            key = (
                row.get("Fornavn", "").strip(),
                row.get("Efternavn", "").strip(),
                row.get("Artnavn", "").strip(),
                row.get("Loknr", "").strip(),
            )
            obs_by_observer[key] += parse_float(row.get("Antal"))
        total_antal = max(obs_by_observer.values(), default=0)

        # Antal observationer (unikt observer-navn)
        observers = set(
            f"{row.get('Fornavn','').strip()} {row.get('Efternavn','').strip()}"
            for row in obs_list
        )
        num_observationer = len([o for o in observers if o.strip()])

        # Klokkeslet fra seneste observation: Obstidfra > Turtidfra > Obstidtil > Turtidtil
        klokkeslet = (
            (latest.get("Obstidfra") or "").strip()
            or (latest.get("Turtidfra") or "").strip()
            or (latest.get("Obstidtil") or "").strip()
            or (latest.get("Turtidtil") or "").strip()
        )

        # Tilføj obsidbirthtime til hver observation i events
        for obs in obs_list:
            oid = obs.get("Obsid", "").strip()
            obs["obsidbirthtime"] = obsid_birthtimes.get(oid, "")

        # Byg index-entry
        index_entry = {
            "day": day,
            "thread_id": thread_id,
            "art": latest.get("Artnavn"),
            "lok": latest.get("Loknavn"),
            "loknr": latest.get("Loknr"),
            "region": latest.get("DOF_afdeling"),
            "status": "active",
            "last_kategori": latest.get("kategori"),
            "first_ts_obs": earliest.get("Dato"),
            "last_ts_obs": latest.get("Dato"),
            "last_adf": latest.get("Adfbeskrivelse"),
            "last_observer": f"{latest.get('Fornavn','')} {latest.get('Efternavn','')}".strip(),
            "antal_individer": int(total_antal),
            "antal_observationer": num_observationer,
            "klokkeslet": klokkeslet,
            "obsidbirthtime": obsidbirthtime or "",
        }
        index.append(index_entry)
        # Gem hele tråden
        thread_dir = os.path.join(threads_dir, thread_id)
        os.makedirs(thread_dir, exist_ok=True)
        thread_data = {
            "thread": index_entry,
            "events": obs_list,
            "obsidbirthtime": obsidbirthtime or "",
        }
        with open(os.path.join(thread_dir, "thread.json"), "w", encoding="utf-8") as f:
            json.dump(thread_data, f, ensure_ascii=False, indent=2)

    # Gem index
    with open(os.path.join(base_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

def today_date_str() -> str:
    # Lokal tid, format DD-MM-YYYY
    return datetime.now().strftime("%d-%m-%Y")

def build_obsid_birthtimes(rows: List[Dict[str, str]], prev_birthtimes: dict) -> Dict[str, str]:
    """Returnér obsid -> første systemtid (HH:MM) for SU/SUB."""
    birthtimes = dict(prev_birthtimes)  # behold eksisterende
    now = datetime.now().strftime("%H:%M")
    for row in rows:
        if row.get("kategori") not in ("SU", "SUB"):
            continue
        obsid = (row.get("Obsid") or "").strip()
        if not obsid or obsid in birthtimes:
            continue
        birthtimes[obsid] = now
    return birthtimes


def fetch_excel_text() -> str:
    url = BASE_URL.format(date=today_date_str())
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()

    # Prøv robuste decodes (danske tegn)
    for enc in ("utf-8-sig", resp.encoding, "latin-1"):
        if not enc:
            continue
        try:
            return resp.content.decode(enc)
        except Exception:
            continue

    # Sidste udvej
    return resp.text


def sniff_delimiter(sample: str) -> str:
    sample = sample.replace("\r\n", "\n")
    try:
        dialect = csv.Sniffer().sniff(sample[:4096])
        return dialect.delimiter
    except Exception:
        # DOF "excel" er typisk tab- eller semikolon-separeret
        for delim in ("\t", ";", ","):
            if delim in sample:
                return delim
        return ","


def parse_rows_from_text(text: str) -> List[Dict[str, str]]:
    delim = sniff_delimiter(text)
    reader = csv.DictReader(io.StringIO(text), delimiter=delim)
    rows: List[Dict[str, str]] = []

    for row in reader:
        if row is None:
            continue
        # Trim whitespace i nøgler og værdier
        cleaned: Dict[str, str] = {}
        for k, v in row.items():
            if k is None:
                continue
            key = k.strip()
            val = v.strip() if isinstance(v, str) else ("" if v is None else str(v))
            cleaned[key] = val

        # Skip helt tomme linjer
        if not any(v for v in cleaned.values()):
            continue

        rows.append(cleaned)

    return rows

def send_update(rows: List[Dict[str, str]]) -> None:
    """Send en batch som JSON-array til serveren."""
    try:
        resp = requests.post(SERVER_URL, json=rows, timeout=50)
        resp.raise_for_status()
    except Exception as e:
        print(f"[watcher] Fejl ved POST: {e}")

def ensure_all_columns(row: Dict[str, str]) -> Dict[str, str]:
    """Returnér en ny dict med KUN de 38 kolonner og altid alle til stede."""
    return {col: (row.get(col, "") or "").strip() for col in COLUMNS}


def normalize_rows(rows: List[Dict[str, str]]) -> List[Dict[str, str]]:
    return [ensure_all_columns(r) for r in rows]


def parse_float(val: str) -> float:
    """Parse Antal (danske talformater). Bruges kun til diff-sammenligning."""
    if val is None:
        return 0.0
    s = str(val).strip()
    if s == "":
        return 0.0
    s = s.replace(".", "")  # fjern tusindtalsseparator
    s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return 0.0


def _key(row: Dict[str, str]) -> str:
    """Entydig nøgle for en observation i state: Art x Loknr."""
    return f"{(row.get('Artnavn') or '').strip()}\n{(row.get('Loknr') or '').strip()}"


def _obsid(row: Dict[str, str]) -> str:
    return (row.get("Obsid") or "").strip()


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
        return datetime.strptime(f"{date_str} {time_str}", "%d-%m-%Y %H:%M")
    except Exception:
        try:
            return datetime.strptime(date_str, "%d-%m-%Y")
        except Exception:
            return datetime.min


def load_state() -> Dict[str, Dict[str, object]]:
    """Læs watcherens interne state."""
    path = WATCH_STATE_FILE
    if os.path.exists(path) and os.path.getsize(path) > 0:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
        except Exception:
            pass
    return {}


def save_state(state: Dict[str, Dict[str, object]]) -> None:
    path = WATCH_STATE_FILE
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)


def _state_get_antal(state_val) -> float | None:
    """Håndter evt. gammel state-struktur."""
    if state_val is None:
        return None
    if isinstance(state_val, dict):
        return state_val.get("antal")
    # gammel: direkte tal
    try:
        return float(state_val)
    except Exception:
        return None


def _state_get_obsids(state_val) -> Set[str]:
    if isinstance(state_val, dict):
        obsids = state_val.get("obsids") or []
        if isinstance(obsids, list):
            return {str(x) for x in obsids if str(x)}
    return set()


def build_state(rows: List[Dict[str, str]]) -> Dict[str, Dict[str, object]]:
    """
    Byg ny state:
      key -> { 'antal': max_antal_for_key, 'obsids': [obsid1, obsid2, ...] }
    """
    by_key: Dict[str, Dict[str, object]] = {}
    for r in rows:
        k = _key(r)
        if not k.strip():
            continue
        antal = parse_float(r.get("Antal"))
        obsid = _obsid(r)
        entry = by_key.setdefault(k, {"antal": 0.0, "obsids": set()})
        # max antal
        if antal > entry["antal"]:
            entry["antal"] = antal
        # obsids (kun ikke-tomme)
        if obsid:
            entry["obsids"].add(obsid)
    # konverter sets til lister for JSON
    for k, v in by_key.items():
        v["obsids"] = sorted(list(v["obsids"]))
    return by_key


def get_changed_keys(
    old_state: Dict[str, Dict[str, object]],
    new_state: Dict[str, Dict[str, object]],
) -> Set[str]:
    """Keys hvor state er ændret: nye keys eller ændret antal (uanset op/ned)."""
    changed: Set[str] = set()
    old_keys = set(old_state.keys())
    new_keys = set(new_state.keys())
    # nye keys
    changed |= (new_keys - old_keys)
    # antal ændret
    for k in (new_keys & old_keys):
        old_antal = _state_get_antal(old_state.get(k))
        new_antal = _state_get_antal(new_state.get(k))
        if old_antal != new_antal:
            changed.add(k)
    return changed


def get_new_obsids_by_key(
    old_state: Dict[str, Dict[str, object]],
    new_state: Dict[str, Dict[str, object]],
) -> Dict[str, Set[str]]:
    """Find nye obsid’er pr. key: obsid i new_state men ikke i old_state."""
    result: Dict[str, Set[str]] = {}
    for k, v in new_state.items():
        new_ids = set(v.get("obsids") or [])
        old_ids = _state_get_obsids(old_state.get(k))
        diff = new_ids - old_ids
        if diff:
            result[k] = diff
    return result


def group_rows(rows: List[Dict[str, str]]) -> Tuple[Dict[str, List[Dict[str, str]]], Dict[str, Dict[str, str]]]:
    """Returnér (rows_by_key, rows_by_obsid)."""
    by_key: Dict[str, List[Dict[str, str]]] = {}
    by_obsid: Dict[str, Dict[str, str]] = {}
    for r in rows:
        k = _key(r)
        by_key.setdefault(k, []).append(r)
        oid = _obsid(r)
        if oid:
            by_obsid[oid] = r
    return by_key, by_obsid


def latest_row_for_key(k: str, rows_by_key: Dict[str, List[Dict[str, str]]]) -> Dict[str, str] | None:
    lst = rows_by_key.get(k) or []
    if not lst:
        return None
    return max(lst, key=_parse_dt_from_row)


def run_once() -> None:
    old_state = load_state()

    text = fetch_excel_text()
    parsed_rows = parse_rows_from_text(text)
    normalized_rows = normalize_rows(parsed_rows)
    # berig med kategori for SU/SUB/bemaerk/alm
    enriched_all = enrich_with_kategori(normalized_rows)

    birthtimes_path = os.path.join("web", "obsid_birthtimes.json")
    if os.path.exists(birthtimes_path):
        with open(birthtimes_path, "r", encoding="utf-8") as f:
            obsid_birthtimes = json.load(f)
    else:
        obsid_birthtimes = {}

    # Opdater med evt. nye obsid'er (brug systemtid)
    obsid_birthtimes = build_obsid_birthtimes(enriched_all, obsid_birthtimes)

    # Gem birthtimes
    with open(birthtimes_path, "w", encoding="utf-8") as f:
        json.dump(obsid_birthtimes, f, ensure_ascii=False, indent=2)

    today = today_date_str()
    save_threads_and_index(enriched_all, today)

    # grupper til opslag
    rows_by_key, rows_by_obsid = group_rows(enriched_all)

    new_state = build_state(enriched_all)

    # første sync: vi sender kun SU/SUB med nye obsid’er (alle er nye), statechanged=1 hvis ny key ellers 0
    if not old_state:
        batch_by_obsid: Dict[str, Dict[str, str]] = {}
        for k, v in new_state.items():
            obsids = v.get("obsids") or []
            for oid in obsids:
                row = rows_by_obsid.get(oid)
                if not row or row.get("kategori") not in ("SU", "SUB"):
                    continue
                r2 = dict(row)
                # ny key => state change
                r2["statechanged"] = 1
                batch_by_obsid[oid] = r2
        if batch_by_obsid:
            batch = group_and_sum_by_observer(list(batch_by_obsid.values()))
        else:
            batch = []

        # gem ny state
        save_state(new_state)

        if batch:
            send_update(batch)
            print(f"[watcher] Ændringer: {len(batch)} rækker sendt.")
        else:
            print("[watcher] Ingen ændringer.")

    # 1) state-ændringer (nye keys eller ændret antal)
    changed_keys = get_changed_keys(old_state, new_state)

    # 2) nye obsid’er pr. key
    new_obsids = get_new_obsids_by_key(old_state, new_state)

    # byg batch (deduplikér pr. Obsid)
    batch_by_obsid: Dict[str, Dict[str, str]] = {}

    # a) alle state-ændringer -> tag seneste række for key, statechanged=1
    for k in changed_keys:
        row = latest_row_for_key(k, rows_by_key)
        if not row:
            continue
        oid = _obsid(row)
        if not oid:
            # uden obsid deduplikerer vi ikke, men vi kan stadig sende
            r2 = dict(row)
            r2["statechanged"] = 1
            # brug key som pseudo-id for deduplikering
            batch_by_obsid.setdefault(f"KEY::{k}", r2)
        else:
            r2 = dict(row)
            r2["statechanged"] = 1
            batch_by_obsid[oid] = r2

    # b) SU/SUB: send alle nye obsid’er (uanset antal). statechanged=1 hvis key er i changed_keys, ellers 0
    for k, oid_set in new_obsids.items():
        for oid in oid_set:
            row = rows_by_obsid.get(oid)
            if not row:
                continue
            if row.get("kategori") not in ("SU", "SUB"):
                continue
            if oid in batch_by_obsid:
                continue
            r2 = dict(row)
            r2["statechanged"] = 1 if k in changed_keys else 0
            batch_by_obsid[oid] = r2

    batch = list(batch_by_obsid.values())

    # gem ny state
    save_state(new_state)

    if batch:
        send_update(batch)
        print(f"[watcher] Ændringer: {len(batch)} rækker sendt.")
    else:
        print("[watcher] Ingen ændringer.")

def main():
    parser = argparse.ArgumentParser(description="DOF watcher")
    parser.add_argument(
        "--watch",
        action="store_true",
        help="Kør i loop",
    )
    parser.add_argument(
        "-i",
        "--interval",
        type=int,
        default=60,
        help="Interval i sekunder (kun med --watch). Default 60.",
    )
    args = parser.parse_args()

    if not args.watch:
        run_once()
        return

    print(f"[watcher] Starter i watch-mode. Interval: {args.interval}s. Ctrl+C for stop.")
    try:
        while True:
            try:
                run_once()
            except Exception as e:
                print(f"[watcher] Fejl: {e}")
            time.sleep(max(1, args.interval))
    except KeyboardInterrupt:
        print("\n[watcher] Stopper.")


if __name__ == "__main__":
    main()