import argparse
import io
import csv
import json
import glob
import time
import os
import re
import requests
from datetime import datetime, timedelta
from typing import List, Dict, Tuple, Set
from collections import defaultdict
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# DOF "excel"-endpoint. Dato indsættes dynamisk i DD-MM-YYYY
BASE_URL = (
    "https://dofbasen.dk/excel/search_result1.php"
    "?design=excel&soeg=soeg&periode=dato&dato={date}&obstype=observationer&species=alle&sortering=dato"
)

# Server endpoint der modtager JSON-array af ændrede observationer (hver med alle 38 kolonner + 'kategori')
SERVER_URL = "http://localhost:8000/api/update"
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

class SyncHandler(FileSystemEventHandler):
    def on_modified(self, event):
        if event.src_path.endswith("request_sync.json"):
            try:
                with open(event.src_path, "r", encoding="utf-8") as f:
                    req = json.load(f)
            except FileNotFoundError:
                print(f"[watcher] (watchdog) Filen {event.src_path} findes ikke (måske allerede slettet).")
                return
            except Exception as e:
                print(f"[watcher] (watchdog) Fejl ved læsning af {event.src_path}: {e}")
                return
            sync = (req.get("sync") or "").lower()
            today = datetime.now().strftime("%d-%m-%Y")
            yesterday = (datetime.now() - timedelta(days=1)).strftime("%d-%m-%Y")
            if sync == "today":
                print("[watcher] (watchdog) Sync-request: i dag")
                run_once(today, send_notifications=True)
            elif sync == "yesterday":
                print("[watcher] (watchdog) Sync-request: i går")
                run_once(yesterday, send_notifications=False)
            elif sync == "both":
                print("[watcher] (watchdog) Sync-request: både i dag og i går")
                run_once(today, send_notifications=True)
                run_once(yesterday, send_notifications=False)
            else:
                print(f"[watcher] (watchdog) Sync-request: ukendt værdi '{sync}'")
            try:
                os.remove(event.src_path)
                print(f"[watcher] (watchdog) Slettede {event.src_path}")
            except Exception as e:
                print(f"[watcher] (watchdog) Kunne ikke slette sync-request: {e}")

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

def load_faenologi_perioder() -> Dict[str, List[Tuple[str, str]]]:
    """Indlæs faenologi.csv -> artsnavn -> [(datofra, datotil), ...]"""
    path = os.path.join(DATA_DIR, "faenologi.csv")
    mapping: Dict[str, List[Tuple[str, str]]] = {}
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f, delimiter=";")
            for row in reader:
                art = (row.get("Artnavn") or "").strip()
                fra = (row.get("Datofra") or "").strip()
                til = (row.get("Datotil") or "").strip()
                if not art or not fra or not til:
                    continue
                mapping.setdefault(art, []).append((fra, til))
    except Exception as e:
        print(f"[watcher] Kunne ikke læse faenologi-fil: {e}")
    return mapping

KLASS_MAP = load_klassifikation_map()
BEMAERK_BY_REGION = build_bemaerk_maps()
FAENOLOGI_PERIODER = load_faenologi_perioder()

def _dato_in_faenologi_periode(obsdato: str, perioder: List[Tuple[str, str]]) -> bool:
    """Returnér True hvis obsdato (DD-MM-YYYY) ligger i en af perioderne (DD-MM til DD-MM)."""
    try:
        obs_dt = datetime.strptime(obsdato[:5], "%d-%m")
    except Exception:
        return False
    for fra, til in perioder:
        try:
            fra_dt = datetime.strptime(fra, "%d-%m")
            til_dt = datetime.strptime(til, "%d-%m")
        except Exception:
            continue
        # Periode over nytår?
        if fra_dt <= til_dt:
            if fra_dt <= obs_dt <= til_dt:
                return True
        else:
            # Fx 30-09 til 10-04 (over nytår)
            if obs_dt >= fra_dt or obs_dt <= til_dt:
                return True
    return False

def to_region_slug(dept: str) -> str:
    s = (dept or "").strip()
    if s.lower().startswith("dof "):
        s = s[4:]
    return slugify(s)

def compute_kategori(row: Dict[str, str]) -> str:
    art = (row.get("Artnavn") or "").strip()
    obsdato = (row.get("Dato") or "").strip()
    # 1) fænologi -> bemaerk
    perioder = FAENOLOGI_PERIODER.get(art)
    if perioder and obsdato and _dato_in_faenologi_periode(obsdato, perioder):
        return "bemaerk"
    # 2) bemærk-tærskel -> bemaerk
    region_slug = to_region_slug(row.get("DOF_afdeling") or "")
    thresholds = BEMAERK_BY_REGION.get(region_slug) or {}
    thr = thresholds.get(art)
    if thr is not None and parse_float(row.get("Antal")) >= float(thr):
        return "bemaerk"
    # 3) ellers SU/SUB
    klass = KLASS_MAP.get(art)
    if klass == "SU":
        return "SU"
    if klass == "SUB":
        return "SUB"
    # 4) standard
    return "alm"

