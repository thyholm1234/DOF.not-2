(function () {
  function el(tag, cls, text) {
    const x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text != null) x.textContent = text;
    return x;
  }
  function catClass(kat) { return `badge cat-${String(kat||'').toLowerCase()}`; }
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

  async function loadThreads() {
    const day = getDayFromUrl();
    const indexUrl = `/api/threads/${day}`;
    const $cards = document.getElementById('threads-cards') || document.getElementById('threads-list');
    const $status = document.getElementById('threads-status');
    if (!$cards) {
      console.error("Elementet #threads-cards eller #threads-list findes ikke i DOM!");
      return;
    }
    if (!$status) {
      console.error("Elementet #threads-status findes ikke i DOM!");
      return;
    }
    $cards.innerHTML = '';
    $status.textContent = 'Henter tråde…';

    let threads = [];
    try {
      const r = await fetch(indexUrl, { cache: 'no-store' });
      if (r.ok) threads = await r.json();
      else $status.textContent = `Kunne ikke hente tråde (HTTP ${r.status})`;
    } catch (e) {
      $status.textContent = 'Fejl ved hentning af tråde.';
      console.error(e);
      return;
    }
    if (!Array.isArray(threads) || !threads.length) {
      $status.textContent = 'Ingen tråde fundet for denne dag.';
      return;
    }
    $status.textContent = '';

    threads.sort((a, b) => (b.last_ts_obs || '').localeCompare(a.last_ts_obs || '')).reverse();

    for (const t of threads) {
      const card = el('div', 'card thread-card');
      card.style.cursor = 'pointer';
      card.tabIndex = 0;
      card.onclick = () => {
        // Åbn tråden i ny fane eller modal
        window.location.href = `traad.html?date=${day}&id=${t.thread_id}`;
        // Eller: window.location.href = `thread.html?date=${day}&id=${t.thread_id}`;
      };

      card.appendChild(el('div', catClass(t.last_kategori), String(t.last_kategori || '').toUpperCase()));
      card.appendChild(el('div', 'art', t.art || ''));
      card.appendChild(el('div', 'lok', t.lok || ''));
      card.appendChild(el('div', 'region', `Lokalafdeling: ${t.region || ''}`));
      card.appendChild(el('div', 'antal-individer', `Antal individer: ${t.antal_individer ?? ''}`));
      card.appendChild(el('div', 'antal-observationer', `Antal observationer: ${t.antal_observationer ?? ''}`));
      card.appendChild(el('div', 'klokkeslet', `Klokkeslet: ${t.klokkeslet || ''}`));
      card.appendChild(el('div', 'antal', `Sidste adfærd: ${t.last_adf || ''}`));
      card.appendChild(el('div', 'observer', t.last_observer || ''));
      card.appendChild(el('div', 'age', fmtAge(t.last_ts_obs)));

      $cards.appendChild(card);
    }
  }

  document.addEventListener('DOMContentLoaded', loadThreads);
})();