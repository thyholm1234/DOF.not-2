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
    const t = new Date(iso).includes('T') ? new Date(iso).getTime() : new Date(iso + "T00:00:00").getTime();
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
    const $panel = document.getElementById('thread-panel');
    const $title = document.getElementById('thread-title');
    const $sub = document.getElementById('thread-sub');
    const $list = document.getElementById('thread-events');
    if (!day || !id) {
      $status.textContent = "Ingen tråd valgt.";
      $panel.style.display = "none";
      return;
    }
    const url = `./obs/${day}/threads/${id}/thread.json`;
    $status.textContent = "Henter tråd...";
    $panel.style.display = "";
    $title.textContent = "";
    $sub.textContent = "";
    $list.innerHTML = "";

    let data;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error("Ikke fundet");
      data = await r.json();
    } catch (e) {
      $status.textContent = "Kunne ikke hente tråd.";
      $panel.style.display = "none";
      return;
    }
    $status.textContent = "";

    // Vis tråd-header
    const thread = data.thread || {};
    $title.textContent = `${thread.art || ''} — ${thread.lok || ''}`;
    $sub.innerHTML = `
      <span class="${catClass(thread.last_kategori)}">${String(thread.last_kategori || '').toUpperCase()}</span>
      ${thread.region || ''} • ${thread.last_observer || ''} • ${fmtAge(thread.last_ts_obs)}
    `;

    // Vis alle events i tråden
    const events = data.events || [];
    for (const ev of events) {
      const li = el('li', 'thread-event');
      li.appendChild(el('div', 'dato', ev.Dato || ''));
      li.appendChild(el('div', 'antal', `Antal: ${ev.Antal || ''}`));
      li.appendChild(el('div', 'adf', ev.Adfbeskrivelse || ''));
      li.appendChild(el('div', 'obsnavn', `${ev.Fornavn || ''} ${ev.Efternavn || ''}`));
      li.appendChild(el('div', 'lok', ev.Loknavn || ''));
      $list.appendChild(li);
    }
  }

  document.addEventListener('DOMContentLoaded', loadThread);
})();