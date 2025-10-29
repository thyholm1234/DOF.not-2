// Version: 3.3.4 - 2025-10-29 22.37.48
// © Christian Vemmelund Helligsø
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

      function linkify(text) {
        // Find alle http(s)://... links og lav dem til klikbare links
        return text.replace(
          /(https?:\/\/[^\s<]+)/g,
          url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`
        );
      }

      // Vis tråd-header som h2: Antal + Artnavn // Lok
      const thread = data.thread || {};
      // const antal = thread.antal_individer != null ? thread.antal_individer : '';
      const art = thread.art || '';
      const lok = thread.lok || '';
      // const dato = thread.last_ts_obs ? thread.last_ts_obs.split('T')[0] : '';
      document.title = `${art} - ${lok}`;
      $title.innerHTML = "";
const titleRow = document.createElement('div');
titleRow.className = "thread-title-row";

// Titel
const h2 = el('h2', '', `${art} - ${lok}`);
h2.id = "thread-title";
titleRow.appendChild(h2);

// Abonner-knap (🔔)
const userid = getOrCreateUserId();
const deviceid = localStorage.getItem("deviceid");
let isSubscribed = false;
try {
  const subRes = await fetch(`/api/thread/${day}/${id}/subscription?user_id=${encodeURIComponent(userid)}&device_id=${encodeURIComponent(deviceid)}`);
  if (subRes.ok) {
    const subData = await subRes.json();
    isSubscribed = !!subData.subscribed;
  }
} catch {}
const subBtn = document.createElement('button');
subBtn.id = "thread-sub-btn";
subBtn.textContent = "🔔 Abonner";
subBtn.className = "twostate";
if (isSubscribed) subBtn.classList.add("is-on");
titleRow.appendChild(subBtn);

$title.appendChild(titleRow);
$meta.innerHTML = "";

      subBtn.onclick = async () => {
        const userid = getOrCreateUserId();
        const deviceid = localStorage.getItem("deviceid");
        if (subBtn.classList.contains("is-on")) {
          await fetch(`/api/thread/${day}/${id}/unsubscribe`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_id: userid, device_id: deviceid })
          });
          subBtn.classList.remove("is-on");
        } else {
          await fetch(`/api/thread/${day}/${id}/subscribe`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_id: userid, device_id: deviceid })
          });
          subBtn.classList.add("is-on");
        }
      };

      // Vis alle events i tråden
      const events = data.events || [];
      if (!events.length) {
          $events.innerHTML = "<div class='card'>Ingen observationer i denne tråd.</div>";
          return;
      }

      

      // Sorter events efter tidspunkt (Obstidfra > Turtidfra > obsidbirthtime)
      events.sort((a, b) => {
          function getTime(ev) {
              return ev.Obstidfra || ev.Turtidfra || ev.obsidbirthtime || '';
          }
          const ta = getTime(a);
          const tb = getTime(b);
          if (!ta && !tb) return 0;
          if (!ta) return 1;
          if (!tb) return -1;
          // Faldende: byt rækkefølgen i localeCompare
          return tb.localeCompare(ta, 'da', { numeric: true });
      });

      for (const ev of events) {
          // Ydre container for én observation (række)
          const obsRow = el('div', 'obs-row');

          // Titelrække: Antal + Artnavn i samme felt (samlet <span>), klokkeslet-badge (højre)
          const titleRow = el('div', 'card-top');
          const left = el('div', 'left');
          // Antal og artnavn i ét samlet felt, fx "1 Korsnæb"
          left.innerHTML = `
              <span class="art-name cat-${(ev.kategori || '').toLowerCase()}">
                ${(ev.Antal ? ev.Antal + ' ' : '')}${ev.Artnavn || ''}
              </span>
          `;
          const right = el('div', 'right');

          // Nål-badge kun hvis obs-koordinater findes
          let pinBadge = '';
          if (ev.obs_breddegrad && ev.obs_laengdegrad) {
            const lat = ev.obs_breddegrad.replace(',', '.');
            const lng = ev.obs_laengdegrad.replace(',', '.');
            if (!isNaN(Number(lat)) && !isNaN(Number(lng))) {
              const gmaps = `https://maps.google.com/?q=${lat},${lng}`;
              pinBadge = `<a href="${gmaps}" target="_blank" class="badge badge-pin" title="Vis på Google Maps">Nål</a>`;
            }
          }
          if (pinBadge) {
            // Indsæt badge som HTML
            right.innerHTML = pinBadge;
            const badgeLink = right.querySelector('.badge-pin');
            if (badgeLink) {
              badgeLink.addEventListener('click', e => e.stopPropagation());
            }
          }

          const time = ev.Obstidfra || ev.Turtidfra || ev.obsidbirthtime || '';
          if (time) {
              const timeBadge = el('span', 'badge', time);
              right.appendChild(timeBadge);
          }
          titleRow.appendChild(left);
          titleRow.appendChild(right);
          obsRow.appendChild(titleRow);

          // Info-række: Adfærd, Fornavn + Efternavn
          const infoRow = el('div', 'info');
          infoRow.textContent = `${ev.Adfbeskrivelse || ''} • ${ev.Fornavn || ''} ${ev.Efternavn || ''}`;
          obsRow.appendChild(infoRow);

          // Vandret streg under body
          obsRow.appendChild(el('hr', 'obs-hr'));

          // --- DKU-status badge på eventet ---
          if (ev.Obsid) {
            try {
              // Bemærk: fetch er asynkront, så vi bruger en IIFE for at kunne bruge await
              (async () => {
                const statusRes = await fetch(`/api/obs/status?obsid=${encodeURIComponent(ev.Obsid)}`);
                if (statusRes.ok) {
                  const statusData = await statusRes.json();
                  if (statusData.status && statusData.status.trim()) {
                    const dkuRow = el('div', 'note-row');
                    const badge = el('span', 'badge', 'DKU');
                    badge.style.marginRight = "8px";
                    badge.style.background = "rgba(0, 162, 255, 1)";
                    badge.style.color = "#fff";
                    badge.style.fontWeight = "bold";
                    dkuRow.appendChild(badge);
                    const statusSpan = el('span', 'dku-status-text', statusData.status);
                    dkuRow.appendChild(statusSpan);
                    obsRow.appendChild(dkuRow);
                  }
                }
              })();
            } catch {}
          }
          // --- DKU-status badge slut ---

          // Turnoter badge og tekst (hvis findes)
          if (ev.Turnoter) {
              const noteRow = el('div', 'note-row');
              const badge = el('span', 'badge', 'Turnote');
              badge.style.marginRight = "8px";
              noteRow.appendChild(badge);
              const noteText = el('span', 'note-text', ev.Turnoter);
              noteRow.appendChild(noteText);
              obsRow.appendChild(noteRow);
          }

          // Fuglnoter badge og tekst (hvis findes)
          if (ev.Fuglnoter) {
              const noteRow = el('div', 'note-row');
              const badge = el('span', 'badge', 'Obsnote');
              badge.style.marginRight = "8px";
              noteRow.appendChild(badge);
              const noteText = el('span', 'note-text', ev.Fuglnoter);
              noteRow.appendChild(noteText);
              obsRow.appendChild(noteRow);
          }

                // Billeder: Hver får egen række med badge
          if (ev.Obsid) {
              fetch(`/api/obs/images?obsid=${encodeURIComponent(ev.Obsid)}`)
                  .then(r => r.json())
                  .then(data => {
                      if (data.images && data.images.length) {
                          data.images.forEach((url, idx) => {
                              const imgRow = el('div', 'img-row');
                              const badge = el('span', 'badge', `Pic#${idx + 1}`);
                              badge.style.marginRight = "8px";
                              imgRow.appendChild(badge);
                              const imgLink = document.createElement('a');
                              imgLink.href = url;
                              imgLink.target = "_blank";
                              imgLink.rel = "noopener";
                              const img = document.createElement('img');
                              img.src = url;
                              img.alt = "Observation billede";
                              img.style.maxWidth = "120px";
                              img.style.maxHeight = "90px";
                              imgLink.appendChild(img);
                              imgLink.addEventListener('click', e => e.stopPropagation());
                              imgRow.appendChild(imgLink);
                              obsRow.appendChild(imgRow);
                          });
                      }
                  })
                  .catch(() => { /* ignorer fejl */ });

              // Lydfiler: Hver får egen række med badge (under billeder)
              fetch(`/api/obs/sound?obsid=${encodeURIComponent(ev.Obsid)}`)
                .then(r => r.json())
                .then(data => {
                    if (data.sound_urls && data.sound_urls.length) {
                        data.sound_urls.forEach((url, idx) => {
                            const soundRow = el('div', 'sound-row');
                            const badge = el('span', 'badge', `Rec#${idx + 1}`);
                            badge.style.marginRight = "8px";
                            soundRow.appendChild(badge);
                            const audio = document.createElement('audio');
                            audio.controls = true;
                            audio.style.verticalAlign = "middle";
                            audio.style.maxWidth = "220px";
                            audio.src = url + (url.includes('?') ? '&raw=1' : '?raw=1');
                            audio.addEventListener('click', e => e.stopPropagation());
                            soundRow.appendChild(audio);
                            obsRow.appendChild(soundRow);
                        });
                    }
                })
                .catch(() => { /* ignorer fejl */ });
          }

          // Klik: Åbn url hvis findes
          if (ev.url) {
              obsRow.style.cursor = "pointer";
              const link = ev.url2 || ev.url;
              obsRow.addEventListener('click', () => window.open(link, '_blank'));
          }

          $events.appendChild(obsRow);
      }

      // Efter events vises

      // Kommentar input i separat card (ALTID vis)
      const formCard = document.createElement('div');
      formCard.className = "card";
      formCard.id = "comment-form";
      formCard.innerHTML = `
        <div class="comment-input-row">
          <textarea id="comment-input" rows="2" style="width:98%" placeholder="Skriv en kommentar..."></textarea>
          <div class="send-btn-row">
            <button id="comment-send-btn" class="comment-send-btn">Send</button>
          </div>
        </div>
      `;
      $events.parentNode.appendChild(formCard);

      // Kommentarsporet i et card (kun hvis der er kommentarer)
      async function loadComments() {
          const res = await fetch(`/api/thread/${day}/${id}/comments`);
          const comments = await res.json();
          let commentsCard = document.getElementById('comments-section');
          if (!comments.length) {
              // Fjern kommentarkortet hvis det findes
              if (commentsCard) commentsCard.remove();
              return;
          }
          // Hvis kortet ikke findes (fx efter første kommentar), opret det igen
          if (!commentsCard) {
              commentsCard = document.createElement('div');
              commentsCard.className = "card";
              commentsCard.id = "comments-section";
              commentsCard.innerHTML = "<h3>Kommentarer</h3><div id='comments-list'></div>";
              // Indsæt før formCard
              formCard.parentNode.insertBefore(commentsCard, formCard);
          }
          const $list = commentsCard.querySelector('#comments-list');
          $list.innerHTML = "";
          comments.forEach(c => {
              const row = document.createElement('div');
              row.className = "comment-row";
              row.innerHTML = `
                  <div class="comment-title"><b>${c.navn}</b>, <span class="comment-time">${c.ts.split(' ')[1]}</span></div>
                  <div class="comment-body">${linkify(c.body)}</div>
                  <div class="comment-thumbs">👍 <span>${c.thumbs || 0}</span></div>
              `;
              row.querySelector('.comment-thumbs').onclick = async () => {
                  const userid = getOrCreateUserId ? getOrCreateUserId() : localStorage.getItem("userid");
                  await fetch(`/api/thread/${day}/${id}/comments/thumbsup`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ ts: c.ts, user_id: userid })
                  });
                  await loadComments();
              };
              $list.appendChild(row);
          });
      }
      await loadComments();

      // Send kommentar (uændret)
      document.getElementById('comment-send-btn').onclick = async () => {
        const body = document.getElementById('comment-input').value.trim();
        if (!body) return;

        // Hent brugerinfo
        const userid = getOrCreateUserId();
        const deviceid = localStorage.getItem("deviceid");
        let userinfo = {};
        try {
          const res = await fetch(`/api/userinfo?user_id=${encodeURIComponent(userid)}&device_id=${encodeURIComponent(deviceid)}`);
          if (res.ok) userinfo = await res.json();
        } catch {}
        const obserkode = userinfo.obserkode || "";
        const navn = userinfo.navn || "";

        // Tjek abonnement
        let isSubscribed = false;
        try {
          const subRes = await fetch(`/api/thread/${day}/${id}/subscription?user_id=${encodeURIComponent(userid)}&device_id=${encodeURIComponent(deviceid)}`);
          if (subRes.ok) {
            const subData = await subRes.json();
            isSubscribed = !!subData.subscribed;
          }
        } catch {}

        // Hvis ikke abonneret, abonner automatisk
        if (!isSubscribed) {
          await fetch(`/api/thread/${day}/${id}/subscribe`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_id: userid, device_id: deviceid })
          });
          isSubscribed = true;
          // Opdater abonnér-knappen visuelt
          const subBtn = document.getElementById("thread-sub-btn");
          if (subBtn) subBtn.classList.add("is-on");
        }

        if (!obserkode || !navn) {
          alert("Du skal have udfyldt både obserkode og navn i dine indstillinger for at kunne skrive et indlæg.");
          return;
        }

        await fetch(`/api/thread/${day}/${id}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ navn, body, user_id: userid, device_id: deviceid })
        });
        document.getElementById('comment-input').value = "";
        await loadComments();
      };

      // Automatisk højdeforøgelse af kommentar-input (textarea)
      const commentInput = document.getElementById('comment-input');
      if (commentInput) {
        commentInput.addEventListener('input', function () {
          this.style.height = 'auto';
          this.style.height = (this.scrollHeight) + 'px';
        });
      }
  }

  document.addEventListener('DOMContentLoaded', loadThread);
})();