def _select_representative_row_for_change(
    k: str, rows_by_key: Dict[str, List[Dict[str, str]]]
) -> Dict[str, str] | None:
    lst = rows_by_key.get(k) or []
    if not lst:
        return None
    # helst bemaerk
    b_rows = [r for r in lst if (r.get("kategori") or "").strip().lower() == "bemaerk"]
    if b_rows:
        return max(b_rows, key=_parse_dt_from_row)
    # ellers SU/SUB
    su_rows = [r for r in lst if (r.get("kategori") or "") in ("SU", "SUB")]
    if su_rows:
        return max(su_rows, key=_parse_dt_from_row)
    # ellers seneste
    return max(lst, key=_parse_dt_from_row)

def enrich_with_kategori(rows: List[Dict[str, str]]) -> List[Dict[str, str]]:
    for r in rows:
        r["kategori"] = compute_kategori(r)
        obsid = r.get("Obsid", "").strip()
        art = (r.get("Artnavn") or "").strip()
        loknr = (r.get("Loknr") or "").strip()
        tag = f"{slugify(art)}-{loknr}" if art and loknr else ""
        r["tag"] = tag
        kat = r["kategori"]  # <-- behold små bogstaver!
        obsdate = (r.get("Dato") or "").strip()
        # Formatér dato til DD-MM-YYYY hvis nødvendigt
        if re.match(r"^\d{4}-\d{2}-\d{2}$", obsdate):
            y, m, d = obsdate.split("-")
            obsdate_fmt = f"{d}-{m}-{y}"
        else:
            obsdate_fmt = obsdate
        dofnot_url = f"https://notifikation.dofbasen.dk/traad.html?date={obsdate_fmt}&id={slugify(art)}-{loknr}"
        dofbasen_url = f"https://dofbasen.dk/popobs.php?obsid={obsid}&summering=tur&obs=obs" if obsid else ""
        obsid_url = f"https://notifikation.dofbasen.dk/obsid.html?obsid={obsid}/"
        if kat in ("SU", "SUB"):
            r["url"] = dofnot_url
            r["url2"] = dofbasen_url
            r["obsid_url"] = obsid_url
        elif kat in ("alm", "bemaerk"):
            r["url"] = dofbasen_url
            r["obsid_url"] = obsid_url
            if "url2" in r:
                del r["url2"]
        else:
            r["url"] = ""
            if "url2" in r:
                del r["url2"]
            if "obsid_url" in r:
                del r["obsid_url"]
    return rows

def fix_smart_quotes(text: str) -> str:
    # Erstat Windows-1252 smart quotes og typiske fejltegn
    return (
        text.replace('\x93', '“')
            .replace('\x94', '”')
            .replace('\x91', '‘')
            .replace('\x92', '’')
            .replace('\x96', '-')   # En dash
            .replace('\x97', '—')  # Em dash
            .replace('\x85', '…')  # Ellipsis
            .replace('\x86', '†')
            .replace('\x87', '‡')
            .replace('\x8b', '‹')
            .replace('\x9b', '›')
            .replace('\x8c', 'Œ')
            .replace('\x9c', 'œ')
            .replace('\x80', '€')
            .replace('\x82', ',')
            .replace('\x84', '"')
            .replace('\x99', '™')
            .replace('\x9f', 'Ÿ')
    )

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

def _parse_obs_time(row):
    # Returner tuple (dato, tid, obsid) for sortering
    date = row.get("Dato", "")
    for field in ("Obstidfra", "Turtidfra", "Obstidtil", "Turtidtil"):
        t = (row.get(field) or "").strip()
        if t:
            return (date, t, row.get("Obsid", ""))
    return (date, "", row.get("Obsid", ""))



