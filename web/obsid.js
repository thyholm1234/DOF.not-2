// Version: 4.9.12 - 2025-11-23 20.26.50
// © Christian Vemmelund Helligsø


function getObsIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("obsid") || "38040196";
}


function shareCoords(lat, lng) {
  const ua = navigator.userAgent || navigator.vendor || window.opera;
  const isIOS = /iphone|ipad|ipod/i.test(ua);
  const isMac = /macintosh|mac os x/i.test(ua);
  const isAndroid = /android/i.test(ua);

  if (isIOS || isMac) {
    // Apple Maps-link
    const appleMapsUrl = `https://maps.apple.com/?ll=${lat},${lng}`;
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

const obsid = getObsIdFromUrl();

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
        const isNaal = !!document.querySelector('#obs-map-card .badge-pin, .dofbasen-pin-note');
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

// 1. Læs CSV og lav map fra artsnavn til kategori
let arterKategoriMap = {};
async function loadArterKategoriMap() {
  if (Object.keys(arterKategoriMap).length) return;
  const res = await fetch('/data/arter_filter_klassificeret.csv');
  const text = await res.text();
  text.split('\n').forEach(line => {
    const [artsid, artsnavn, klassifikation] = line.trim().split(';');
    if (!artsnavn || artsnavn === "artsnavn") return;
    let navn = artsnavn.replace(/^\[|\]$/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
    let kat = (klassifikation || '').toLowerCase();
    arterKategoriMap[navn] = kat;
  });
}

// 2. Læs arter_dof_content.csv til map: artsnavn (renset/lowercase) -> {artsid, content}
let arterContentMap = {};
async function loadArterContentMap() {
  if (Object.keys(arterContentMap).length) return;
  const res = await fetch('/data/arter_dof_content.csv');
  const text = await res.text();
  text.split('\n').forEach(line => {
    const [artsid, artsnavn, content] = line.trim().split(';');
    if (!artsid || !artsnavn || artsnavn === "artsnavn") return;
    let navn = artsnavn.replace(/^\[|\]$/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
    arterContentMap[navn] = { artsid: artsid.padStart(5, '0'), content: content.trim() };
  });
}

// 3. Brug artsnavn til opslag
async function fetchAndRenderObs(obsid) {
  await loadArterKategoriMap();
  await loadArterContentMap();
  const res = await fetch(`/api/dofbasen?obsid=${encodeURIComponent(obsid)}`);
  if (!res.ok) {
    document.getElementById("main").innerHTML = "<h2>Observation ikke fundet</h2>";
    return;
  }
  const data = await res.json();

  // Find kategori fra map, fallback til data.kategori, ellers "alm"
  let kategori = "";
  if (data.art) {
    let navn = data.art.replace(/^\[|\]$/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
    kategori = arterKategoriMap[navn] || "";
  }
  if (!kategori && data.kategori) {
    kategori = (data.kategori || '').toLowerCase();
  }
  if (!kategori) kategori = "alm";

  // Find artsid og content fra arterContentMap
  let artLink = data.art || "Ukendt art";
  if (data.art) {
    // Rens artsnavn på samme måde som i loadArterContentMap
    let navn = data.art.replace(/^\[|\]$/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
    const entry = arterContentMap[navn];
    if (entry && entry.content === "1") {
      artLink = `<a href="https://dofbasen.dk/danmarksfugle/art/${entry.artsid}" target="_blank" rel="noopener">${data.art}</a>`;
    }
  }

  const titleHtml = `
    <div class="thread-header card">
      <div id="thread-title" class="thread-title">
        <div class="thread-title-row" id="thread-title-row">
          <h2 id="thread-title">
            ${artLink}
            ${data.loklink ? ` - <a href="${data.loklink}" target="_blank" rel="noopener">${data.loknavn || data.loklink}</a>` : (data.loknavn ? " - " + data.loknavn : "")}
          </h2>
        </div>
      </div>
    </div>
  `;

  const naal = data.naal && data.naal.lat && data.naal.lng
    ? `<a href="https://maps.google.com/?q=${data.naal.lat},${data.naal.lng}" target="_blank" class="badge badge-pin" title="Vis på Google Maps">Nål</a>`
    : "";
  const tid = data.turtid ? `<span class="badge">${data.turtid}</span>` : "";
  const adfaerd = data.adfaerd ? `<span class="adfaerd">${data.adfaerd}</span>` : "";
  const observatoer = data.navn
    ? (data.obserlink
        ? `<a href="${data.obserlink}" target="_blank" rel="noopener" class="observer-name">${data.navn}</a>`
        : `<span class="observer-name">${data.navn}</span>`)
    : "";
  const medobs = data.medobservatør
    ? `<div class="note-row"><span class="badge" style="margin-right: 8px;">Medobser</span><span class="note-text">${data.medobservatør}</span></div>`
    : "";
  const turnote = data.turnote
    ? `<div class="note-row"><span class="badge" style="margin-right: 8px;">Turnote</span><span class="note-text">${data.turnote}</span></div>`
    : "";
  const obsnote = data.obsnote
    ? `<div class="note-row"><span class="badge" style="margin-right: 8px;">Obsnote</span><span class="note-text">${data.obsnote}</span></div>`
    : "";
  const indtastet = data.indtastet
    ? `<div class="note-row"><span class="badge" style="margin-right: 8px;">Indtastet</span><span class="note-text">${data.indtastet}</span></div>`
    : "";

  // Billeder og lyd (samme stil som traad.js)
  let imagesHtml = "";
  if (data.images && data.images.length) {
    imagesHtml = data.images.map((url, idx) => `
      <div class="img-row">
        <span class="badge" style="margin-right:8px;">Pic#${idx + 1}</span>
        <a href="${url}" target="_blank" rel="noopener" class="obs-img-link">
          <img src="${url}" alt="Observation billede" style="max-width:120px;max-height:90px;">
        </a>
      </div>
    `).join("");
  }

  let soundHtml = "";
  if (data.sound_urls && data.sound_urls.length) {
    soundHtml = data.sound_urls.map((url, idx) => `
      <div class="sound-row">
        <span class="badge" style="margin-right:8px;">Rec#${idx + 1}</span>
        <audio controls style="vertical-align:middle;max-width:220px;" src="${url}${url.includes('?') ? '&raw=1' : '?raw=1'}"></audio>
      </div>
    `).join("");
  }

  // Indsæt billeder og lyd i eventHtml
  const eventHtml = `
    <div id="thread-events">
      <div class="obs-row">
        <div class="card-top">
          <div class="left">
            <span class="art-name cat-${kategori}">
              ${data.antal || ""} ${data.art || ""} ${data.latin ? `<span class="latin">(<i>${data.latin}</i>)</span>` : ""}
            </span>
          </div>
          <div class="right">
            ${naal}
            ${tid}
          </div>
        </div>
        <div class="info">
          ${adfaerd}
          ${adfaerd && observatoer ? '<span class="bullet">•</span>' : ''}
          ${observatoer}
        </div>
        <hr class="obs-hr">
        ${medobs}
        ${turnote}
        ${obsnote}
        ${indtastet}
        ${imagesHtml}
        ${soundHtml}
      </div>
    </div>
  `;

  // --- KORT: Først prøv naal, ellers vent ---
  let mapHtml = "";
  let mapLat = null, mapLng = null;
  let mapNote = "";
  let kortKilde = ""; // "naal" eller "lok"
  if (data.naal && data.naal.lat && data.naal.lng) {
    mapLat = data.naal.lat;
    mapLng = data.naal.lng;
    mapNote = "Placering for seneste nål i DOFbasen.";
    kortKilde = "naal";
    window.kortKilde = "naal";
  } else if (data.loknr && data.loknavn) {
    kortKilde = "lok";
    window.kortKilde = "lok";
  }

  if (mapLat && mapLng) {
    mapHtml = `
      <div class="card" id="obs-map-card" style="margin:1em 0;">
        <div id="obs-map" style="height:240px; width:100%;"></div>
        <div class="dofbasen-pin-note">${mapNote}</div>
      </div>
    `;
  }

  const html = titleHtml + mapHtml + eventHtml + `
    <div id="thread-status"></div>
  `;

  const main = document.getElementById("main");
  if (main) {
    main.innerHTML = html;

    const titleRow = document.getElementById("thread-title-row");
    if (titleRow) {
      const shareBtn = document.createElement('button');
      shareBtn.id = "thread-share-btn";
      shareBtn.textContent = "🔗 Del";
      shareBtn.className = "share-btn";
      shareBtn.style.margin = "0";
      const art = data.art || "";
      const lok = data.loknavn || "";
      let day = "";
      if (data.dato && /^\d{2}\/\d{2}\/\d{4}$/.test(data.dato)) {
        const [dd, mm, yyyy] = data.dato.split("/");
        day = `${yyyy}-${mm}-${dd}`;
      }
      const id = data.obstid_param || data.turtid || obsid;
      shareBtn.onclick = () => {
        const shareTitle = art ? `${art}${lok ? " - " + lok : ""}` : document.title;
        const fbShareUrl = `${location.origin}/share/obsid/${id}/`;
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
      titleRow.insertBefore(shareBtn, null);
    }

    const obsRow = document.querySelector('.obs-row');
    if (obsRow) {
      const obsLink = data.obstid_param || data.turtid || obsid;
      obsRow.style.cursor = "pointer";
      obsRow.tabIndex = 0; // Gør den også fokuserbar med tastatur
      obsRow.addEventListener('click', (e) => {
        if (e.target.closest('a,button,audio,img')) return;
        window.open(`https://dofbasen.dk/popobs.php?obsid=${obsLink}&summering=tur&obs=obs`, '_blank');
      });
      // Gør Enter/Space klikbar
      obsRow.addEventListener('keydown', (e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.target.closest('a,button,audio,img')) {
          window.open(`https://dofbasen.dk/popobs.php?obsid=${obsLink}&summering=tur&obs=obs`, '_blank');
        }
      });
    }

    if (mapLat && mapLng) {
      setTimeout(() => {
        
        window.map = L.map('obs-map').setView([lat, lng], 11);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '© OpenStreetMap'
        }).addTo(window.map);
        L.marker([lat, lng]).addTo(window.map);
        window.noteDiv = document.querySelector('.dofbasen-pin-note');
        startLiveGeolocation(lat, lng);

        // Navigér-knap
        if (window.noteDiv && mapLat && mapLng) {
          let navRow = document.createElement('div');
          navRow.className = "navigate-row";
          navRow.style.display = "flex";
          navRow.style.justifyContent = "flex-end";
          navRow.style.marginTop = "0.5em";
          window.noteDiv.parentNode.insertBefore(navRow, window.noteDiv.nextSibling);
          let shareBtn = document.createElement('button');
          shareBtn.id = "share-coords-btn";
          shareBtn.textContent = "Navigér";
          shareBtn.className = "share-btn";
          shareBtn.onclick = () => shareCoords(mapLat, mapLng);
          navRow.appendChild(shareBtn);
        }
        // Start live geolocation (opretter/udpér marker + afstand)
        startLiveGeolocation(mapLat, mapLng);
      }, 0);
    } else if (data.loknr) {
      // Hent koordinater asynkront og tilføj kortet dynamisk
      (async () => {
        try {
          const lokRes = await fetch(`/api/lok_koordinater?loknr=${encodeURIComponent(data.loknr)}`);
          if (lokRes.ok) {
            const lokData = await lokRes.json();
            if (lokData.ok && lokData.laengde && lokData.bredde) {
              // Sikrer korrekt rækkefølge: latitude (bredde), longitude (laengde)
              let lat = lokData.bredde;
              let lng = lokData.laengde;
              // Hvis værdierne er byttet om (fx bredde < laengde for DK), byt dem om
              if (lat < lng) {
                [lat, lng] = [lng, lat];
              }
              // Indsæt kortet under title
              const card = document.createElement('div');
              card.className = "card";
              card.id = "obs-map-card";
              card.style.margin = "1em 0";
              card.innerHTML = `
                <div id="obs-map" style="height:240px; width:100%;"></div>
                <div class="dofbasen-pin-note">Kortet viser midten af lokalitetens placering</div>
              `;
              // Find hvor kortet skal indsættes (efter .thread-header.card)
              const threadHeader = document.querySelector('.thread-header.card');
              if (threadHeader && threadHeader.parentNode) {
                threadHeader.parentNode.insertBefore(card, threadHeader.nextSibling);
                setTimeout(() => {
                  
                  window.map = L.map('obs-map').setView([lat, lng], 11);
                  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    maxZoom: 19,
                    attribution: '© OpenStreetMap'
                  }).addTo(window.map);
                  L.marker([lat, lng]).addTo(window.map);
                  window.noteDiv = document.querySelector('.dofbasen-pin-note');
                  startLiveGeolocation(lat, lng);


                  // Tilføj brugerens placering og beregn afstand
                  const noteDiv = document.querySelector('.dofbasen-pin-note');
                  if (noteDiv && lat && lng) {
                    // Tilføj "Del koordinater"-knap under note
                    let navRow = document.createElement('div');
                    navRow.className = "navigate-row";
                    navRow.style.display = "flex";
                    navRow.style.justifyContent = "flex-end";
                    navRow.style.marginTop = "0.5em";
                    noteDiv.parentNode.insertBefore(navRow, noteDiv.nextSibling);

                    let shareBtn = document.createElement('button');
                    shareBtn.id = "share-coords-btn";
                    shareBtn.textContent = "Navigér";
                    shareBtn.className = "share-btn";
                    shareBtn.onclick = () => shareCoords(lat, lng);
                    navRow.appendChild(shareBtn);
                  }

                  if (userPosition && noteDiv) {
                    L.marker([userPosition.lat, userPosition.lng], {
                      title: "Din placering",
                      icon: L.icon({
                        iconUrl: "https://notifikation.dofbasen.dk/icons/bino-64.png",
                        iconSize: [32, 32],
                        iconAnchor: [16, 16]
                      })
                    }).addTo(map).bindPopup("Din placering");

                    // Beregn afstand (Haversine)
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

                    const d = haversine(userPosition.lat, userPosition.lng, lat, lng);
                    let distTxt = d > 1000 ? (d/1000).toFixed(2).replace('.', ',') + " km" : Math.round(d) + " m";
                    noteDiv.textContent = `Kortet viser midten af lokalitetens placering. Afstand: ${distTxt}`;
                  }
                }, 0);
              }
            }
          }
        } catch (e) {
          // ignorer fejl
        }
      })();
    }

    // Forhindr klik på billede/lyd åbner obs-linket
    document.querySelectorAll('.obs-img-link, .sound-row audio').forEach(el => {
      el.addEventListener('click', e => e.stopPropagation());
    });
  }
}

fetchAndRenderObs(obsid);

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