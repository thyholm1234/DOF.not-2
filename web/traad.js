// Version: 4.9.57 - 2025-11-30 15.57.17
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

  

  function ensureObsHr(obsRow) {
    if (!obsRow.querySelector('.obs-hr')) {
      obsRow.appendChild(el('hr', 'obs-hr'));
    }
  }

  function shareCoords(lat, lng) {
    const ua = navigator.userAgent || navigator.vendor || window.opera;
    const isIOS = /iphone|ipad|ipod/i.test(ua);
    const isMac = /macintosh|mac os x/i.test(ua);
    const isAndroid = /android/i.test(ua);

    if (isIOS || isMac) {
      // Apple Maps med destination
      const appleMapsUrl = `https://maps.apple.com/?daddr=${lat},${lng}`;
      window.location.href = appleMapsUrl;
    } else if (isAndroid) {
      // geo-link åbner Maps-app på Android
      const geoUrl = `geo:${lat},${lng}?q=${lat},${lng}`;
      window.location.href = geoUrl;
    } else {
      // Google Maps-link til desktop og andre platforme
      const url = `https://maps.google.com/?q=${lat},${lng}`;
      window.open(url, '_blank');
    }
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

  async function isAppUser(obserkode) {
      if (!obserkode) return false;
      try {
        const res = await fetch("/api/is-app-user", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ obserkode })
        });
        if (res.ok) {
          const data = await res.json();
          return !!data.is_app_user;
        }
      } catch {}
      return false;
  }

  async function isAppUserBulk(obserkoder) {
    // Bulk endpoint: POST {obserkoder: [kode1, kode2, ...]} => {kode1: true, kode2: false, ...}
    try {
      const res = await fetch("/api/is-app-user-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ obserkoder })
      });
      if (res.ok) return await res.json();
    } catch {}
    // fallback: return tomt map
    return {};
  }

  let userPosition = null; // behold variablen, hvis du bruger den senere

  // --- Globale referencer, så watchPosition kan opdatere kortet ---
  window.map = null;
  window.userMarker = null;
  window.noteDiv = null;
  window.geoWatchId = null;

  // Hjælpefunktioner til afstand
  function toRad(x) { return x * Math.PI / 180; }

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000; // meter
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1); // <- skal være longitude-difference
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  function formatDistanceMeters(d) {
    return d > 1000 ? (d/1000).toFixed(2).replace('.', ',') + " km" : Math.round(d) + " m";
  }

  // Starter eller opdaterer live geolocation
  
