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

      // Vis tråd-header som h2: Antal + Artnavn // Lok
      const thread = data.thread || {};
      const antal = thread.antal_individer != null ? thread.antal_individer : '';
      const art = thread.art || '';
      const lok = thread.lok || '';
      const dato = thread.last_ts_obs ? thread.last_ts_obs.split('T')[0] : '';
      document.title = `${antal} ${art} // ${lok} // ${dato}`;
      $title.innerHTML = "";
      const h2 = el('h2', '', `${antal} ${art} // ${lok} // ${dato}`);
      $title.appendChild(h2);
      $meta.innerHTML = "";

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
      $meta.appendChild(subBtn);

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

          // Titelrække: Antal + Artnavn (venstre), klokkeslet-badge (højre)
          const titleRow = el('div', 'card-top');
          const left = el('div', 'left');
          left.innerHTML = `
              <span class="count ${catClass(ev.kategori).replace('badge ', '')}">${ev.Antal || ''}</span>
              <span class="art-name ${catClass(ev.kategori).replace('badge ', '')}">${ev.Artnavn || ''}</span>
          `;
          const right = el('div', 'right');
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

          // Turnoter badge og tekst (hvis findes)
          if (ev.Turnoter) {
              const noteRow = el('div', 'note-row');
              const badge = el('span', 'badge', 'Turnoter');
              badge.style.marginRight = "8px";
              noteRow.appendChild(badge);
              const noteText = el('span', 'note-text', ev.Turnoter);
              noteRow.appendChild(noteText);
              obsRow.appendChild(noteRow);
          }

          // Obsnoter badge og tekst (hvis findes)
          if (ev.Obsnoter) {
              const noteRow = el('div', 'note-row');
              const badge = el('span', 'badge', 'Obsnoter');
              badge.style.marginRight = "8px";
              noteRow.appendChild(badge);
              const noteText = el('span', 'note-text', ev.Obsnoter);
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
      const commentsDiv = document.createElement('div');
      commentsDiv.id = "comments-section";
      commentsDiv.innerHTML = "<h3>Kommentarer</h3><div id='comments-list'>Indlæser...</div>";
      $events.parentNode.appendChild(commentsDiv);

      // Hent og vis kommentarer
      async function loadComments() {
          const res = await fetch(`/api/thread/${day}/${id}/comments`);
          const comments = await res.json();
          const $list = document.getElementById('comments-list');
          if (!comments.length) {
              $list.innerHTML = "<em>Ingen kommentarer endnu.</em>";
              return;
          }
          $list.innerHTML = "";
          comments.forEach(c => {
              const row = document.createElement('div');
              row.className = "comment-row";
              row.innerHTML = `
                  <div class="comment-title"><b>${c.navn}</b>, <span class="comment-time">${c.ts.split(' ')[1]}</span></div>
                  <div class="comment-body">${c.body}</div>
                  <div class="comment-thumbs">👍 <span>${c.thumbs || 0}</span></div>
              `;
              // Eksempel på thumbs-up-knap i din kommentar-rendering:
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

      // Kommentar input
      const formDiv = document.createElement('div');
      formDiv.id = "comment-form";
      formDiv.innerHTML = `
          <textarea id="comment-input" rows="2" style="width:98%" placeholder="Skriv en kommentar..."></textarea>
          <button id="comment-send-btn">Send</button>
      `;
      commentsDiv.appendChild(formDiv);

      // Send kommentar
      document.getElementById('comment-send-btn').onclick = async () => {
          const body = document.getElementById('comment-input').value.trim();
          if (!body) return;
          // Hent navn fra server (eller localStorage hvis du ønsker det)
          let navn = "";
          try {
              const userid = getOrCreateUserId ? getOrCreateUserId() : localStorage.getItem("userid");
              const deviceid = localStorage.getItem("deviceid");
              const res = await fetch(`/api/userinfo?user_id=${encodeURIComponent(userid)}&device_id=${encodeURIComponent(deviceid)}`);
              if (res.ok) {
                  const userinfo = await res.json();
                  navn = userinfo.navn || "";
              }
          } catch {}
          if (!navn) navn = "Ukendt";
          await fetch(`/api/thread/${day}/${id}/comments`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ navn, body })
          });
          document.getElementById('comment-input').value = "";
          await loadComments();
      };
  }

  document.addEventListener('DOMContentLoaded', loadThread);
})();