const afdelinger = [
  "DOF Bornholm", "DOF Fyn", "DOF København", "DOF Nordjylland", "DOF Nordsjælland",
  "DOF Nordvestjylland", "DOF Storstrøm", "DOF Sydvestjylland", "DOF Sydøstjylland",
  "DOF Sønderjylland", "DOF Vestjylland", "DOF Vestsjælland", "DOF Østjylland"
];
const kategorier = ["Ingen", "SU", "SUB", "Bemærk"];

function renderPrefsMatrix(prefs) {
  const table = document.createElement("table");
  table.innerHTML = `<tr><th>Lokalafdeling</th>${kategorier.map(k => `<th>${k}</th>`).join("")}</tr>`;
  afdelinger.forEach(afd => {
    const sel = prefs[afd] || "Ingen";
    table.innerHTML += `<tr>
      <td>${afd}</td>
      ${kategorier.map(k => `<td><input type="radio" name="prefs_${afd}" value="${k}" ${sel===k?"checked":""}></td>`).join("")}
    </tr>`;
  });
  document.getElementById("prefs-matrix").innerHTML = "";
  document.getElementById("prefs-matrix").appendChild(table);
}

async function loadPrefs(userid) {
  const res = await fetch(`/api/prefs?userid=${encodeURIComponent(userid)}`);
  return await res.json();
}

async function savePrefs(userid, deviceid, prefs) {
  await fetch("/api/prefs", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({userid, deviceid, prefs})
  });
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
    </div>
    <div class="muted">Obsid: ${latest.Obsid || ""}</div>
  `;
  document.getElementById("payload").textContent = JSON.stringify(latest, null, 2);
}

const publicVapidKey = "BHU3aBbXkYu7_KGJtKMEWCPU43gF1b6L0DKGVv-n_5-iybitwM5dodQdR2GkIec8OOWcJlwCEMSMzpfRX_RBUkA"; // Generér med web-push

async function ensureServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.error('Service Worker ikke understøttet');
    throw new Error('no-sw');
  }
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  // Vent på at SW er aktiv
  if (!reg.active) {
    await new Promise((resolve) => {
      const sw = reg.installing || reg.waiting;
      if (sw) {
        sw.addEventListener('statechange', function listener(e) {
          if (sw.state === 'activated') {
            sw.removeEventListener('statechange', listener);
            resolve();
          }
        });
      } else {
        // Hvis ingen installing/waiting, poll for active
        const check = setInterval(() => {
          if (reg.active) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      }
    });
  }
  return reg;
}

async function subscribeUser(userid, deviceid) {
  try {
    const reg = await ensureServiceWorker();

    const permission = await Notification.requestPermission();
    console.log('Notification permission:', permission);
    if (permission !== 'granted') {
      alert('Du skal tillade notifikationer for at abonnere.');
      return;
    }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
    });
    console.log('Push subscription:', sub);

    // Send subscription til serveren
    await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userid, deviceid, subscription: sub })
    });
    alert('Du er nu abonneret!');
  } catch (err) {
    console.error('subscribeUser fejl:', err);
    alert('Kunne ikke abonnere: se konsol.');
  }
}

// Hjælpefunktion til VAPID-nøgle
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

document.addEventListener("DOMContentLoaded", async () => {
  const userid = localStorage.getItem("userid") || "user-" + Math.random().toString(36).slice(2);
  localStorage.setItem("userid", userid);
  const deviceid = "device-" + Math.random().toString(36).slice(2);

  let prefs = await loadPrefs(userid);
  renderPrefsMatrix(prefs);

  document.getElementById("prefs-matrix").addEventListener("change", async (e) => {
    if (e.target.name && e.target.name.startsWith("prefs_")) {
      const afd = e.target.name.replace("prefs_", "");
      prefs[afd] = e.target.value;
      await savePrefs(userid, deviceid, prefs);
    }
  });

  // KORREKT: Brug subscribeUser, så subscription sendes til serveren
  document.getElementById("subscribe-btn").onclick = async () => {
    await subscribeUser(userid, deviceid);
  };
  document.getElementById("unsubscribe-btn").onclick = async () => {
    await fetch("/api/unsubscribe", {method:"POST", body:JSON.stringify({userid, deviceid})});
    alert("Du er nu afmeldt!");
  };

  // Hent og vis seneste observation
  const latest = await loadLatest();
  renderSummary(latest);

  document.getElementById("debug-push-btn").onclick = async () => {
    const res = await fetch("/api/debug-push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userid, deviceid })
    });
    if (res.ok) {
      alert("Debug push sendt!");
    } else {
      alert("Fejl ved debug push");
    }
  };
});