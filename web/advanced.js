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
let filtersChanged = false;

function renderArtsTable() {
  const table = document.getElementById('arts-table');
  table.innerHTML = '';
  let filtered = allArter.filter(a =>
    (!searchTerm || a.artsnavn.toLowerCase().includes(searchTerm.toLowerCase())) &&
    (!showOnlyFiltered ||
      userFilters.exclude.includes(a.artsnavn.toLowerCase()) ||
      userFilters.counts[a.artsnavn.toLowerCase()])
  );
  for (const art of filtered) {
    const artKey = art.artsnavn.toLowerCase();
    const isExcluded = userFilters.exclude.includes(artKey);
    const minCount = userFilters.counts[artKey] || '';
    const row = document.createElement('tr');
    row.innerHTML = `
    <td>${art.artsnavn}</td>
    <td>
        <input type="checkbox" ${isExcluded ? 'checked' : ''} data-art="${artKey}" class="exclude-chk">
    </td>
    <td>
        <input type="text" inputmode="numeric" pattern="[0-9]*" value="${minCount}" ${isExcluded ? 'disabled' : ''} data-art="${artKey}" class="gte-input sp-cnt-val">
    </td>
    `;
    table.appendChild(row);
  }
}

document.getElementById('arts-search').addEventListener('input', e => {
  searchTerm = e.target.value;
  renderArtsTable();
});

document.getElementById('show-only-filtered').addEventListener('change', e => {
  showOnlyFiltered = e.target.checked;
  renderArtsTable();
});

document.getElementById('arts-table').addEventListener('input', e => {
  const art = e.target.dataset.art;
  if (e.target.classList.contains('exclude-chk')) {
    if (e.target.checked) {
      if (!userFilters.exclude.includes(art)) userFilters.exclude.push(art);
      delete userFilters.counts[art];
    } else {
      userFilters.exclude = userFilters.exclude.filter(a => a !== art);
    }
    filtersChanged = true;
    renderArtsTable(); // behold denne for checkbox
  }
  if (e.target.classList.contains('gte-input')) {
    const val = parseInt(e.target.value, 10);
    if (val >= 1) {
      userFilters.counts[art] = val;
      userFilters.exclude = userFilters.exclude.filter(a => a !== art);
    } else {
      delete userFilters.counts[art];
    }
    filtersChanged = true;
    // renderArtsTable();  // fjern denne linje!
  }
});

document.getElementById('reset-filters').addEventListener('click', () => {
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