function startLiveGeolocation(targetLat, targetLng) {
    if (!navigator.geolocation) return;

    // Stop evt. gammel watch
    if (window.geoWatchId !== null) {
      navigator.geolocation.clearWatch(window.geoWatchId);
      window.geoWatchId = null;
    }

    let gotFirstFix = false;

    const applyPosition = (pos) => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;

      // Opret/udpér brugerens markør
      if (window.map) {
        if (!window.userMarker) {
          window.userMarker = L.marker([lat, lng], {
            title: "Din placering",
            icon: L.icon({
              iconUrl: "https://notifikation.dofbasen.dk/icons/bino-64.png",
              iconSize: [32, 32],
              iconAnchor: [16, 16]
            })
          }).addTo(window.map).bindPopup("Din placering");
        } else {
          window.userMarker.setLatLng([lat, lng]);
        }

        // Opdater note med live-afstand
        if (window.noteDiv && targetLat != null && targetLng != null) {
          const d = haversine(lat, lng, targetLat, targetLng);
          const distTxt = formatDistanceMeters(d);
          window.noteDiv.textContent =
            `${(window.kortKilde === "naal") ? "Placering for seneste nål i DOFbasen." : "Kortet viser midten af lokalitetens placering."} Afstand: ${distTxt}`;
        }
      }
    };

    const startWatch = (highAccuracy) => {
      const opts = {
        enableHighAccuracy: highAccuracy,
        timeout: highAccuracy ? 30000 : 8000,
        maximumAge: highAccuracy ? 0 : 15000
      };

      window.geoWatchId = navigator.geolocation.watchPosition(
        (pos) => {
          applyPosition(pos);

          // Skift til high accuracy efter første fix
          if (!gotFirstFix && !highAccuracy) {
            gotFirstFix = true;
            navigator.geolocation.clearWatch(window.geoWatchId);
            window.geoWatchId = null;
            startWatch(true); // Start GPS-watch
          }
        },
        (err) => console.error("Geolocation fejl:", err),
        opts
      );
    };

    // Start med lav præcision
    startWatch(false);
  }


  // Ryd watch ved unload (valgfrit)
  window.addEventListener('beforeunload', () => {
    if (window.geoWatchId !== null) {
      navigator.geolocation.clearWatch(window.geoWatchId);
      window.geoWatchId = null;
    }
  });

  async function loadThread() {
      await loadArterContentMap();
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

      // Find første event med obs_laengdegrad og obs_breddegrad
      let mapLat = null, mapLng = null;
      if (data.events && data.events.length) {
        for (const ev of data.events) {
          const lat = ev.obs_breddegrad && ev.obs_breddegrad.replace(',', '.');
          const lng = ev.obs_laengdegrad && ev.obs_laengdegrad.replace(',', '.');
          if (lat && lng && !isNaN(Number(lat)) && !isNaN(Number(lng))) {
            mapLat = Number(lat);
            mapLng = Number(lng);
            break;
          }
        }
      }

      let mapHtml = "";
      if (mapLat !== null && mapLng !== null) {
        mapHtml = `
          <div class="card" style="margin:1em 0;">
            <div id="thread-map" style="height:240px; width:100%;"></div>
            <div class="dofbasen-pin-note">Placering for seneste nål i DOFbasen.</div>
          </div>
        `;
      }

      // Kun lav link hvis content=1 for artnr
      let artLink = art;
      if (artnr && arterContentMap[artnr] === "1") {
        artLink = `<a href="https://dofbasen.dk/danmarksfugle/art/${artnr}" target="_blank" rel="noopener">${art}</a>`;
      }

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

      // Del-knap (🔗)
      const shareBtn = document.createElement('button');
      shareBtn.id = "thread-share-btn";
      shareBtn.textContent = "🔗 Del";
      shareBtn.className = "share-btn";
      shareBtn.style.margin = "0";
      shareBtn.onclick = () => {
        const shareTitle = art ? `${art} - ${lok}` : document.title;
        const fbShareUrl = `${location.origin}/share/${day}/${id}`;
        if (navigator.share) {
          navigator.share({
            title: shareTitle,
            url: fbShareUrl
          });
        } else {
          navigator.clipboard.writeText(fbShareUrl);
          shareBtn.textContent = "Link kopieret!";
          setTimeout(() => (shareBtn.textContent = "🔗 Del"), 1500);
        }
      };
      titleRow.appendChild(shareBtn);

      // Abonner-knap (🔔)
      const userid = getOrCreateUserId();
      const deviceid = localStorage.getItem("deviceid");
      let isSubscribed = false;
      try {
        const subRes = await fetch(`/api/thread/${day}/${id}/subscription`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: userid, device_id: deviceid })
        });
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

      $title.innerHTML = "";
      $title.appendChild(titleRow);

      // Find thread-header card (øverste card med titel og meta)
      const threadHeader = document.querySelector('.thread-header.card');

      if (mapLat !== null && mapLng !== null && mapHtml && threadHeader) {
        window.kortKilde = "naal";
        // Indsæt kort-card EFTER thread-header card
        const temp = document.createElement('div');
        temp.innerHTML = mapHtml;
        const mapCard = temp.firstElementChild;
        threadHeader.parentNode.insertBefore(mapCard, threadHeader.nextSibling);

        // Find note-div i kortet
        window.noteDiv = mapCard.querySelector('.dofbasen-pin-note');

        // Opret container til knap under noten
        let navRow = document.createElement('div');
        navRow.className = "navigate-row";
        navRow.style.display = "flex";
        navRow.style.justifyContent = "flex-end";
        navRow.style.marginTop = "0.5em";
        mapCard.appendChild(navRow);

        // Opret knappen
        let shareBtn = document.createElement('button');
        shareBtn.id = "share-coords-btn";
        shareBtn.textContent = "Navigér";
        shareBtn.className = "share-btn";
        shareBtn.onclick = () => shareCoords(mapLat, mapLng);
        navRow.appendChild(shareBtn);

        // Opret og vis Leaflet-kort + live-lokation og afstand
        setTimeout(() => {
          window.map = L.map('thread-map').setView([mapLat, mapLng], 12);
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap'
          }).addTo(window.map);
          L.marker([mapLat, mapLng]).addTo(window.map);

          // Start live geolocation (opretter/udpér markør + afstand)
          startLiveGeolocation(mapLat, mapLng);
        }, 0);
      }
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

      // --- NYT: Bulk fetch is-app-user for alle observere ---
      const observerCodes = Array.from(new Set(events.map(ev => (ev.Obserkode || ev.obserkode || "").trim().toUpperCase()).filter(Boolean)));
      const appUserMapRaw = observerCodes.length ? await isAppUserBulk(observerCodes) : {};
      const appUserMap = {};
      for (const k in appUserMapRaw) appUserMap[k.toUpperCase()] = appUserMapRaw[k];

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
          let adfaerd = ev.Adfbeskrivelse || '';
          let navn = `${ev.Fornavn || ''} ${ev.Efternavn || ''}`.trim();
          let obserkode = (ev.Obserkode || ev.obserkode || "").trim().toUpperCase();
          let obserlink = obserkode ? `https://dofbasen.dk/popobser.php?obserkode=${encodeURIComponent(obserkode)}` : "";

          const observerNameBadge = document.createElement('span');
          observerNameBadge.className = 'observer-name-badge';

          if (navn) {
            if (obserlink) {
              const nameLink = document.createElement('a');
              nameLink.href = obserlink;
              nameLink.target = "_blank";
              nameLink.rel = "noopener";
              nameLink.className = "observer-name";
              nameLink.textContent = navn;
              // Stop klik-bobling!
              nameLink.addEventListener('click', e => e.stopPropagation());
              observerNameBadge.appendChild(nameLink);
            } else {
              const nameSpan = document.createElement('span');
              nameSpan.className = "observer-name";
              nameSpan.textContent = navn;
              observerNameBadge.appendChild(nameSpan);
            }
          }

          // Indsæt badge synkront hvis appUserMap siger true
          if (appUserMap[obserkode]) {
            const badgeImg = document.createElement('img');
            badgeImg.src = "/icons/verified-symbol-icon.svg";
            badgeImg.alt = "App-bruger";
            badgeImg.title = "Denne observatør er registreret i appen";
            badgeImg.className = "verified-badge";
            observerNameBadge.appendChild(badgeImg);
          }

          if (adfaerd) {
            infoRow.innerHTML = `<span class="adfaerd">${adfaerd}</span> <span class="bullet">•</span>`;
            infoRow.appendChild(observerNameBadge);
          } else {
            infoRow.appendChild(observerNameBadge);
          }

          obsRow.appendChild(infoRow);

          // --- Hent DKU-status, billeder og lyd i ét kald ---
          if (ev.Obsid) {
            (async () => {
              try {
                const res = await fetch(`/api/obs/full?obsid=${encodeURIComponent(ev.Obsid)}`);
                if (res.ok) {
                  const data = await res.json();

                  // DKU-status badge
                  if (data.status && data.status.trim()) {
                    ensureObsHr(obsRow);
                    const dkuRow = el('div', 'note-row');
                    const badge = el('span', 'badge', 'DKU');
                    badge.style.background = "rgba(0, 162, 255, 1)";
                    badge.style.color = "#fff";
                    badge.style.fontWeight = "bold";
                    dkuRow.appendChild(badge);
                    // Tilføj både note-text og dku-status-text for ens layout
                    const statusSpan = el('span', 'note-text dku-status-text', data.status);
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
                    ensureObsHr(obsRow);
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
                    ensureObsHr(obsRow);
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

          if (ev.Medobser && ev.Medobser.trim()) {
            ensureObsHr(obsRow);
            const medobserRow = el('div', 'note-row');
            const badge = el('span', 'badge', 'Medobser');
            badge.style.marginRight = "8px";
            medobserRow.appendChild(badge);
            const medobserText = document.createElement('span');
            medobserText.className = 'note-text';
            medobserText.textContent = ev.Medobser;
            medobserRow.appendChild(medobserText);
            obsRow.appendChild(medobserRow);
          }

          // Turnoter badge og tekst (hvis findes)
          if (ev.Turnoter && ev.Turnoter.trim()) {
              ensureObsHr(obsRow);
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
          if (ev.Fuglnoter && ev.Fuglnoter.trim()) {
              ensureObsHr(obsRow);
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
          const res = await fetch('/api/userinfo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userid, device_id: deviceid })
          });
          if (res.ok) userinfo = await res.json();
        } catch {}
        const obserkode = userinfo.obserkode || "";
        const navn = userinfo.navn || "";

        // Tjek abonnement
        let isSubscribed = false;
        try {
          const subRes = await fetch(`/api/thread/${day}/${id}/subscription`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_id: userid, device_id: deviceid })
          });
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

  async function insertLokMapIfNeeded() {
    window.kortKilde = "lok";
    const threadHeader = document.querySelector('.thread-header.card');
    if (!threadHeader || document.getElementById('thread-map')) return;

    // Prøv at finde loknr fra linket i headeren
    const lokLink = document.querySelector('a[href*="poplok.php?loknr="]');
    let loknr = '';
    if (lokLink) {
      const m = lokLink.href.match(/loknr=(\d+)/);
      if (m) loknr = m[1];
    }
    if (!loknr) return;

    try {
      const lokRes = await fetch(`/api/lok_koordinater?loknr=${encodeURIComponent(loknr)}`);
      if (lokRes.ok) {
        const lokData = await lokRes.json();
        if (lokData.ok && lokData.laengde && lokData.bredde) {
          let lat = Number(lokData.bredde);
          let lng = Number(lokData.laengde);
          if (lat < lng) [lat, lng] = [lng, lat];
          const card = document.createElement('div');
          card.className = "card";
          card.style.margin = "1em 0";
          card.innerHTML = `
            <div id="thread-map" style="height:240px; width:100%;"></div>
            <div class="dofbasen-pin-note">Kortet viser midten af lokalitetens placering</div>
          `;
          threadHeader.parentNode.insertBefore(card, threadHeader.nextSibling);

          // Opret container til knap under noten
          let navRow = document.createElement('div');
          navRow.className = "navigate-row";
          navRow.style.display = "flex";
          navRow.style.justifyContent = "flex-end";
          navRow.style.marginTop = "0.5em";
          card.appendChild(navRow);

          // Opret knappen hvis ikke findes
          let shareBtn = document.createElement('button');
          shareBtn.id = "share-coords-btn";
          shareBtn.textContent = "Navigér";
          shareBtn.className = "share-btn";
          shareBtn.onclick = () => shareCoords(lat, lng);
          navRow.appendChild(shareBtn);

          setTimeout(() => {
            window.map = L.map('thread-map').setView([lat, lng], 12);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
              maxZoom: 19,
              attribution: '© OpenStreetMap'
            }).addTo(window.map);
            L.marker([lat, lng]).addTo(window.map);

            window.noteDiv = card.querySelector('.dofbasen-pin-note');
            // Start live geolocation (opretter/udpér markør + afstand)
            startLiveGeolocation(lat, lng);
          }, 0);
        }
      }
    } catch {}
  }

  async function loadThreadAndMap() {
    await loadThread();
    if (!document.getElementById('thread-map')) {
      await insertLokMapIfNeeded();
    }
  }

  let arterContentMap = {};

  async function loadArterContentMap() {
    if (Object.keys(arterContentMap).length) return; // Allerede loaded
    const res = await fetch('/data/arter_dof_content.csv');
    const text = await res.text();
    text.split('\n').forEach(line => {
      const [artsid, , content] = line.trim().split(';');
      if (artsid && content !== undefined) {
        arterContentMap[artsid.padStart(5, '0')] = content.trim();
      }
    });
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
          // Escape-funktion til at forhindre XSS
          function escapeHTML(str) {
            return String(str)
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#39;");
          }
          row.innerHTML = `
            <div class="comment-title"><b>${escapeHTML(c.navn)}</b>, <span class="comment-time">${escapeHTML(c.ts.split(' ')[1])}</span></div>
            <div class="comment-body">${linkify(escapeHTML(c.body))}</div>
            <div class="comment-thumbs" style="cursor:pointer;">👍 <span>${c.thumbs || 0}</span></div>
          `;
          row.querySelector('.comment-thumbs').onclick = () => {
            const userid = getOrCreateUserId ? getOrCreateUserId() : localStorage.getItem("userid");
            const deviceid = localStorage.getItem("deviceid");
            wsSend({ type: "thumbsup", ts: c.ts, user_id: userid, device_id: deviceid });
          };
          $list.appendChild(row);
        });
      }
      if (msg.type === "new_comment" || msg.type === "thumbs_update") {
        ws.send(JSON.stringify({ type: "get_comments" }));
      }
    };
  }

  document.addEventListener('DOMContentLoaded', loadThreadAndMap);

  function showIosLocationHintIfNeeded() {
    const ua = navigator.userAgent || navigator.vendor || window.opera;
    const isIOS = /iphone|ipad|ipod/i.test(ua);

    if (!isIOS) return;

    // Tjek om tilladelse allerede er givet
    if (navigator.permissions) {
      navigator.permissions.query({ name: 'geolocation' }).then(function(result) {
        if (result.state !== 'granted' && !localStorage.getItem('iosLocationHintShown')) {
          alert(
            "For at denne app kan vise din position, skal du tillade lokalitetstjenester:\n\n" +
            "Gå til Indstillinger → Safari → Lokation → Tillad"
          );
          localStorage.setItem('iosLocationHintShown', '1');
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', showIosLocationHintIfNeeded);
})();