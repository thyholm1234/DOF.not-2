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
  if (d > 10000) { // Over 10 km
    return Math.round(d / 1000) + " km";
  }
  return d > 1000
    ? (d / 1000).toFixed(1).replace('.', ',') + " km"
    : Math.round(d) + " m";
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

function autoGetUserLocationAndRender() {
  const $cards = document.getElementById('threads-cards');
  const loadingTexts = [
    "Tjekker hvor du gemmer dig...",
    "Leder efter dig i landskabet...",
    "Fløjter fugle frem...",
    "Lokker fuglene ud af busken...",
    "Vifter med brød for at tiltrække fugle..."
  ];
  let loadingIndex = Math.floor(Math.random() * loadingTexts.length);

  // Initial visning
  $cards.innerHTML = `
    <div id="loading-location" style="display:flex;align-items:center;justify-content:center;gap:0.5em;min-height:120px;">
      <div class="loader"></div>
      <span>${loadingTexts[loadingIndex]}</span>
    </div>
  `;

  // Skift loadingtext hvert 10. sekund
  const loadingInterval = setInterval(() => {
    loadingIndex = (loadingIndex + 1) % loadingTexts.length;
    const loadingDiv = document.getElementById('loading-location');
    if (loadingDiv) {
      loadingDiv.querySelector('span').textContent = loadingTexts[loadingIndex];
    }
  }, 10000);

  if (!navigator.geolocation) {
    clearInterval(loadingInterval);
    renderNearbyObservations(); // fallback hvis ikke muligt
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      clearInterval(loadingInterval);
      userPosition = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy
      };
      localStorage.setItem('lat', userPosition.lat);
      localStorage.setItem('lng', userPosition.lng);
      renderNearbyObservations();
    },
    (err) => {
      clearInterval(loadingInterval);
      $cards.innerHTML = '<div>Kunne ikke hente din lokation.</div>';
      renderNearbyObservations(); // fallback
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

function setupFrontControls() {
  const $controls = document.getElementById('front-controls');
  let mode = localStorage.getItem('obs_mode') || 'taettest';
  let showBemaerk = localStorage.getItem('show_bemaerk');
  if (showBemaerk === null) showBemaerk = 'true';
  localStorage.setItem('obs_mode', mode);

  $controls.innerHTML = `
    <div class="card" style="margin-bottom: 1em; display: flex; align-items: center; gap: 0.6em;">
      <button id="radius-refresh-btn" style="margin-bottom: 0em;"class="button">Opdater</button>
      <div style="display: flex; align-items: center; margin-left: auto; gap: 0.6em;">
        <label for="radius-input">Radius:</label>
        <input id="radius-input" class="radius-input" type="number" min="1" max="500" maxlength="3" value="${Math.min(parseInt(localStorage.getItem('radius_km')) || 50, 500)}">
        <span>km</span>
      </div>
    </div>
    <div class="card" style="display: flex; align-items: center; gap: 0.5em;">
      <button id="toggle-mode-btn" class="twostate ${mode === 'taettest' ? 'is-on' : ''}">${mode === 'nyeste' ? 'Nyeste' : 'Nærmeste'}</button>
      <button id="toggle-bemaerk-btn" class="twostate ${showBemaerk === 'true' ? 'is-on' : ''}">Bemærk</button>
    </div>
  `;

  const $toggleBtn = document.getElementById('toggle-mode-btn');
  const $bemaerkBtn = document.getElementById('toggle-bemaerk-btn');
  const $radiusBtn = document.getElementById('radius-refresh-btn');
  const $radiusInput = document.getElementById('radius-input');

  // Opdater-knap
  $radiusBtn.onclick = () => {
    let val = parseInt($radiusInput.value, 10);
    if (isNaN(val) || val < 1) val = 1;
    if (val > 500) val = 500;
    $radiusInput.value = val;
    localStorage.setItem('radius_km', val);
    renderNearbyObservations();
  };

  // Toggle-mode-knap
  $toggleBtn.onclick = () => {
    mode = (mode === 'nyeste') ? 'taettest' : 'nyeste';
    localStorage.setItem('obs_mode', mode);
    $toggleBtn.textContent = mode === 'nyeste' ? 'Nyeste' : 'Nærmeste';
    $toggleBtn.classList.toggle('is-on', mode === 'taettest');
    renderNearbyObservations();
  };

  // Bemaerk-knap
  $bemaerkBtn.onclick = () => {
    showBemaerk = showBemaerk === 'true' ? 'false' : 'true';
    localStorage.setItem('show_bemaerk', showBemaerk);
    $bemaerkBtn.classList.toggle('is-on', showBemaerk === 'true');
    renderNearbyObservations();
  };

  $radiusInput.addEventListener('keydown', (e) => {
    if (
      !(e.key >= '0' && e.key <= '9') &&
      e.key !== 'Backspace' &&
      e.key !== 'Delete' &&
      e.key !== 'ArrowLeft' &&
      e.key !== 'ArrowRight' &&
      e.key !== 'Tab' &&
      e.key !== 'Enter'
    ) {
      e.preventDefault();
    }
    if ($radiusInput.value.length >= 3 && !(e.key === 'Backspace' || e.key === 'Delete' || e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Tab')) {
      e.preventDefault();
    }
    if (e.key === 'Enter') {
      let val = parseInt($radiusInput.value, 10);
      if (isNaN(val) || val < 1) val = 1;
      if (val > 500) val = 500;
      $radiusInput.value = val;
      localStorage.setItem('radius_km', val);
      renderNearbyObservations();
    }
  });

  $radiusInput.addEventListener('blur', (e) => {
    let val = parseInt(e.target.value, 10);
    if (isNaN(val) || val < 1) val = 1;
    if (val > 500) val = 500;
    e.target.value = val;
    localStorage.setItem('radius_km', val);
  });

}

async function renderNearbyObservations() {
  const user_id = localStorage.getItem('userid') || '';
  const device_id = localStorage.getItem('deviceid') || '';
  const lat = parseFloat(localStorage.getItem('lat')) || null;
  const lng = parseFloat(localStorage.getItem('lng')) || null;
  const radius_km = localStorage.getItem('radius_km') || 15;
  const mode = localStorage.getItem('obs_mode') || 'nyeste';
  const $cards = document.getElementById('threads-cards');
  const $mapContainer = document.getElementById('map-container');
  const $mapDiv = document.getElementById('map');
  $cards.innerHTML = '<div>Henter observationer...</div>';
  try {
    const res = await fetch('/api/nearby-observations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id, device_id, lat, lng, radius_km, mode })
    });
    const data = await res.json();
    let observations = data.observations || [];
    const showBemaerk = localStorage.getItem('show_bemaerk') === 'true';

    // Filtrering: hvis Bemaerk er fra, vis kun SU og SUB
    if (!showBemaerk) {
      observations = observations.filter(obs =>
        obs.kategori && ['su', 'sub'].includes(obs.kategori.toLowerCase())
      );
    }

    // Sortering
    if (mode === 'nyeste') {
      observations.sort((a, b) => {
        // Sorter efter Dato og obsidbirthtime (nyeste først)
        if (a.Dato !== b.Dato) return b.Dato.localeCompare(a.Dato);
        return (b.obsidbirthtime || '').localeCompare(a.obsidbirthtime || '');
      });
    } else if (mode === 'taettest' && lat !== null && lng !== null) {
      observations.sort((a, b) => {
        function parseCoord(val) {
          if (!val) return NaN;
          return parseFloat(String(val).replace(',', '.'));
        }
        function getCoords(obs) {
          let latObs = parseCoord(obs.obs_breddegrad);
          let lngObs = parseCoord(obs.obs_laengdegrad);
          if (isNaN(latObs) || isNaN(lngObs)) {
            latObs = parseCoord(obs.lok_breddegrad);
            lngObs = parseCoord(obs.lok_laengdegrad);
          }
          return [latObs, lngObs];
        }
        const [alat, alng] = getCoords(a);
        const [blat, blng] = getCoords(b);
        const da = (!isNaN(alat) && !isNaN(alng)) ? haversine(lat, lng, alat, alng) : Infinity;
        const db = (!isNaN(blat) && !isNaN(blng)) ? haversine(lat, lng, blat, blng) : Infinity;
        return da - db;
      });
    }

    // Vis/skjul kort afhængigt af om der er observationer
    if (observations.length === 0) {
      if ($mapDiv) $mapDiv.style.display = "none";
      $cards.innerHTML = `
        <div style="text-align:center;opacity:0.7;padding:2em;">
          Ingen observationer i området.<br>
          Prøv at øge radius eller vælg en anden filtrering.
        </div>
      `;
      return;
    } else {
      if ($mapDiv) $mapDiv.style.display = "";
    }

    // Initialiser kun kortet én gang
    if (!window.map) {
      // Brug brugerens position hvis tilgængelig, ellers default
      const userLat = parseFloat(localStorage.getItem('lat'));
      const userLng = parseFloat(localStorage.getItem('lng'));
      const centerLat = (!isNaN(userLat)) ? userLat : 56;
      const centerLng = (!isNaN(userLng)) ? userLng : 10;

      const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '© OpenStreetMap'
      });
      const esriSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 18,
        attribution: 'Tiles © Esri'
      });

      window.map = L.map('map', {
        center: [centerLat, centerLng],
        zoom: 10,
        layers: [osm],
        fullscreenControl: true
      });

      L.control.layers(
        { 'Kort': osm, 'Satellit': esriSat },
        null,
        { position: 'topright', collapsed: false }
      ).addTo(window.map);
    }

    // Fjern gamle markører
    if (window.obsMarkers) {
      window.obsMarkers.forEach(m => window.map.removeLayer(m));
    }
    window.obsMarkers = [];

    // Fjern evt. gammel bruger-markør
    if (window.userMarker) {
      window.map.removeLayer(window.userMarker);
      window.userMarker = null;
    }

    // Saml observationer pr. lokation (kun lok koordinater)
    const lokationer = {};
    for (const obs of observations) {
      const lat = parseFloat((obs.lok_breddegrad || '').replace(',', '.'));
      const lng = parseFloat((obs.lok_laengdegrad || '').replace(',', '.'));
      if (isNaN(lat) || isNaN(lng)) continue;
      const key = `${lat},${lng}`;
      if (!lokationer[key]) lokationer[key] = { lat, lng, obs: [] };
      lokationer[key].obs.push(obs);
    }

    // Sortér lokationer: SU først, SUB bagefter, resten til sidst
    const sortedLokationer = Object.values(lokationer).sort((a, b) => {
    const katA = a.obs[0]?.kategori?.toLowerCase() || '';
    const katB = b.obs[0]?.kategori?.toLowerCase() || '';
    if (katA === 'su' && katB !== 'su') return -1;
    if (katA !== 'su' && katB === 'su') return 1;
    if (katA === 'sub' && katB !== 'sub') return -1;
    if (katA !== 'sub' && katB === 'sub') return 1;
    // Hvis A er SU eller SUB og B er Bemærk, skal SU/SUB først
    if ((katA === 'su' || katA === 'sub') && katB !== 'su' && katB !== 'sub') return -1;
    if ((katB === 'su' || katB === 'sub') && katA !== 'su' && katA !== 'sub') return 1;
    return 0;
  });

    // Tilføj markører for hver lokation
    const suLok = [];
