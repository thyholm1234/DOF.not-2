// Version: 4.11.5 - 2026-02-04 00.00.23
// © Christian Vemmelund Helligsø

let deferredPrompt = null;

function getOS() {
  const ua = navigator.userAgent || navigator.vendor || window.opera;
  if (/android/i.test(ua)) return "Android";
  if (/iPad|iPhone|iPod/.test(ua) && !window.MSStream) return "iOS";
  if (/Mac/.test(navigator.platform)) return "macOS";
  if (/Win/.test(navigator.platform)) return "Windows";
  if (/Linux/.test(navigator.platform)) return "Linux";
  return "Ukendt";
}

function isChrome() {
  return /chrome|crios|crmo/i.test(navigator.userAgent) && !/edge|edg|opr|opera|firefox/i.test(navigator.userAgent);
}
function isFirefox() {
  return /firefox/i.test(navigator.userAgent);
}

function isPWAInstalled() {
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  if (window.navigator.standalone === true) return true;
  if (document.referrer && document.referrer.startsWith('android-app://')) return true;
  return false;
}

function updateInstallCards() {
  const os = getOS();
  const iosCard = document.getElementById('ios-card');
  const chromeCard = document.getElementById('chrome-card');
  const firefoxCard = document.getElementById('firefox-card');
  const firefoxGuideAndroid = document.getElementById('firefox-guide-android');
  const firefoxGuideDesktop = document.getElementById('firefox-guide-desktop');
  const btn = document.getElementById('install-app-btn');
  const card = document.getElementById('install-card');

  // Skjul hele kortet hvis installeret eller flag sat
  if (isPWAInstalled() || localStorage.getItem('pwa_installed') === '1') {
    if (card) card.style.display = 'none';
    return;
  }

  // iOS/macOS: vis kun iosCard
  if (os === "iOS" || os === "macOS") {
    if (iosCard) iosCard.style.display = '';
    if (chromeCard) chromeCard.style.display = 'none';
    if (firefoxCard) firefoxCard.style.display = 'none';
  }
  // Chrome på Android, Windows, Linux: vis kun chromeCard
  else if ((os === "Android" || os === "Windows" || os === "Linux") && isChrome()) {
    if (iosCard) iosCard.style.display = 'none';
    if (chromeCard) chromeCard.style.display = '';
    if (firefoxCard) firefoxCard.style.display = 'none';
    if (btn) btn.disabled = false;
  }
  // Firefox på Android, Windows, Linux: vis kun firefoxCard og den rigtige guide
  else if ((os === "Android" || os === "Windows" || os === "Linux") && isFirefox()) {
    if (iosCard) iosCard.style.display = 'none';
    if (chromeCard) chromeCard.style.display = 'none';
    if (firefoxCard) firefoxCard.style.display = '';
    if (firefoxGuideAndroid) firefoxGuideAndroid.style.display = (os === "Android") ? '' : 'none';
    if (firefoxGuideDesktop) firefoxGuideDesktop.style.display = (os === "Windows" || os === "Linux") ? '' : 'none';
  }
  // Andet: skjul alle
  else {
    if (iosCard) iosCard.style.display = 'none';
    if (chromeCard) chromeCard.style.display = 'none';
    if (firefoxCard) firefoxCard.style.display = 'none';
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  updateInstallCards();
});

window.addEventListener('DOMContentLoaded', () => {
  updateInstallCards();
  const btn = document.getElementById('install-app-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const result = await deferredPrompt.userChoice;
      if (result && result.outcome === 'accepted') {
        localStorage.setItem('pwa_installed', '1');
        const card = document.getElementById('install-card');
        if (card) card.style.display = 'none';
      }
      deferredPrompt = null;
      // btn.style.display = 'none';
    }
  });
});