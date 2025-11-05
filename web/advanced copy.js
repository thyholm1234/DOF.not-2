// Version: 4.2.4 - 2025-11-05 08.45.08
// © Christian Vemmelund Helligsø
async function fetchArtsliste() {
  const res = await fetch('data/arter_filter_klassificeret.csv');
  const text = await res.text();
  const lines = text.split('\n').filter(Boolean);
  const header = lines[0].split(';');
  return lines.slice(1).map(line => {
    const cols = line.split(';');
    return {
      artsid: cols[0],
      artsnavn: cols[1].replace(/^\[|\]$/g, ''), // fjern evt. [ ]
      klassifikation: cols[2]
    };
  });
}

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

let userFilters = { include: [], exclude: [], counts: {} };
let useAdvancedFilter = localStorage.getItem('useAdvancedFilter') === 'true';


function updateAdvancedFilterBtn() {
  const btn = document.getElementById('toggle-advanced-filter');
  if (!btn) return;
  btn.classList.toggle('is-on', useAdvancedFilter);
  btn.textContent = 'Filtrér forside-feed: ' + (useAdvancedFilter ? 'Til' : 'Fra');
}

document.getElementById('toggle-advanced-filter').addEventListener('click', () => {
  useAdvancedFilter = !useAdvancedFilter;
  localStorage.setItem('useAdvancedFilter', useAdvancedFilter);
  updateAdvancedFilterBtn();
});

async function fetchUserFilters() {
  const user_id = localStorage.getItem('userid') || prompt("Indtast bruger-id:");
  const res = await fetch('/api/prefs/user/species?user_id=' + encodeURIComponent(user_id));
  if (res.ok) {
    userFilters = await res.json();
    if (!userFilters.include) userFilters.include = [];
    if (!userFilters.exclude) userFilters.exclude = [];
    if (!userFilters.counts) userFilters.counts = {};
  } else {
    userFilters = { include: [], exclude: [], counts: {} };
  }
}

async function saveUserFilters() {
  const user_id = localStorage.getItem('userid') || prompt("Indtast bruger-id:");
  await fetch('/api/prefs/user/species', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ user_id, ...userFilters })
  });
}

let allArter = [];
let searchTerm = '';
let showOnlyFiltered = false;
const showFilteredBtn = document.getElementById('show-only-filtered');
let filtersChanged = false;

function catClass(kat) {
  return `art-name cat-${String(kat||'').toLowerCase()}`;
}

let unfoldedArt = null;

document.addEventListener('click', function(e) {
  if (e.target.classList.contains('copy-global-to-afd')) {
    const artKey = e.target.getAttribute('data-art');
    unfoldedArt = unfoldedArt === artKey ? null : artKey; // toggle fold ud
    renderArtsTable();
  }
});

