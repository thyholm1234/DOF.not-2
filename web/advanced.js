// Version: 4.9.64 - 2025-12-01 00.26.36
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
  const res = await fetch('/api/prefs/user/species', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id })
  });
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id, filters: userFilters })
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

function renderArtsTable() {
  const cards = document.getElementById('arts-cards');
  cards.innerHTML = '';
  let filtered = allArter.filter(a => {
    const artKey = a.artsnavn.toLowerCase();
    const isExcluded = userFilters.exclude.includes(artKey);
    const hasCount = !!userFilters.counts[artKey];
    return (
      (!searchTerm || a.artsnavn.toLowerCase().includes(searchTerm.toLowerCase())) &&
      (!showOnlyFiltered || isExcluded || hasCount)
    );
  });
  for (const art of filtered) {
    const artKey = art.artsnavn.toLowerCase();
    const isExcluded = userFilters.exclude.includes(artKey);
    const minCount = userFilters.counts[artKey] || '';
    const card = document.createElement('div');
    card.className = 'card';
    const row = document.createElement('div');
    row.className = 'arts-card-row';
    row.innerHTML = `
      <span class="art-col ${catClass(art.klassifikation)}">${art.artsnavn}</span>
      <div class="actions-row">
        <span class="min-col">
          <input type="text" inputmode="numeric" pattern="[0-9]*" value="${minCount}" ${isExcluded ? 'disabled' : ''} data-art="${artKey}" class="gte-input sp-cnt-val">
        </span>
        <span class="excl-col">
          <button type="button" class="twostate excl${isExcluded ? ' is-on' : ''}" data-art="${artKey}">
            ${isExcluded ? 'Eksl.' : 'Inkl.'}
          </button>
        </span>
      </div>
    `;
    card.appendChild(row);
    cards.appendChild(card);
  }
}

document.getElementById('show-only-filtered').addEventListener('click', () => {
  showOnlyFiltered = !showOnlyFiltered;
  showFilteredBtn.classList.toggle('is-on', showOnlyFiltered);
  renderArtsTable();
});

document.getElementById('arts-cards').addEventListener('click', e => {
  if (e.target.classList.contains('twostate') && e.target.classList.contains('excl')) {
    const art = e.target.dataset.art;
    const isExcluded = userFilters.exclude.includes(art);
    if (isExcluded) {
      userFilters.exclude = userFilters.exclude.filter(a => a !== art);
    } else {
      userFilters.exclude.push(art);
      delete userFilters.counts[art];
    }
    filtersChanged = true;
    renderArtsTable();
  }
});

document.getElementById('arts-cards').addEventListener('input', e => {
  if (e.target.classList.contains('gte-input')) {
    const art = e.target.dataset.art;
    const val = parseInt(e.target.value, 10);
    if (val >= 1) {
      userFilters.counts[art] = val;
      userFilters.exclude = userFilters.exclude.filter(a => a !== art);
    } else {
      delete userFilters.counts[art];
    }
    filtersChanged = true;
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
  if (file.size > 2 * 1024 * 1024) {
    alert("Filen er for stor (max 2 MB)");
    return;
  }
  const reader = new FileReader();
  reader.onload = evt => {
    try {
      const imported = JSON.parse(evt.target.result);
      userFilters = {
        include: imported.include || [],
        exclude: imported.exclude || [],
        counts: imported.counts || {}
      };
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