const subLok = [];
const otherLok = [];

sortedLokationer.forEach(lok => {
  const hasSU = lok.obs.some(o => o.kategori && o.kategori.toLowerCase() === 'su');
  const hasSUB = lok.obs.some(o => o.kategori && o.kategori.toLowerCase() === 'sub');
  let markerIcon = undefined;
  let markerOptions = {};

  if (hasSU) {
    markerIcon = L.icon({
      iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png',
      iconSize: [25, 41],
      iconAnchor: [12, 41],
      popupAnchor: [1, -34],
      shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png'
    });
    markerOptions = { icon: markerIcon, zIndexOffset: 1000 };
  } else if (hasSUB) {
    markerIcon = L.icon({
      iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png',
      iconSize: [25, 41],
      iconAnchor: [12, 41],
      popupAnchor: [1, -34],
      shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png'
    });
    markerOptions = { icon: markerIcon, zIndexOffset: 1000 };
  }

  const marker = L.marker([lok.lat, lok.lng], markerIcon ? markerOptions : undefined).addTo(window.map)
    .bindPopup(
      lok.obs.map(o =>
        `<a href="${o.Obsid ? `https://notifikation.dofbasen.dk/obsid.html?obsid=${o.Obsid}` : '#'}" style="font-weight:bold;text-decoration:none;color:inherit;" target="_self">${o.Antal} ${o.Artnavn}</a><br>${o.Loknavn || ''}`
      ).join('<hr style="margin:6px 0;">')
    );
  window.obsMarkers.push(marker);
});

    // Zoom til markører hvis der er nogen
    const allCoords = Object.values(lokationer).map(l => [l.lat, l.lng]);
    const userLat = parseFloat(localStorage.getItem('lat'));
    const userLng = parseFloat(localStorage.getItem('lng'));

    let boundsCoords = allCoords.slice();
    if (!isNaN(userLat) && !isNaN(userLng)) {
      boundsCoords.push([userLat, userLng]);
    }

    if (boundsCoords.length) {
      const bounds = L.latLngBounds(boundsCoords);
      window.map.fitBounds(bounds, {padding: [30,30]});
    }

    // Vis brugerens position (hvis du har lat/lng fra bruger)
    if (!isNaN(userLat) && !isNaN(userLng)) {
      window.userMarker = L.marker([userLat, userLng], {
        icon: L.icon({
          iconUrl: "https://notifikation.dofbasen.dk/icons/bino-64.png",
          iconSize: [32, 32],
          iconAnchor: [16, 16]
        }),
        title: "Din placering"
      }).addTo(window.map).bindPopup("Din placering");
    }

    $cards.innerHTML = '';
    if (observations.length === 0) {
      $mapContainer.innerHTML = ''; // Fjern kortet hvis ingen data
      $cards.innerHTML = `
        <div style="text-align:center;opacity:0.7;padding:2em;">
          Ingen observationer i området.<br>
          Prøv at øge radius eller vælg en anden filtrering.
        </div>
      `;
      // Fjern evt. Leaflet-kort fra window
      if (window.map) {
        window.map.remove();
        window.map = null;
      }
      return;
    }



    for (const obs of observations) {
      const catClass = obs.kategori ? `cat-${obs.kategori.toLowerCase()}` : '';
      const region = obs.DOF_afdeling || '';
      const antalTxt = `${obs.Antal} ${obs.Artnavn}`;
      const observer = [obs.Fornavn, obs.Efternavn].filter(Boolean).join(' ');
      const adfaerd = obs.Adfbeskrivelse || '';
      const loknavn = obs.Loknavn || '';

      // Bestem farve for artsnavn
      let artColor = 'var(--col-alm)';
      if (obs.kategori && obs.kategori.toLowerCase() === 'su') artColor = 'var(--col-su)';
      else if (obs.kategori && obs.kategori.toLowerCase() === 'sub') artColor = 'var(--col-sub)';

      // Beregn afstand til bruger
      function parseCoord(val) {
        if (!val) return NaN;
        return parseFloat(String(val).replace(',', '.'));
      }
      let obsLat = parseCoord(obs.obs_breddegrad);
      let obsLng = parseCoord(obs.obs_laengdegrad);
      if (isNaN(obsLat) || isNaN(obsLng)) {
        obsLat = parseCoord(obs.lok_breddegrad);
        obsLng = parseCoord(obs.lok_laengdegrad);
      }
      let distanceTxt = '';
      if (lat !== null && lng !== null && !isNaN(obsLat) && !isNaN(obsLng)) {
        const dist = haversine(lat, lng, obsLat, obsLng);
        distanceTxt = formatDistanceMeters(dist);
      }

      // Udregn tid siden observation
      function timeSince(datoStr, birthtimeStr) {
        let obsDate;
        if (datoStr && birthtimeStr) {
          obsDate = new Date(`${datoStr}T${birthtimeStr}:00`);
        } else if (datoStr) {
          obsDate = new Date(`${datoStr}`);
        } else {
          return '';
        }
        const now = new Date();
        const diffMs = now - obsDate;
        const diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 1) return 'nu';
        if (diffMin < 60) return `${diffMin} min`;
        const diffH = Math.floor(diffMin / 60);
        if (diffH < 24) return diffH === 1 ? '1 time' : `${diffH} timer`;
        const diffD = Math.floor(diffH / 24);
        return diffD === 1 ? '1 dag' : `${diffD} dage`;
      }
      const timeAgoTxt = timeSince(obs.Dato, obs.obsidbirthtime);

      // Generér link
      let cardUrl = '';
      if (obs.kategori && (obs.kategori.toLowerCase() === 'sub' || obs.kategori.toLowerCase() === 'su')) {
        // SUB og SU
        function slugify(txt) {
          return txt
            .toString()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Fjern diakritiske tegn
            .replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa') // Dansk specialtegn
            .replace(/Æ/g, 'ae').replace(/Ø/g, 'oe').replace(/Å/g, 'aa')
            .replace(/[^a-zA-Z0-9]+/g, '-') // Erstat ikke-bogstaver med -
            .replace(/^-+|-+$/g, '') // Fjern - i starten/slutningen
            .toLowerCase();
        }
        const dateStr = obs.Dato ? obs.Dato.split('-').reverse().join('-') : '';
        const idStr = slugify(`${obs.Artnavn}-${obs.Loknr}`);
        cardUrl = `https://notifikation.dofbasen.dk/traad.html?date=${dateStr}&id=${idStr}`;
      } else {
        // BEMAERK og andre
        cardUrl = obs.Obsid ? `https://notifikation.dofbasen.dk/obsid.html?obsid=${obs.Obsid}` : '#';
      }

      const card = document.createElement('article');
      card.className = 'card thread-card';
      card.tabIndex = 0;
      card.style.cursor = 'pointer';
      card.onclick = () => window.location.href = cardUrl;
      card.innerHTML = `
        <div class="card-top">
          <div class="left">
            <span class="badge region">${region}</span>
          </div>
          <div class="right">
            <span class="badge event-count warn">${distanceTxt}</span>
            <span class="badge region">${timeAgoTxt}</span>
          </div>
        </div>
        <div class="title">
          <div class="title-left">
            <span class="art-name ${catClass}" style="color:${artColor}">${antalTxt}</span>
          </div>
        </div>
        <div class="info">
          <span class="adfaerd">${adfaerd}</span>
          <span class="bullet">•</span>
          <span>${loknavn}</span>
          <span class="bullet">•</span>
          <span class="observer-name">${observer}</span>
        </div>
      `;
      $cards.appendChild(card);
    }
  } catch (e) {
    $cards.innerHTML = '<div>Kunne ikke hente observationer.</div>';
  }
}

// Kald funktionen når DOM er klar
document.addEventListener('DOMContentLoaded', () => {
  setupFrontControls();
  autoGetUserLocationAndRender();
  startAutoRefresh();
});

function startAutoRefresh() {
  setInterval(() => {
    renderNearbyObservations();
  }, 240000); // 240.000 ms = 4 minutter
}