// Version: 3.3.1.7 - 2025-10-29 21.18.05
// © Christian Vemmelund Helligsø
(function () {
  function el(tag, cls, text) {
    const x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text != null) x.textContent = text;
    return x;
  }
  function catClass(kat) { return `cat-${String(kat||'').toLowerCase()}`; }
  function badgeClass(kat) { return `badge ${catClass(kat)}`; }
  function regionBadge(region) { return el('span', 'badge region', region); }
  function fmtAge(iso) {
    if (!iso) return '';
    const now = Date.now();
    const t = new Date(iso).getTime();
    const diff = Math.max(0, now - t);
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'nu';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h === 1) return `${h} time`;
    if (h < 24) return `${h} timer`;
    const d = Math.floor(h / 24);
    return `${d} d`;
  }
  function todayDMYLocal() {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  }
  function getDayFromUrl() {
    const q = new URLSearchParams(location.search);
    return q.get('date') || todayDMYLocal();
  }

  function fmtAgeFromKlokkeslet(klokkeslet, day, obsidbirthtime) {
    // Brug obsidbirthtime hvis klokkeslet mangler eller er tomt
    const k = klokkeslet || obsidbirthtime;
    if (!k) return '';
    const [dd, mm, yyyy] = (day || todayDMYLocal()).split('-');
    const [h, m] = k.split(':').map(Number);
    const obsDate = new Date(Number(yyyy), Number(mm) - 1, Number(dd), h, m);
    const now = new Date();
    let diff = (now - obsDate) / 60000; // minutter
    if (diff < 1) return 'nu';
    if (diff < 60) return `${Math.floor(diff)} min`;
    const hDiff = Math.floor(diff / 60);
    if (hDiff === 1) return '1 time';
    if (hDiff < 24) return `${hDiff} timer`;
    const dDiff = Math.floor(hDiff / 24);
    return `${dDiff} d`;
  }

  let userPrefs = {};
  let allThreads = [];
  let frontState = {
    usePrefs: true,
    onlySU: false,
    includeZero: true,
    sortMode: "nyeste",
    dayMode: "today", // "today" eller "yesterday"
    prioritizeComments: false // <-- NYT: tilføj denne linje
  };

  function shouldShowThread(t) {
    // Filtrér efter brugerpræferencer hvis valgt
    if (frontState.usePrefs && userPrefs && t.region && userPrefs[t.region]) {
      const kat = userPrefs[t.region];
      if (kat === "Ingen") return false;
      if (kat === "SU" && t.last_kategori !== "SU") return false;
      if (kat === "SUB" && !["SU", "SUB"].includes(t.last_kategori)) return false;
      if (kat === "Bemærk") {
        // Vis altid SU og SUB og Bemærk
        if (!["SU", "SUB", "Bemærk", "bemaerk"].includes((t.last_kategori||"").toUpperCase())) return false;
      }
    }
    // Kun SU hvis valgt
    if (frontState.onlySU && t.last_kategori !== "SU") return false;
    // Skjul 0-obs hvis valgt (både antal_observationer og antal_individer)
    const antalObs = Number(t.antal_observationer) || 0;
    const antalInd = Number(t.antal_individer) || 0;
    if (!frontState.includeZero && (antalObs < 1 || antalInd < 1)) return false;
    return true;
  }

  function renderThreads() {
  const $cards = document.getElementById('threads-cards');
  if (!$cards) return;
  $cards.innerHTML = '';
  // Filtrér kun tråde fra den aktuelle dag!
  let threads = allThreads.filter(
    t => (t._dofnot_dag === frontState.currentDay) && shouldShowThread(t)
  );

  // Sortering
  if (frontState.prioritizeComments) {
    // Ryk tråde med indlæg op, men bevar nuværende sortering indenfor grupperne
    threads.sort((a, b) => {
      const aHasComments = (a.comment_count || 0) > 0 ? 0 : 1;
      const bHasComments = (b.comment_count || 0) > 0 ? 0 : 1;
      if (aHasComments !== bHasComments) return aHasComments - bHasComments;
      // Bevar eksisterende sortering
      if (frontState.sortMode === "nyeste") {
        const dagA = a._dofnot_dag || a.day || todayDMYLocal();
        const dagB = b._dofnot_dag || b.day || todayDMYLocal();
        if (dagA !== dagB) return dagB.localeCompare(dagA, 'da');
        const klA = (a.klokkeslet || a.obsidbirthtime || "00:00").padStart(5, "0");
        const klB = (b.klokkeslet || b.obsidbirthtime || "00:00").padStart(5, "0");
        return klB.localeCompare(klA, 'da');
      } else if (frontState.sortMode === "alfabet") {
        return (a.art || '').localeCompare(b.art || '', 'da');
      }
      return 0;
    });
  } else if (frontState.sortMode === "nyeste") {
    threads.sort((a, b) => {
      const dagA = a._dofnot_dag || a.day || todayDMYLocal();
      const dagB = b._dofnot_dag || b.day || todayDMYLocal();
      if (dagA !== dagB) return dagB.localeCompare(dagA, 'da');
      const klA = (a.klokkeslet || a.obsidbirthtime || "00:00").padStart(5, "0");
      const klB = (b.klokkeslet || b.obsidbirthtime || "00:00").padStart(5, "0");
      return klB.localeCompare(klA, 'da');
    });
  } else if (frontState.sortMode === "alfabet") {
    threads.sort((a, b) => (a.art || '').localeCompare(b.art || '', 'da'));
  }

  for (const t of threads) {
    // <article>
    const article = el('article', 'card thread-card');
    article.tabIndex = 0;
    article.style.cursor = 'pointer';
    article.onclick = () => {
      window.location.href = `traad.html?date=${encodeURIComponent(t._dofnot_dag || getDayFromUrl())}&id=${t.thread_id}`;
    };

    // card-top
    const cardTop = el('div', 'card-top');
    const left = el('div', 'left');
    left.appendChild(el('span', badgeClass(t.last_kategori), String(t.last_kategori || '').toUpperCase()));
    if (t.region) left.appendChild(regionBadge(t.region));
    cardTop.appendChild(left);

    const right = el('div', 'right');

    // Kommentar-badge (rød, kun hvis mindst 1 kommentar)
    let commentCount = t.comment_count || 0;
    if (commentCount > 0) {
      right.appendChild(el('span', 'comment-count-badge', `${commentCount} indlæg`));
    }

    // Event-count badge (eksisterende)
    const obsCount = Number(t.antal_observationer ?? 0);
    const obsBadgeClass = obsCount > 1 ? 'badge event-count warn' : 'badge event-count';
    right.appendChild(el('span', obsBadgeClass, `${obsCount} obs`));
    right.appendChild(regionBadge(fmtAgeFromKlokkeslet(t.klokkeslet, t.day, t.obsidbirthtime)));
    cardTop.appendChild(right);

    article.appendChild(cardTop);

    // title
    const title = el('div', 'title');
    const titleLeft = el('div', 'title-left');
    const antalArtTekst = (t.antal_individer != null ? t.antal_individer + ' ' : '') + (t.art || '');
    titleLeft.appendChild(el('span', `art-name ${catClass(t.last_kategori)}`, antalArtTekst));
    title.appendChild(titleLeft);

    article.appendChild(title);

    // info
    const info = el('div', 'info');
    if (t.last_adf) info.appendChild(el('span', '', t.last_adf));
    if (t.lok) info.appendChild(el('span', '', t.lok));
    if (t.last_observer) info.appendChild(el('span', '', t.last_observer));
    article.appendChild(info);

    $cards.appendChild(article);
  }
}
  

  function setFrontState(key, value) {
  // Hvis man har klikket på "I dag"/"I går", så lås dagMode og tillad kun filtrering/sortering på den hentede dag
    const wasDayMode = key === "dayMode";
    frontState[key] = value;
    saveFrontState();
    updateFrontControls();

    // "I dag"/"I går" bestemmer ALTID hvilke tråde der vises (henter fra server)
    if (wasDayMode) {
      loadThreads();
    } else {
      // Andre filtre må kun ændre visning af allerede hentede tråde
      renderThreads();
    }
  }

  function updateFrontControls() {
    const fc = document.getElementById('front-controls');
    if (fc) {
      // SUB er default (grøn), SU er grøn når filtreret
      const suLabel = frontState.onlySU ? "SU" : "SUB";
      fc.innerHTML = `
        <button type="button" class="twostate${frontState.usePrefs ? ' is-on' : ''}" id="btn-prefs">Bruger</button>
        <button type="button" class="twostate${!frontState.onlySU ? ' is-on' : ''}" id="btn-su">${suLabel}</button>
        <button type="button" class="twostate${frontState.includeZero ? ' is-on' : ''}" id="btn-zero">0-obs</button>
        <button type="button" class="twostate${frontState.sortMode === 'nyeste' ? ' is-on' : ''}" id="btn-sort">${frontState.sortMode === 'nyeste' ? 'Nyeste' : 'Alfabet'}</button>
        <button type="button" class="twostate${frontState.dayMode === 'today' ? ' is-on' : ''}" id="btn-day">${frontState.dayMode === 'today' ? 'I dag' : 'I går'}</button>
        <button type="button" class="twostate${!frontState.prioritizeComments ? ' is-on' : ' is-off'}" id="btn-comments">Indlæg</button>
      `;
      fc.querySelector('#btn-prefs').onclick = () => setFrontState('usePrefs', !frontState.usePrefs);
      fc.querySelector('#btn-su').onclick = () => setFrontState('onlySU', !frontState.onlySU);
      fc.querySelector('#btn-zero').onclick = () => setFrontState('includeZero', !frontState.includeZero);
      fc.querySelector('#btn-sort').onclick = () => setFrontState('sortMode', frontState.sortMode === 'nyeste' ? 'alfabet' : 'nyeste');
      fc.querySelector('#btn-day').onclick = () => {
        setFrontState('dayMode', frontState.dayMode === 'today' ? 'yesterday' : 'today');
      };
      fc.querySelector('#btn-comments').onclick = () => setFrontState('prioritizeComments', !frontState.prioritizeComments);
    }
  }

  function saveFrontState() {
    localStorage.setItem('frontState', JSON.stringify(frontState));
  }
  
  function loadFrontState() {
    const s = localStorage.getItem('frontState');
    if (s) {
      try {
        const obj = JSON.parse(s);
        Object.assign(frontState, obj);
      } catch (e) {}
    }
  }

  async function loadThreads() {
    let day;
    if (frontState.dayMode === "today") {
      day = todayDMYLocal();
    } else {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 86400000);
      const dd = String(yesterday.getDate()).padStart(2, '0');
      const mm = String(yesterday.getMonth() + 1).padStart(2, '0');
      const yyyy = yesterday.getFullYear();
      day = `${dd}-${mm}-${yyyy}`;
    }
    frontState.currentDay = day; // <-- tilføj denne linje!
    saveFrontState(); // så den også gemmes
    // ...resten af funktionen uændret, brug kun én dag:
    const $cards = document.getElementById('threads-cards') || document.getElementById('threads-list');
    const $status = document.getElementById('threads-status');
    if (!$cards) return;
    
    try {
      const r = await fetch(`/api/threads/${day}`, { cache: 'no-store' });
      let threads = [];
      if (r.ok) {
        const arr = await r.json();
        if (Array.isArray(arr)) {
          arr.forEach(t => t._dofnot_dag = day);
          threads = arr;
        }
      }
      if (!Array.isArray(threads) || !threads.length) {
        if ($status) $status.textContent = '';
        $cards.innerHTML = ''; // Tøm listen hvis ingen tråde
        return;
      }
      if ($status) $status.textContent = '';
      allThreads = threads;
      $cards.innerHTML = ''; // <-- Tøm først nu!
      renderThreads();
    } catch (e) {
      if ($status) $status.textContent = 'Fejl ved hentning af tråde.';
      return;
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    loadFrontState(); // <-- tilføj denne linje
    // Hent brugerpræferencer
    try {
      const res = await fetch('/api/prefs?user_id=' + encodeURIComponent(localStorage.getItem('userid')));
      if (res.ok) userPrefs = await res.json();
    } catch (e) {}

    updateFrontControls();
    await loadThreads();
  });
})();