function renderArtsTable() {
  const cards = document.getElementById('arts-cards');
  cards.innerHTML = '';
  let filtered = allArter.filter(a => {
    const artKey = a.artsnavn.toLowerCase();
    const global = userFilters.global || { include: [], exclude: [], counts: {} };
    const isExcluded = global.exclude.includes(artKey);
    const hasCount = !!global.counts[artKey];
    return (
      (!searchTerm || a.artsnavn.toLowerCase().includes(searchTerm.toLowerCase())) &&
      (!showOnlyFiltered || isExcluded || hasCount)
    );
  });
  for (const art of filtered) {
    const artKey = art.artsnavn.toLowerCase();
    const global = userFilters.global || { include: [], exclude: [], counts: {} };
    const isExcluded = global.exclude.includes(artKey);
    const minCount = global.counts[artKey] || '';
    const hasLocal =
      afdelinger.some(afd =>
        userFilters[afd] &&
        (
          (userFilters[afd].exclude && userFilters[afd].exclude.includes(artKey)) ||
          (userFilters[afd].counts && userFilters[afd].counts[artKey] !== undefined)
        )
      );
    const card = document.createElement('div');
    card.className = 'card';
    const row = document.createElement('div');
    row.className = 'arts-card-row';
    row.innerHTML = `
      <span class="art-col ${catClass(art.klassifikation)}">${art.artsnavn}</span>
      <div class="actions-row">
        <span class="lokal-afd">
          <button class="copy-global-to-afd lokalafd-btn${hasLocal ? ' has-local' : ''}" data-art="${artKey}">
            ${unfoldedArt === artKey ? 'Skjul afdelinger' : 'Lokalafd.'}
          </button>
        </span>
        <span class="min-col">
          <input
            type="text"
            inputmode="numeric"
            pattern="[0-9]*"
            value="${minCount}"
            ${isExcluded ? 'disabled' : ''}
            data-art="${artKey}"
            class="gte-input sp-cnt-val"
          >
        </span>
        <span class="excl-col">
          <button
            type="button"
            class="twostate excl${isExcluded ? ' is-on' : ''}"
            data-art="${artKey}"
          >
            ${isExcluded ? 'Eksl.' : 'Inkl.'}
          </button>
        </span>
      </div>
    `;
    card.appendChild(row);

    // NYT: Vis grid med afdelinger hvis unfoldedArt matcher artKey
    if (unfoldedArt === artKey) {
      const afdGrid = document.createElement('div');
      afdGrid.className = 'afd-grid';
      afdGrid.innerHTML = `
        <div style="display: flex; justify-content: flex-end;">
          <button class="reset-local-btn" data-art="${artKey}" style="margin-bottom:8px;">
            Nulstil lokal
          </button>
        </div>
        <hr class="afd-grid-hr">
        ${afdelinger.map(afd => {
          if (!userFilters[afd]) userFilters[afd] = { include: [], exclude: [], counts: {} };
          const afdCount = userFilters[afd].counts[artKey] || '';
          const afdExcluded = userFilters[afd].exclude.includes(artKey);
          return `
            <div class="afd-grid-row" data-afd="${afd}" data-art="${artKey}">
              <span style="flex:1;">${afd}</span>
              <span style="width:80px; text-align:right;">
                <input type="text" inputmode="numeric" pattern="[0-9]*"
                  value="${afdCount}"
                  class="afd-cnt-input"
                  data-afd="${afd}" data-art="${artKey}"
                  ${afdExcluded ? 'disabled' : ''}
                  style="width:60px; text-align:right;"
                >
              </span>
              <span style="width:80px; text-align:right;">
                <button type="button"
                  class="twostate excl${afdExcluded ? ' is-on' : ''} afd-excl-btn"
                  data-afd="${afd}" data-art="${artKey}">
                  ${afdExcluded ? 'Eksl.' : 'Inkl.'}
                </button>
              </span>
            </div>
          `;
        }).join('')}
      `;
      card.appendChild(afdGrid);
    }

    cards.appendChild(card);
  }
}

document.getElementById('show-only-filtered').addEventListener('click', () => {
  showOnlyFiltered = !showOnlyFiltered;
  showFilteredBtn.classList.toggle('is-on', showOnlyFiltered);
  renderArtsTable();
});

document.getElementById('arts-cards').addEventListener('input', e => {
  // Global input
  if (e.target.classList.contains('gte-input')) {
    const art = e.target.dataset.art;
    const val = parseInt(e.target.value, 10);
    if (!userFilters.global) userFilters.global = { include: [], exclude: [], counts: {} };
    if (val >= 1) {
      userFilters.global.counts[art] = val;
      userFilters.global.exclude = userFilters.global.exclude.filter(a => a !== art);
    } else {
      delete userFilters.global.counts[art];
    }
    filtersChanged = true;
  }

  // Lokalafdeling input
  if (e.target.classList.contains('afd-cnt-input')) {
    const afd = e.target.dataset.afd;
    const art = e.target.dataset.art;
    const val = parseInt(e.target.value, 10);
    if (!userFilters[afd]) userFilters[afd] = { include: [], exclude: [], counts: {} };
    if (val >= 1) {
      userFilters[afd].counts[art] = val;
      userFilters[afd].exclude = userFilters[afd].exclude.filter(a => a !== art);
    } else {
      delete userFilters[afd].counts[art];
    }
    filtersChanged = true;
  }
});

