// Version: 4.0.7.5 - 2025-11-02 22.07.12
// © Christian Vemmelund Helligsø
const afdelinger = [
  "DOF København",
  "DOF Nordsjælland",
  "DOF Vestsjælland",
  "DOF Storstrøm",
  "DOF Bornholm",
  "DOF Fyn",
  "DOF Sønderjylland",
  "DOF Sydvestjylland",
  "DOF Sydøstjylland",
  "DOF Vestjylland",
  "DOF Østjylland",
  "DOF Nordvestjylland",
  "DOF Nordjylland"
];
const kategorier = ["Ingen", "SU", "SUB", "Bemærk"];

function renderPrefsMatrix(prefs) {
  const table = document.createElement("table");
  table.className = "prefs-table";
  // Render header (kolonnetitler) som første række
  table.innerHTML = `<thead><tr>
    <th class="afd">Lokalafdeling</th>
    ${kategorier.map(k => `<th>${k}</th>`).join("")}
  </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  // Render rækker
  afdelinger.forEach(afd => {
    const sel = prefs[afd] || "Ingen";
    const row = document.createElement("tr");
    row.innerHTML = `
      <td class="afd">${afd}</td>
      ${kategorier.map(k => `
        <td>
          <label class="radio-container">
            <input type="radio" name="prefs_${afd}" value="${k}" ${sel===k ? "checked" : ""} class="custom-checkbox">
            <span class="checkmark"></span>
          </label>
        </td>
      `).join("")}
    `;
    tbody.appendChild(row);
  });
  document.getElementById("prefs-matrix").innerHTML = "";
  document.getElementById("prefs-matrix").appendChild(table);

  // Event listeners
  table.querySelectorAll('input[type="radio"]').forEach(radio => {
    radio.addEventListener('change', async () => {
      const newPrefs = {};
      afdelinger.forEach(afd => {
        const checked = table.querySelector(`input[name="prefs_${afd}"]:checked`);
        newPrefs[afd] = checked ? checked.value : "Ingen";
      });
      await fetch("/api/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: getOrCreateUserId(), prefs: newPrefs })
      });
    });
  });
}

const themeToggle = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');

function updateThemeIcon(theme) {
  if (themeIcon) {
    themeIcon.textContent = theme === 'dark' ? '🌙' : '☀️';
  }
}

function systemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getSavedTheme() {
  return localStorage.getItem('theme');
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
  updateThemeIcon(theme);
}

function initTheme() {
  const saved = getSavedTheme();
  const theme = saved || systemTheme();
  document.documentElement.dataset.theme = theme;
  updateThemeIcon(theme);
}

initTheme();

if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || systemTheme();
    const next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });
}

function getOrCreateUserId() {
  let userid = localStorage.getItem("userid");
  if (!userid) {
    userid = "user-" + Math.random().toString(36).slice(2);
    localStorage.setItem("userid", userid);
  }
  return userid;
}

async function loadPrefs() {
  const user_id = getOrCreateUserId();
  const url = `/api/prefs?user_id=${encodeURIComponent(user_id)}`; // <-- RET HER
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) return {};
  const data = await res.json();
  return data || {};
}

async function loadLatest() {
  const res = await fetch("/api/latest");
  return await res.json();
}

function renderSummary(latest) {
  const el = document.getElementById("summary");
  if (!latest || Object.keys(latest).length === 0) {
    el.innerHTML = "<em>Ingen observation fundet.</em>";
    document.getElementById("payload").textContent = "{}";
    return;
  }
  el.innerHTML = `
    <div class="grid">
      <div class="label">Art:</div><div class="value">${latest.Artnavn || ""}</div>
      <div class="label">Dato:</div><div class="value">${latest.Dato || ""}</div>
      <div class="label">Lokalitet:</div><div class="value">${latest.Loknavn || ""}</div>
      <div class="label">Antal:</div><div class="value">${latest.Antal || ""}</div>
      <div class="label">Kategori:</div><div class="value">${latest.kategori || ""}</div>
      <div class="muted">Obsid: ${latest.Obsid || ""}</div>
    </div>
  `;
  document.getElementById("payload").textContent = JSON.stringify(latest, null, 2);
}

const publicVapidKey = "BHU3aBbXkYu7_KGJtKMEWCPU43gF1b6L0DKGVv-n_5-iybitwM5dodQdR2GkIec8OOWcJlwCEMSMzpfRX_RBUkA"; // Generér med web-push

async function ensureServiceWorker() {
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready; // Vent til SW er aktiv
    return reg;
  }
  throw new Error("Service worker ikke understøttet");
}

async function subscribeUser(userid, deviceid) {
  try {
    const reg = await ensureServiceWorker();

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      alert('Du skal tillade notifikationer for at abonnere.');
      return false;
    }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
    });

    await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userid,
        device_id: deviceid,
        subscription: sub.toJSON()
      })
    });
    alert('Du er nu abonneret!');
    return true;
  } catch (err) {
    console.error('subscribeUser fejl:', err);
    alert('Kunne ikke abonnere: se konsol.');
    return false;
  }
}

document.getElementById("hent-navn-btn").onclick = async () => {
  const kode = document.getElementById("obserkode").value.trim();
  if (!kode) return;
  // Kald backend-endpointet
  const res = await fetch(`/api/lookup_obserkode?obserkode=${encodeURIComponent(kode)}`);
  const data = await res.json();
  document.getElementById("navn").value = data.navn || "";
};

function setPrefsTableEnabled(enabled) {
  const table = document.querySelector('.prefs-table');
  if (table) {
    if (enabled) {
      table.classList.remove('disabled');
    } else {
      table.classList.add('disabled');
    }
  }
}

function setUserinfoEnabled(enabled) {
  // Gør felter og knapper i userinfo-sektionen grå/disabled
  const fields = [
    document.getElementById("obserkode"),
    document.getElementById("navn"),
    document.getElementById("hent-navn-btn"),
    document.getElementById("save-userinfo-btn")
  ];
  fields.forEach(f => {
    if (f) {
      f.disabled = !enabled;
      if (!enabled) {
        f.classList.add("disabled");
      } else {
        f.classList.remove("disabled");
      }
    }
  });
}

// Hjælpefunktion til VAPID-nøgle
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

document.addEventListener("DOMContentLoaded", async () => {
  const userid = getOrCreateUserId();
  let deviceid = localStorage.getItem("deviceid");
  if (!deviceid) {
    deviceid = "device-" + Math.random().toString(36).slice(2);
    localStorage.setItem("deviceid", deviceid);
  }

  const settingsBtn = document.getElementById("settings-btn");
  if (settingsBtn) {
    settingsBtn.onclick = () => {
      window.location.href = "./settings.html";
    };
  }

  // Vis debug-info i UI
  const debugDiv = document.getElementById("debug-info");
  if (debugDiv) {
    debugDiv.textContent = `User ID: ${userid} | Device ID: ${deviceid}`;
  }
  console.log("User ID:", userid, "Device ID:", deviceid);

  let prefs = await loadPrefs();
  renderPrefsMatrix(prefs);

  document.getElementById("unsubscribe-btn").onclick = async () => {
    await fetch("/api/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userid, device_id: deviceid })
    });
    alert("Du er nu afmeldt!");
  };

  document.getElementById("subscribe-btn").onclick = async () => {
    const ok = await subscribeUser(userid, deviceid);
    if (ok) {
      localStorage.setItem("isSubscribed", "1");
      setPrefsTableEnabled(true);
      setUserinfoEnabled(true);
      location.reload();
    }
  };

  document.getElementById("unsubscribe-btn").onclick = async () => {
    await fetch("/api/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userid, device_id: deviceid })
    });
    alert("Du er nu afmeldt!");
    localStorage.setItem("isSubscribed", "0");
    setPrefsTableEnabled(false);
    setUserinfoEnabled(false);
  };

  // Hent evt. tidligere gemte oplysninger
  let userinfo = {};
try {
  const res = await fetch(`/api/userinfo?user_id=${encodeURIComponent(userid)}&device_id=${encodeURIComponent(deviceid)}`);
  if (res.ok) {
    userinfo = await res.json();
  }
} catch (e) {
  userinfo = {};
}
document.getElementById("obserkode").value = userinfo.obserkode || "";
document.getElementById("navn").value = userinfo.navn || "";

// Sørg for store bogstaver i obserkode
const obserkodeInput = document.getElementById("obserkode");
if (obserkodeInput) {
  obserkodeInput.addEventListener("input", () => {
    obserkodeInput.value = obserkodeInput.value.toUpperCase();
  });
}

// Gem oplysninger ved klik
document.getElementById("save-userinfo-btn").onclick = async () => {
  const userid = getOrCreateUserId();
  const deviceid = localStorage.getItem("deviceid");
  const obserkode = document.getElementById("obserkode").value.trim();
  const navn = document.getElementById("navn").value.trim();

  // Fjern lokal gemning:
  // localStorage.setItem("obserkode", obserkode);
  // localStorage.setItem("navn", navn);

  // Gem kun på serveren
  await fetch("/api/userinfo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userid,
      device_id: deviceid,
      obserkode,
      navn
    })
  });
  alert("Oplysninger gemt!");
};

// Ved load:
setPrefsTableEnabled(localStorage.getItem("isSubscribed") === "1");
setUserinfoEnabled(localStorage.getItem("isSubscribed") === "1");

  // Hent og vis seneste observation
  const latest = await loadLatest();
  renderSummary(latest);

  document.getElementById("debug-push-btn").onclick = async () => {
    const res = await fetch("/api/debug-push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userid, device_id: deviceid })
    });
    if (res.ok) {
      alert("Debug push sendt!");
    } else {
      alert("Fejl ved debug push");
    }
  };

  await ensureServiceWorker(); // Vent på SW
  // Nu kan du kalde subscribeUser(...)
});