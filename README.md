# DOF.not

**DOF.not** er en webapp til visning, filtrering og notifikationer om fugleobservationer fra DOFbasen. Brugere kan tilpasse præferencer pr. lokalafdeling, opsætte avancerede artsfiltre og modtage push-notifikationer om relevante observationer.

---

## Funktioner

- **Forside med dagens observationer**  
  Oversigt over dagens observationer, grupperet i tråde (art/lokalitet pr. dag).

- **Trådvisning**  
  Se detaljer for en tråd, inkl. alle observationer og kommentarer. Mulighed for at abonnere på tråde.

- **Brugerpræferencer**  
  Vælg for hver DOF-lokalafdeling, hvilke kategorier (SU, SUB, Bemærk, Ingen) du vil have notifikationer om.

- **Avanceret artsfiltrering**  
  Ekskludér specifikke arter eller sæt minimumsantal for notifikationer.

- **Push-notifikationer**  
  Modtag web push om nye relevante observationer direkte på din enhed.

- **Offline-support (PWA)**  
  Appen kan installeres og bruges offline.

---

## Filstruktur

### Web (frontend)

- **index.html** – Forside med tråde/observationer.
- **settings.html** – Brugerindstillinger og præferencer.
- **advanced.html** – Avanceret artsfiltrering.
- **traad.html** – Detaljer for én tråd (observationer + kommentarer).
- **opretbruger.html** – Oprettelse af bruger og indtastning af oplysninger.
- **style.css** – Styling og tema.
- **app.js** – Fælles logik (tema, bruger-id, præferencer, abonnement).
- **threads.js** – Håndtering og visning af tråde på forsiden.
- **traad.js** – Håndtering af tråd-detaljer og kommentarer.
- **advanced.js** – Avanceret artsfiltrering.
- **sw.js** – Service worker til offline-support og push-notifikationer.
- **manifest.webmanifest** – PWA-manifest.

### Backend (Python)

- **server/server.py** – FastAPI-server med API til præferencer, tråde, kommentarer, push-notifikationer m.m.
- **watcher.py** – Script der henter og beriger observationer fra DOFbasen og sender ændringer til serveren.

### Data

- **/web/data/arter_filter_klassificeret.csv** – Liste over arter og deres klassifikation (SU/SUB/Alm).
- **/web/data/*_bemaerk_parsed.csv** – Bemærk-tærskler pr. region/afdeling.
- **/web/obsid_birthtimes.json** – Første systemtid for observationer (bruges til trådvisning).

---

## Installation og brug

1. **Krav:**  
   - Python 3.10+  
   - FastAPI, Uvicorn, pywebpush, sqlite3

2. **Backend:**  
   Start serveren:
   ```sh
   cd server
   uvicorn server:app --reload --host 0.0.0.0 --port 8000 --log-level info --access-log
   ```

3. **Observation-watcher:**  
   Start watcher-scriptet (tjekker for nye observationer hvert 60. sekund):
   ```sh
   python watcher.py --watch -i 60
   ```

4. **Opdater version:**  
   Opdater versionsnummer i projektet:
   ```sh
   python update_version.py 3.3.2
   ```

5. **Frontend:**  
   Åbn `index.html` i din browser, eller tilgå via serverens webroot.

6. **Service worker & PWA:**  
   Appen kan installeres på mobil/desktop og fungerer offline.

---

## Udviklernoter

- **Push-notifikationer** kræver HTTPS i produktion.
- **Avanceret artsfiltrering** gemmes pr. bruger og kan eksporteres/importeres.
- **Kommentarer og tråde** kræver bruger-id (genereres automatisk ved første besøg).

---

## Licens

© Christian Vemmelund Helligsø  
Kun til privat/undervisningsbrug.