document.getElementById('arts-cards').addEventListener('click', function(e) {
  // 1. Lokalafdeling ekskluder/inkluder
  if (e.target.classList.contains('afd-excl-btn')) {
    const afd = e.target.dataset.afd;
    const art = e.target.dataset.art;
    if (!userFilters[afd]) userFilters[afd] = { include: [], exclude: [], counts: {} };
    if (!userFilters.global) userFilters.global = { include: [], exclude: [], counts: {} };
    const isExcluded = userFilters[afd].exclude.includes(art);

    if (isExcluded) {
      // Sæt lokal til inkl. (fjern fra exclude)
      userFilters[afd].exclude = userFilters[afd].exclude.filter(a => a !== art);

      // Hvis mindst én lokalafdeling nu er inkl. for denne art, så sæt global til inkl.
      const nogenInkl = afdelinger.some(afdnavn =>
        userFilters[afdnavn] &&
        !userFilters[afdnavn].exclude.includes(art) &&
        !userFilters[afdnavn].counts[art]
      );
      if (nogenInkl) {
        userFilters.global.exclude = userFilters.global.exclude.filter(a => a !== art);
        delete userFilters.global.counts[art];
      }
    } else {
      // Sæt lokal til ekskluderet
      userFilters[afd].exclude.push(art);
      delete userFilters[afd].counts[art];
    }
    filtersChanged = true;
    renderArtsTable();
    return;
  }

  // 2. Global ekskluder/inkluder
  if (
    e.target.classList.contains('twostate') &&
    !e.target.classList.contains('afd-excl-btn')
  ) {
    const art = e.target.dataset.art;
    if (!userFilters.global) userFilters.global = { include: [], exclude: [], counts: {} };
    const isExcluded = userFilters.global.exclude.includes(art);
    if (isExcluded) {
      userFilters.global.exclude = userFilters.global.exclude.filter(a => a !== art);
    } else {
      userFilters.global.exclude.push(art);
      delete userFilters.global.counts[art];
    }
    filtersChanged = true;
    renderArtsTable();
  }

  // Nulstil lokalafdelingsfiltre for denne art
  if (e.target.classList.contains('reset-local-btn')) {
    const art = e.target.dataset.art;
    afdelinger.forEach(afd => {
      if (userFilters[afd]) {
        userFilters[afd].exclude = userFilters[afd].exclude.filter(a => a !== art);
        delete userFilters[afd].counts[art];
        if (userFilters[afd].include) {
          userFilters[afd].include = userFilters[afd].include.filter(a => a !== art);
        }
      }
    });
    filtersChanged = true;
    renderArtsTable();
    return;
  }
});
document.getElementById('arts-cards').addEventListener('blur', e => {
  if (e.target.classList.contains('gte-input')) {
    renderArtsTable();
  }
}, true);

document.getElementById('arts-search').addEventListener('input', e => {
  searchTerm = e.target.value;
  renderArtsTable();
});

document.getElementById('reset-filters').addEventListener('click', () => {
  const a = Math.floor(Math.random() * 10) + 1;
  const b = Math.floor(Math.random() * 10) + 1;
  const svar = prompt(`Bekræft nulstilling: Hvad er ${a} + ${b}?`);
  if (svar === null) return;
  if (parseInt(svar, 10) !== a + b) {
    alert('Forkert svar. Nulstilling annulleret.');
    return;
  }
  userFilters = { include: [], exclude: [], counts: {} };
  renderArtsTable();
  saveUserFilters();
});

document.getElementById('export-filters').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(userFilters, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'artsfiltre.json';
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('import-filters').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = evt => {
    try {
      const imported = JSON.parse(evt.target.result);

      // Hvis importeret objekt har global eller afdelinger, brug det direkte
      if (imported.global || Object.keys(imported).some(k => afdelinger.includes(k))) {
        userFilters = imported;
      } else {
        // Ellers antag gammelt format og læg det ind under global
        userFilters = {
          global: {
            include: imported.include || [],
            exclude: imported.exclude || [],
            counts: imported.counts || {}
          }
        };
      }

      renderArtsTable();
      saveUserFilters();
    } catch {}
  };
  reader.readAsText(file);
});

document.getElementById('save-filters').addEventListener('click', () => {
  saveUserFilters();
  filtersChanged = false;
});

(async function() {
  allArter = await fetchArtsliste();
  await fetchUserFilters();
  renderArtsTable();
})();

updateAdvancedFilterBtn();