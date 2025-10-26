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
    const isoStr = String(iso);
    const t = isoStr.includes('T')
      ? new Date(isoStr).getTime()
      : new Date(isoStr + "T00:00:00").getTime();
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
  function getParam(name) {
    const q = new URLSearchParams(location.search);
    return q.get(name) || '';
  }

  async function loadThread() {
    const day = getParam('date');
    const id = getParam('id');
    const $status = document.getElementById('thread-status');
    const $title = document.getElementById('thread-title');
    const $meta = document.getElementById('thread-meta');
    const $events = document.getElementById('thread-events');

    if (!day || !id) {
      $status.textContent = "Ingen tråd valgt.";
      return;
    }

    const url = `/api/thread/${day}/${id}`;
    $status.textContent = "Henter tråd...";
    $title.textContent = "";
    $meta.textContent = "";
    $events.innerHTML = "";

    let data;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error("Ikke fundet");
      data = await r.json();
    } catch (e) {
      $status.textContent = "Kunne ikke hente tråd.";
      return;
    }
    $status.textContent = "";

    // Vis tråd-header
    const thread = data.thread || {};
    $title.textContent = `${thread.art || ''} — ${thread.lok || ''}`;
    $meta.innerHTML = `
      <span class="${catClass(thread.last_kategori)}">${String(thread.last_kategori || '').toUpperCase()}</span>
      ${thread.region || ''} • ${thread.last_observer || ''} • ${fmtAge(thread.last_ts_obs)}
    `;

    // Vis alle events i tråden
    const events = data.events || [];
    if (!events.length) {
      $events.innerHTML = "<div class='card'>Ingen observationer i denne tråd.</div>";
      return;
    }
    for (const ev of events) {
      const card = el('div', 'card thread-event');
      card.appendChild(el('div', 'label', `Dato: ${ev.Dato || ''}`));
      card.appendChild(el('div', 'label', `Antal: ${ev.Antal || ''}`));
      card.appendChild(el('div', 'label', `Adfærd: ${ev.Adfbeskrivelse || ''}`));
      card.appendChild(el('div', 'label', `Observatør: ${ev.Fornavn || ''} ${ev.Efternavn || ''}`));
      card.appendChild(el('div', 'label', `Lokalitet: ${ev.Loknavn || ''}`));
      $events.appendChild(card);
    }
  }

  document.addEventListener('DOMContentLoaded', loadThread);
})();