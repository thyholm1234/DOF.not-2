// Version: 4.5.3.18 - 2025-11-12 13.08.42
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

function isFirstVisit() {
  if (!localStorage.getItem("hasVisited")) {
    localStorage.setItem("hasVisited", "1");
    return true;
  }
  return false;
}

window.addEventListener('DOMContentLoaded', () => {
  if (isFirstVisit()) {
    // Lav en simpel custom dialog med Ja/Nej
    const box = document.createElement('div');
    box.style.position = 'fixed';
    box.style.left = '0';
    box.style.top = '0';
    box.style.width = '100vw';
    box.style.height = '100vh';
    box.style.background = 'rgba(0,0,0,0.4)';
    box.style.display = 'flex';
    box.style.alignItems = 'center';
    box.style.justifyContent = 'center';
    box.style.zIndex = '9999';

    box.innerHTML = `
      <div style="background:#fff; color:#222; padding:2em 1.5em; border-radius:10px; max-width:90vw; box-shadow:0 4px 24px #0002;">
        <h2 style="margin-top:0;">Velkommen til DOF.not!</h2>
        <p>Vil du sætte app'en op til brug nu?</p>
        <div style="display:flex; gap:1em; justify-content:center; margin-top:1.5em;">
          <button id="firstvisit-yes" style="padding:0.5em 2em;">Ja</button>
          <button id="firstvisit-no" style="padding:0.5em 2em;">Nej</button>
        </div>
      </div>
    `;
    document.body.appendChild(box);

    document.getElementById('firstvisit-yes').onclick = () => {
      window.location.href = "/settings.html";
    };
    document.getElementById('firstvisit-no').onclick = () => {
      box.remove();
    };
  }
});

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
    themeToggle.blur(); // <-- Fjerner fokus fra knappen efter klik
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
  const res = await fetch("/api/prefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id })
  });
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

function setPrefsTableEnabled(enabled) {
  const table = document.querySelector('.prefs-table');
  if (!table) return;
  if (enabled) {
    table.classList.remove('disabled');
    table.querySelectorAll('input, select, button').forEach(el => el.disabled = false);
  } else {
    table.classList.add('disabled');
    table.querySelectorAll('input, select, button').forEach(el => el.disabled = true);
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
  setPrefsTableEnabled(localStorage.getItem("isSubscribed") === "1");
  setUserinfoEnabled(localStorage.getItem("isSubscribed") === "1");




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
    const confirmDelete = confirm("Er du sikker på, at du vil afmelde og slette alle lokale data? Dette kan ikke fortrydes.");
    if (!confirmDelete) return;

    await fetch("/api/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userid, device_id: deviceid })
    });

    // Slet alle lokale data
    localStorage.clear();

    // Afinstaller service worker og slet caches
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) {
        await reg.unregister();
      }
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        for (const name of cacheNames) {
          await caches.delete(name);
        }
      }
    }

    // Disable UI med det samme
    setPrefsTableEnabled(false);
    setUserinfoEnabled(false);
    document.getElementById("unsubscribe-btn").disabled = true;
    document.getElementById("subscribe-btn").disabled = false;

    alert("Du er nu afmeldt! Alle data er nu slettet.");
    location.reload();
  };

// Sørg for store bogstaver i obserkode
const obserkodeInput = document.getElementById("obserkode");
if (obserkodeInput) {
  obserkodeInput.addEventListener("input", () => {
    obserkodeInput.value = obserkodeInput.value.toUpperCase();
  });
}

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

document.addEventListener('DOMContentLoaded', () => {
  const advancedBtn = document.getElementById('advanced-filter-btn');
  if (advancedBtn) {
    advancedBtn.disabled = localStorage.getItem("isSubscribed") !== "1";
  }
  const unsubscribeBtn = document.getElementById("unsubscribe-btn");
  if (unsubscribeBtn) {
    unsubscribeBtn.disabled = localStorage.getItem("isSubscribed") !== "1";
  }
  const subscribeBtn = document.getElementById("subscribe-btn");
  if (subscribeBtn) {
    if (localStorage.getItem("isSubscribed") === "1") {
      subscribeBtn.classList.add("btn-green");
      subscribeBtn.disabled = false;
      subscribeBtn.textContent = "Abonnement: Aktivt";
    } else {
      subscribeBtn.classList.remove("btn-green");
      subscribeBtn.disabled = false;
      subscribeBtn.textContent = "Opret";
    }
  }
});