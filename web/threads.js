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

  async function loadThreads() {
    const day = getDayFromUrl();
    const indexUrl = `/api/threads/${day}`;
    const $cards = document.getElementById('threads-cards') || document.getElementById('threads-list');
    const $status = document.getElementById('threads-status');
    if (!$cards) return;
    $cards.innerHTML = '';
    if ($status) $status.textContent = 'Henter tråde…';

    let threads = [];
    try {
      const r = await fetch(indexUrl, { cache: 'no-store' });
      if (r.ok) threads = await r.json();
      else if ($status) $status.textContent = `Kunne ikke hente tråde (HTTP ${r.status})`;
    } catch (e) {
      if ($status) $status.textContent = 'Fejl ved hentning af tråde.';
      return;
    }
    if (!Array.isArray(threads) || !threads.length) {
      if ($status) $status.textContent = 'Ingen tråde fundet for denne dag.';
      return;
    }
    if ($status) $status.textContent = '';

    threads.sort((a, b) => (b.last_ts_obs || '').localeCompare(a.last_ts_obs || '')).reverse();

    for (const t of threads) {
      // <article>
      const article = el('article', 'card thread-card');
      article.tabIndex = 0;
      article.style.cursor = 'pointer';
      article.onclick = () => {
        window.location.href = `traad.html?date=${day}&id=${t.thread_id}`;
      };

      // card-top
      const cardTop = el('div', 'card-top');
      const left = el('div', 'left');
      left.appendChild(el('span', badgeClass(t.last_kategori), String(t.last_kategori || '').toUpperCase()));
      if (t.region) left.appendChild(regionBadge(t.region));
      cardTop.appendChild(left);

      const right = el('div', 'right');
      right.appendChild(regionBadge(fmtAge(t.last_ts_obs)));
      cardTop.appendChild(right);

      article.appendChild(cardTop);

      // title
      const title = el('div', 'title');
      const titleLeft = el('div', 'title-left');
      titleLeft.appendChild(el('span', `count ${catClass(t.last_kategori)}`, t.antal_individer != null ? t.antal_individer : ''));
      titleLeft.appendChild(el('span', `art-name ${catClass(t.last_kategori)}`, t.art || ''));
      title.appendChild(titleLeft);

      const titleRight = el('div', 'title-right');
      titleRight.appendChild(el('span', 'badge event-count warn', `${t.antal_observationer ?? 0} obs`));
      title.appendChild(titleRight);

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

  document.addEventListener('DOMContentLoaded', loadThreads);
})();