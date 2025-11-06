// Version: 4.3.4 - 2025-11-06 23.06.13
// © Christian Vemmelund Helligsø
async function validateLogin(user_id, device_id, obserkode, adgangskode) {
  const res = await fetch('/api/validate-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id, device_id, obserkode, adgangskode })
  });
  const data = await res.json();
  return data; // { ok: true, token: "...", navn: "..." } eller { ok: false, error: "..." }
}

function getOrCreateUserId() {
  let userid = localStorage.getItem("userid");
  if (!userid) {
    userid = "user-" + Math.random().toString(36).slice(2);
    localStorage.setItem("userid", userid);
  }
  return userid;
}

function getOrCreateDeviceId() {
  let deviceid = localStorage.getItem("deviceid");
  if (!deviceid) {
    deviceid = "device-" + Math.random().toString(36).slice(2);
    localStorage.setItem("deviceid", deviceid);
  }
  return deviceid;
}

document.addEventListener('DOMContentLoaded', async () => {
  const loginCard = document.getElementById('login-card');
  const userinfoCard = document.getElementById('userinfo-card');
  const obserkodeInput = document.getElementById('obserkode');
  const adgangskodeInput = document.getElementById('adgangskode');
  const hentNavnBtn = document.getElementById('hent-navn-btn');
  const obserkodeGreyed = document.getElementById('obserkode_greyed');
  const navnInput = document.getElementById('navn');
  const removeBtn = document.getElementById('remove-connection-btn');
  

  function showLogin() {
    loginCard.style.display = '';
    userinfoCard.style.display = 'none';
    obserkodeInput.value = '';
    adgangskodeInput.value = '';
  }

  function showUserinfo(obserkode, navn) {
    loginCard.style.display = 'none';
    userinfoCard.style.display = '';
    obserkodeGreyed.value = obserkode;
    navnInput.value = navn;
  }

  hentNavnBtn.addEventListener('click', async () => {
    const obserkode = obserkodeInput.value.trim();
    const adgangskode = adgangskodeInput.value;
    if (!obserkode || !adgangskode) {
      alert('Udfyld både obserkode og adgangskode.');
      return;
    }
    hentNavnBtn.disabled = true;
    hentNavnBtn.textContent = 'Validerer...';
    try {
      const user_id = getOrCreateUserId();
      const device_id = getOrCreateDeviceId();
      const res = await fetch('/api/validate-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id, device_id, obserkode, adgangskode })
      });
      const data = await res.json();
      if (data.ok) {
        showUserinfo(data.obserkode || obserkode, data.navn || '');
      } else {
        alert(data.error || 'Login fejlede');
      }
    } catch (e) {
      alert('Netværksfejl');
    }
    hentNavnBtn.disabled = false;
    hentNavnBtn.textContent = 'Login';
  });

  removeBtn.addEventListener('click', async () => {
    const user_id = getOrCreateUserId();
    const res = await fetch('/api/remove-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id })
    });
    if (res.ok) {
      showLogin();
    } else {
      alert('Kunne ikke fjerne forbindelse');
    }
  });

  // Ved refresh: Hent obserkode og navn fra /api/userinfo og skriv i korrekte felter
  const user_id = getOrCreateUserId();
  const device_id = getOrCreateDeviceId();
  try {
    const res = await fetch(`/api/userinfo?user_id=${encodeURIComponent(user_id)}&device_id=${encodeURIComponent(device_id)}`);
    if (res.ok) {
      const userinfo = await res.json();
      if (userinfo.obserkode && userinfo.navn) {
        showUserinfo(userinfo.obserkode, userinfo.navn);
      } else {
        showLogin();
      }
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
});