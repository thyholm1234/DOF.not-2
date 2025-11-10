// Version: 4.3.10.15 - 2025-11-10 21.52.00
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

  function linkify(text) {
    // Find alle http(s)://... links og lav dem til klikbare links
    return text.replace(
      /(https?:\/\/[^\s<]+)/g,
      url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`
    );
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
      // const antal = thread.antal_individer != null ? thread.antal_individer : '';
      const art = thread.art || '';
      const lok = thread.lok || '';
      // const dato = thread.last_ts_obs ? thread.last_ts_obs.split('T')[0] : '';
      // --- NYT: Lav link til artside og lokalitet ---
      let artnr = '';
      if (thread.Artnr) {
        artnr = String(thread.Artnr).padStart(5, '0');
      } else if (data.events && data.events.length && data.events[0].Artnr) {
        artnr = String(data.events[0].Artnr).padStart(5, '0');
      }
      const artLink = artnr
        ? `<a href="https://dofbasen.dk/danmarksfugle/art/${artnr}" target="_blank" rel="noopener">${art}</a>`
        : art;

      let loknr = '';
      if (thread.Loknr) {
        loknr = String(thread.Loknr).padStart(6, '0');
      } else if (data.events && data.events.length && data.events[0].Loknr) {
        loknr = String(data.events[0].Loknr).padStart(6, '0');
      }
      const lokLink = loknr
        ? `<a href="https://dofbasen.dk/poplok.php?loknr=${loknr}" target="_blank" rel="noopener">${lok}</a>`
        : lok;

      document.title = `${art} - ${lok}`;
      document.querySelector('title').textContent = `${art} - ${lok}`;
      let ogTitle = document.querySelector('meta[property="og:title"]');
      if (!ogTitle) {
        ogTitle = document.createElement('meta');
        ogTitle.setAttribute('property', 'og:title');
        document.head.appendChild(ogTitle);
      }
      ogTitle.setAttribute('content', `${art} - ${lok}`);

      $title.innerHTML = "";
      const titleRow = document.createElement('div');
      titleRow.className = "thread-title-row";

      // Titel
      const h2 = el('h2', '', '');
      h2.id = "thread-title";
      h2.innerHTML = `${artLink} - ${lokLink}`;
      titleRow.appendChild(h2);

      // Del-knap (🔗)cl
      const shareBtn = document.createElement('button');
      shareBtn.id = "thread-share-btn";
      shareBtn.textContent = "🔗 Del";
      shareBtn.className = "share-btn";
      shareBtn.style.margin = "0";
      shareBtn.onclick = () => {
        const shareUrl = window.location.href;
        const shareTitle = art ? `${art} - ${lok}` : document.title;
        if (navigator.share) {
          navigator.share({
            title: shareTitle,
            url: shareUrl
          });
        } else {
          navigator.clipboard.writeText(shareUrl);
          shareBtn.textContent = "Kopieret!";
          setTimeout(() => (shareBtn.textContent = "🔗 Del"), 1500);
        }
      };
      titleRow.appendChild(shareBtn);

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

          // --- Hent DKU-status, billeder og
          const infoRow = el('div', 'info');
          infoRow.textContent = `${ev.Adfbeskrivelse || ''} • ${ev.Fornavn || ''} ${ev.Efternavn || ''}`;
          obsRow.appendChild(infoRow);

          // Vandret streg under body
          obsRow.appendChild(el('hr', 'obs-hr'));

          // --- Hent DKU-status, billeder og lyd i ét kald ---
          if (ev.Obsid) {
            (async () => {
              try {
                const res = await fetch(`/api/obs/full?obsid=${encodeURIComponent(ev.Obsid)}`);
                if (res.ok) {
                  const data = await res.json();

                  // DKU-status badge
                  if (data.status && data.status.trim()) {
                    const dkuRow = el('div', 'note-row');
                    const badge = el('span', 'badge', 'DKU');
                    badge.style.marginRight = "8px";
                    badge.style.background = "rgba(0, 162, 255, 1)";
                    badge.style.color = "#fff";
                    badge.style.fontWeight = "bold";
                    dkuRow.appendChild(badge);
                    const statusSpan = el('span', 'dku-status-text', data.status);
                    dkuRow.appendChild(statusSpan);
                    // Find første turnote- eller obsnote-row, ellers indsæt sidst
                    const firstNote = Array.from(obsRow.children).find(
                      c => c.classList && c.classList.contains('note-row') &&
                        (c.textContent.startsWith('Turnote') || c.textContent.startsWith('Obsnote'))
                    );
                    if (firstNote) {
                      obsRow.insertBefore(dkuRow, firstNote);
                    } else {
                      obsRow.appendChild(dkuRow);
                    }
                  }

                  // Billeder
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

                  // Lydfiler
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
                }
              } catch {}
            })();
          }
          // --- DKU-status, billeder og lyd slut ---

          // Turnoter badge og tekst (hvis findes)
          if (ev.Turnoter) {
              const noteRow = el('div', 'note-row');
              const badge = el('span', 'badge', 'Turnote');
              badge.style.marginRight = "8px";
              noteRow.appendChild(badge);
              const noteText = document.createElement('span');
              noteText.className = 'note-text';
              noteText.innerHTML = linkify(ev.Turnoter.replace(/\n/g, '<br>'));
              noteRow.appendChild(noteText);
              obsRow.appendChild(noteRow);
          }

          // Fuglnoter badge og tekst (hvis findes)
          if (ev.Fuglnoter) {
              const noteRow = el('div', 'note-row');
              const badge = el('span', 'badge', 'Obsnote');
              badge.style.marginRight = "8px";
              noteRow.appendChild(badge);
              const noteText = document.createElement('span');
              noteText.className = 'note-text';
              noteText.innerHTML = linkify(ev.Fuglnoter.replace(/\n/g, '<br>'));
              noteRow.appendChild(noteText);
              obsRow.appendChild(noteRow);
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

      // --- WEBSOCKET CHAT/THUMBSUP ---
      await loadCommentsWebSocket();

      // Send kommentar via WebSocket
      document.getElementById('comment-send-btn').onclick = async () => {
        const btn = document.getElementById('comment-send-btn');
        const input = document.getElementById('comment-input');
        const body = input.value.trim();
        if (!body) return;

        btn.disabled = true;

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
          const subBtn = document.getElementById("thread-sub-btn");
          if (subBtn) subBtn.classList.add("is-on");
        }

        if (!obserkode || !navn) {
          alert("Du skal have udfyldt både obserkode og navn i dine indstillinger for at kunne skrive et indlæg.");
          btn.disabled = false;
          return;
        }

        wsSend({ type: "new_comment", navn, obserkode, body, user_id: userid, device_id: deviceid });
        input.value = "";
        btn.disabled = false;
      };

      // Automatisk højdeforøgelse af kommentar-input (textarea)
      const commentInput = document.getElementById('comment-input');
      if (commentInput) {
        commentInput.addEventListener('keydown', function(e) {
          if (
            (e.ctrlKey && e.key === 'Enter') || // Ctrl+Enter (Windows/Linux)
            (e.metaKey && e.key === 'Enter')    // Cmd+Enter (Mac)
          ) {
            document.getElementById('comment-send-btn').click();
            e.preventDefault();
          }
        });
        commentInput.addEventListener('input', function () {
          this.style.height = 'auto';
          this.style.height = (this.scrollHeight) + 'px';
        });
      }
  }


  // --- WEBSOCKET CHAT/THUMBSUP ---
  let ws;
  let wsReady = false;
  let wsQueue = [];
  function wsSend(obj) {
    if (wsReady) ws.send(JSON.stringify(obj));
    else wsQueue.push(obj);
  }

  async function loadCommentsWebSocket() {
    const day = getParam('date');
    const id = getParam('id');
    let commentsCard = document.getElementById('comments-section');
    const formCard = document.getElementById('comment-form');

    // Fjern eksisterende comments-section (så den ikke blinker)
    if (commentsCard) {
      commentsCard.remove();
      commentsCard = null;
    }

    // WebSocket setup
    if (ws) ws.close();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/thread/${day}/${id}`);
    wsReady = false;
    wsQueue = [];

    ws.onopen = () => {
      wsReady = true;
      wsQueue.forEach(obj => ws.send(JSON.stringify(obj)));
      wsQueue = [];
      ws.send(JSON.stringify({ type: "get_comments" }));
    };
    ws.onclose = () => { wsReady = false; };
    ws.onerror = () => { wsReady = false; };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      // Fjern evt. gammel sektion igen (hvis reload)
      let oldCard = document.getElementById('comments-section');
      if (oldCard) oldCard.remove();

      if (msg.type === "error" && msg.message) {
        alert(msg.message); // eller vis beskeden på anden måde
        return;
      }

      if (msg.type === "comments" && msg.comments && msg.comments.length) {
        // Opret og indsæt kun hvis der er kommentarer
        commentsCard = document.createElement('div');
        commentsCard.className = "card";
        commentsCard.id = "comments-section";
        commentsCard.innerHTML = "<h2>Kommentarer</h2><div id='comments-list'></div>";
        formCard.parentNode.insertBefore(commentsCard, formCard);

        const $list = commentsCard.querySelector('#comments-list');
        $list.innerHTML = "";
        msg.comments.forEach(c => {
          const row = document.createElement('div');
          row.className = "comment-row";
          row.innerHTML = `
            <div class="comment-title"><b>${c.navn}</b>, <span class="comment-time">${c.ts.split(' ')[1]}</span></div>
            <div class="comment-body">${linkify(c.body)}</div>
            <div class="comment-thumbs">👍 <span>${c.thumbs || 0}</span></div>
          `;
          row.querySelector('.comment-thumbs').onclick = () => {
            const userid = getOrCreateUserId ? getOrCreateUserId() : localStorage.getItem("userid");
            wsSend({ type: "thumbsup", ts: c.ts, user_id: userid });
          };
          $list.appendChild(row);
        });
      }
      if (msg.type === "new_comment" || msg.type === "thumbs_update") {
        ws.send(JSON.stringify({ type: "get_comments" }));
      }
    };
  }

  document.addEventListener('DOMContentLoaded', loadThread);
})();