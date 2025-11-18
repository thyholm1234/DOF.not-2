// Version: 4.8 - 2025-11-18 01.26.52
// © Christian Vemmelund Helligsø

function getObsIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("obsid") || "38040196";
}

const obsid = getObsIdFromUrl();

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

  const html = titleHtml + eventHtml + `
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

    // Forhindr klik på billede/lyd åbner obs-linket
    document.querySelectorAll('.obs-img-link, .sound-row audio').forEach(el => {
      el.addEventListener('click', e => e.stopPropagation());
    });
  }
}

fetchAndRenderObs(obsid);