def save_threads_and_index(rows: List[Dict[str, str]], day: str):

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
        # Tilføj obsidbirthtime til hver observation i events (før vi finder latest_obsidbirthtime)
        for obs in obs_list:
            oid = obs.get("Obsid", "").strip()
            obs["obsidbirthtime"] = obsid_birthtimes.get(oid, "")

        # Find alle obsidbirthtimes blandt events i tråden
        # NYT: Tag kun obsidbirthtime for observationer UDEN klokkeslet
        obsidbirthtimes = [
            e.get("obsidbirthtime")
            for e in obs_list
            if (
                e.get("obsidbirthtime")
                and isinstance(e.get("obsidbirthtime"), str)
                and ":" in e.get("obsidbirthtime")
                and not (
                    (e.get("Obstidfra") or "").strip()
                    or (e.get("Turtidfra") or "").strip()
                    or (e.get("Obstidtil") or "").strip()
                    or (e.get("Turtidtil") or "").strip()
                )
            )
        ]
        def _birthtime_key(t):
            try:
                h, m = map(int, t.split(":"))
                return h * 60 + m
            except Exception:
                return -1
        latest_obsidbirthtime = ""
        if obsidbirthtimes:
            latest_obsidbirthtime = max(obsidbirthtimes, key=_birthtime_key)

        # Find seneste og første observation i tråden
        latest = max(obs_list, key=_parse_obs_time)
        earliest = min(obs_list, key=_parse_dt_from_row)

        obsidbirthtime = (latest.get("obsidbirthtime") or "").strip()
        if not obsidbirthtime:
            oid = latest.get("Obsid", "").strip()
            obsidbirthtime = obsid_birthtimes.get(oid, "")

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
            "obsidbirthtime": latest_obsidbirthtime,
        }
        index.append(index_entry)
        # Gem hele tråden
        thread_dir = os.path.join(threads_dir, thread_id)
        os.makedirs(thread_dir, exist_ok=True)
        thread_data = {
            "thread": index_entry,
            "events": obs_list,
            "obsidbirthtime": latest_obsidbirthtime,
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


def fetch_excel_text(date_str=None) -> str:
    if date_str is None:
        date_str = today_date_str()
    url = BASE_URL.format(date=date_str)
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
            # Fix smart quotes
            val = fix_smart_quotes(val)
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
    """Fælles nøgle for state og rows_by_key: Artnavn|Loknr (pipe)."""
    art = (row.get('Artnavn') or '').strip()
    lok = (row.get('Loknr') or '').strip()
    return f"{art}|{lok}" if art or lok else ""

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
        # Dit ønskede format bruger "max_antal"
        v = state_val.get("max_antal", state_val.get("antal"))
        try:
            return float(v) if v is not None else None
        except Exception:
            return None
    # gammel: direkte tal
    try:
        return float(state_val)
    except Exception:
        return None

def _state_get_obsids(state_val) -> Set[str]:
    """Træk alle obsid’er ud af obserkoder-mappet."""
    if not isinstance(state_val, dict):
        return set()
    obk = state_val.get("obserkoder")
    if not isinstance(obk, dict):
        # back-compat: hvis nogen gang 'obsids' findes
        obsids = state_val.get("obsids")
        if isinstance(obsids, list):
            return {str(x) for x in obsids if str(x)}
        return set()
    s: Set[str] = set()
    for lst in obk.values():
        if isinstance(lst, list):
            s.update(str(x) for x in lst if str(x))
    return s


def build_state(rows: List[Dict[str, str]]) -> Dict[str, dict]:
    """
    State pr. key (Artnavn|Loknr) i dit ønskede format:
      {"max_antal": float, "obserkoder": { <kode>: [obsid,...] }}
    """
    state: Dict[str, dict] = {}
    for r in rows:
        key = _key(r)
        if not key:
            continue
        antal = parse_float(r.get("Antal"))
        obserkode = (r.get("Obserkode") or "").strip()
        obsid = _obsid(r)
        if not obserkode or not obsid:
            # vi vil kun tracke obsid’er vi kender + kunne diff’e pr. observerkode
            continue
        entry = state.setdefault(key, {"max_antal": 0.0, "obserkoder": {}})
        if antal > entry["max_antal"]:
            entry["max_antal"] = antal
        entry["obserkoder"].setdefault(obserkode, set()).add(obsid)
    # konverter sets til sorteret liste for JSON
    for entry in state.values():
        for k in entry["obserkoder"]:
            entry["obserkoder"][k] = sorted(list(entry["obserkoder"][k]))
    return state


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
        new_ids = _state_get_obsids(v)
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


def run_once(date_str=None, send_notifications=True):
    old_state = load_state()

    text = fetch_excel_text(date_str)
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

    today = date_str or today_date_str()
    save_threads_and_index(enriched_all, today)

    # Hvis vi kører i date-mode (dvs. date_str er angivet), skal vi ikke sende notifikationer
    if date_str and not send_notifications:
        print(f"[watcher] Kørte i date-mode for {date_str}: kun threads/index skrevet.")
        return

    # grupper til opslag
    rows_by_key, rows_by_obsid = group_rows(enriched_all)

    new_state = build_state(enriched_all)

    # første sync: vi sender SU/SUB med nye obsid’er (alle er nye), og bemaerk kun hvis ny key (statechanged=1)
    if not old_state:
        batch_by_obsid: Dict[str, Dict[str, str]] = {}
        for k, v in new_state.items():
            obsids = v.get("obsids") or []
            for oid in obsids:
                row = rows_by_obsid.get(oid)
                if not row:
                    continue
                kategori = row.get("kategori")
                # SU/SUB: altid, bemaerk: kun hvis ny key
                if kategori not in ("SU", "SUB", "bemaerk"):
                    continue
                if kategori == "bemaerk":
                    # kun hvis ny key (første sync = alle keys er nye)
                    # så vi sender kun én bemaerk pr. key
                    if oid != obsids[0]:
                        continue
                r2 = dict(row)
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

    # a) statechanged = 1 -> send bemaerk + SU + SUB (repræsentativ række pr. key)
    for k in changed_keys:
        row = _select_representative_row_for_change(k, rows_by_key)
        if not row:
            continue
        kat = (row.get("kategori") or "").strip()
        if kat not in ("bemaerk", "SU", "SUB"):
            continue
        oid = _obsid(row)
        if not oid:
            r2 = dict(row)
            r2["statechanged"] = 1
            batch_by_obsid.setdefault(f"KEY::{k}", r2)
        else:
            r2 = dict(row)
            r2["statechanged"] = 1
            batch_by_obsid[oid] = r2

    # b) statechanged = 0, men nye obsid’er -> kun SU/SUB
    for k, oid_set in new_obsids.items():
        for oid in oid_set:
            row = rows_by_obsid.get(oid)
            if not row:
                continue
            kategori = (row.get("kategori") or "").strip()
            if kategori not in ("SU", "SUB"):
                continue
            if oid in batch_by_obsid:
                continue
            r2 = dict(row)
            r2["statechanged"] = 0
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
    parser.add_argument(
        "--date",
        type=str,
        default=None,
        help="Dato i format DD-MM-YYYY (hvis ikke angivet bruges dags dato)",
    )
    args = parser.parse_args()

    if not args.watch:
        # Hvis der gives en dato, send kun notifikationer hvis det er i dag
        today = datetime.now().strftime("%d-%m-%Y")
        send_notif = (args.date is None) or (args.date == today)
        run_once(args.date, send_notifications=send_notif)
        return

    print(f"[watcher] Starter i watch-mode. Interval: {args.interval}s. Ctrl+C for stop.")
    try:
        last_yesterday_run = 0
        while True:
            try:
                # 1. Kør for i dag (normal drift, med notifikationer)
                run_once(None, send_notifications=True)
                # 2. Kør for gårsdagen én gang i timen (uden notifikationer)
                now = time.time()
                if now - last_yesterday_run >= 3600:
                    yesterday = (datetime.now() - timedelta(days=1)).strftime("%d-%m-%Y")
                    run_once(yesterday, send_notifications=False)
                    last_yesterday_run = now

                # 3. Tjek for sync-request i server/request_sync.json
                sync_path = os.path.join("server", "request_sync.json")
                if os.path.exists(sync_path):
                    with open(sync_path, "r", encoding="utf-8") as f:
                        try:
                            req = json.load(f)
                            sync = (req.get("sync") or "").lower()
                        except Exception:
                            sync = ""
                    today = datetime.now().strftime("%d-%m-%Y")
                    yesterday = (datetime.now() - timedelta(days=1)).strftime("%d-%m-%Y")
                    if sync == "today":
                        print("[watcher] Sync-request: i dag")
                        run_once(today, send_notifications=True)
                    elif sync == "yesterday":
                        print("[watcher] Sync-request: i går")
                        run_once(yesterday, send_notifications=False)
                    elif sync == "both":
                        print("[watcher] Sync-request: både i dag og i går")
                        run_once(today, send_notifications=True)
                        run_once(yesterday, send_notifications=False)
                    else:
                        print(f"[watcher] Sync-request: ukendt værdi '{sync}'")
                    try:
                        os.remove(sync_path)
                        print(f"[watcher] Slettede {sync_path}")
                    except Exception as e:
                        print(f"[watcher] Kunne ikke slette sync-request: {e}")
            except Exception as e:
                print(f"[watcher] Fejl: {e}")
            time.sleep(max(1, args.interval))
    except KeyboardInterrupt:
        print("\n[watcher] Stopper.")




if __name__ == "__main__":
    path = "server"
    event_handler = SyncHandler()
    observer = Observer()
    observer.schedule(event_handler, path, recursive=False)
    observer.start()

    try:
        main()
    except KeyboardInterrupt:
        print("\n[watcher] Stopper (Ctrl+C).")
    finally:
        observer.stop()
        observer.join()
        print("[watcher] Lukket ned.")