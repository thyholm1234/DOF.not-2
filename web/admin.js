// Version: 4.5.3.18 - 2025-11-12 13.08.42
// © Christian Vemmelund Helligsø
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

async function removeComment(user_id, device_id, ts, thread_id, day) {
  const admin_user_id = getOrCreateUserId();
  await fetch("/api/admin/remove-comment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id, device_id, ts, admin_user_id, thread_id, day })
  });
  await loadCommentThreads();
}

async function unblacklistObsid(obsid) {
  if (!confirm("Vil du fjerne denne obserkode fra blacklist?")) return;
  const user_id = getOrCreateUserId();
  await fetch("/api/admin/unblacklist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ obsid, user_id })
  });
  await loadBlacklist();
  await loadCommentThreads();
}

async function loadCommentThreads() {
  const user_id = getOrCreateUserId();
  let blacklisted = [];
  try {
    const blRes = await fetch("/api/admin/blacklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id })
    });
    if (blRes.ok) {
      const blList = await blRes.json();
      blacklisted = blList.map(entry => (entry.obserkode || "").trim().toLowerCase());
    }
  } catch {}
  
  const res = await fetch("/api/admin/comments");
  if (res.ok) {
    const threads = await res.json();
    const container = document.getElementById("comment-threads");
    container.innerHTML = "";
    let shownThreads = 0;
    threads.forEach(thread => {
      // Tjek om der er kommentarer
      if (!thread.comments || !thread.comments.length) {
        return; // Spring denne tråd over
      }
      shownThreads++;
      const threadHeader = document.createElement("h3");
      threadHeader.textContent = `${thread.art_lokation} (${thread.day})`;
      container.appendChild(threadHeader);

      thread.comments.forEach(comment => {
        const commentCard = document.createElement("div");
        commentCard.className = "card";
        commentCard.style.marginBottom = "1em";
        commentCard.style.position = "relative";
        commentCard.innerHTML = `
          <strong>${escapeHTML(comment.navn)}${comment.obserkode ? " (" + escapeHTML(comment.obserkode) + ")" : ""}</strong><br>
          ${escapeHTML(comment.body)}
        `;
        if (comment.obserkode) {
          // Wrapper til knapper
          const btnWrap = document.createElement("div");
          btnWrap.className = "admin-btn-wrap";
          btnWrap.style.display = "flex";
          btnWrap.style.gap = "8px";
          btnWrap.style.marginTop = "8px";
          btnWrap.style.position = "static";
          btnWrap.style.justifyContent = "flex-end";

          // Mail-knap
          const mailBtn = document.createElement("button");
          mailBtn.type = "button";
          mailBtn.textContent = "Mail";
          mailBtn.onclick = () => {
            window.open(
              `https://dofbasen.dk/mine/sendmailtouser.php?obserkode=${encodeURIComponent(comment.obserkode)}`,
              "_blank"
            );
          };
          btnWrap.appendChild(mailBtn);

          // Blacklist-knap
          const btn = document.createElement("button");
          btn.textContent = "Blacklist";
          if (blacklisted.includes((comment.obserkode || "").trim().toLowerCase())) {
            btn.className = "blacklist-btn-red";
            btn.title = "Denne obserkode er allerede blacklistet";
          }
          btn.onclick = () => showBlacklistModal(comment.obserkode, comment.navn, comment.body);
          btnWrap.appendChild(btn);

          // Lav thread_id hvis det ikke findes:
          let thread_id = thread.thread_id;
          if (!thread_id && thread.art_lokation) {
            thread_id = thread.art_lokation.trim().toLowerCase().replace(/\s+/g, '-');
          }

          // Fjern kommentar-knap
          const removeBtn = document.createElement("button");
          removeBtn.textContent = "Fjern kommentar";
          removeBtn.className = "remove-comment-btn";
          removeBtn.onclick = () => {
            if (confirm("Vil du fjerne denne kommentar?")) {
              removeComment(
                comment.user_id,
                comment.device_id,
                comment.ts,
                thread_id,
                thread.day
              );
            }
          };
          // Sæt knappen forrest/til venstre
          btnWrap.insertBefore(removeBtn, btnWrap.firstChild);

          commentCard.appendChild(btnWrap);
        }
        container.appendChild(commentCard);
      });
    });
    if (shownThreads === 0) {
      container.innerHTML = "<em>Ingen tråde at moderere</em>";
    }
  }
}

async function loadBlacklist() {
  const user_id = getOrCreateUserId();
  const res = await fetch("/api/admin/blacklist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id })
  });
  if (res.ok) {
    const list = await res.json();
    const container = document.getElementById("blacklist-entries");
    container.innerHTML = "";
    if (!list.length) {
      container.innerHTML = "<em>Ingen blacklistede observatører</em>";
      return;
    }
    list.forEach(entry => {
      const div = document.createElement("div");
      div.className = "blacklist-entry";
      div.innerHTML = `
        <strong>${entry.navn ? entry.navn + " (" + entry.obserkode + ")" : entry.obserkode}</strong>
        <br>${entry.body ? "Besked: " + entry.body : ""}
        <br>Årsag: ${entry.reason}
        <br>Tidspunkt: ${entry.time}
        <br>Moderator: ${entry.admin_obserkode}
        <br>
        <button onclick="unblacklistObsid('${entry.obserkode}')">Fjern fra blacklist</button>
      `;
      container.appendChild(div);
    });
  }
}

let blacklistObserkode = null;
let blacklistNavn = null;
let blacklistBody = null;

function showBlacklistModal(obserkode, navn, body) {
  blacklistObserkode = obserkode;
  blacklistNavn = navn || "";
  blacklistBody = body || "";
  document.getElementById("blacklist-modal-obserkode").textContent = "Obserkode: " + obserkode;
  document.getElementById("blacklist-reason").value = "";
  document.getElementById("blacklist-modal").style.display = "flex";
  setTimeout(() => {
    document.getElementById("blacklist-reason").focus();
  }, 50);
}

function hideBlacklistModal() {
  document.getElementById("blacklist-modal").style.display = "none";
}

// Tilføj event listeners til modal-knapperne
document.addEventListener('DOMContentLoaded', async () => {
  const user_id = getOrCreateUserId();
  const device_id = getOrCreateDeviceId();
  let isSuperAdmin = false;

  // Tjek om bruger er hovedadmin
  try {
    const res = await fetch('/api/is-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id, device_id })
    });
    const data = await res.json();
    if (data.admin && data.obserkode === "8220CVH") {
      isSuperAdmin = true;
    }
  } catch {}

  // Vis admins-knapper kun for hovedadmin
  if (isSuperAdmin) {
    document.getElementById("admin-action-card").style.display = "flex";
    document.getElementById("show-admins-btn").style.display = "";
    document.getElementById("add-admin-btn").style.display = "";
    document.getElementById("add-art-btn").style.display = "";
    document.getElementById("sync-threads-btn").style.display = "";
  } else {
    document.getElementById("admin-action-card").style.display = "none";
  }

  // "Administrer admins"-knap
  document.getElementById("show-admins-btn").onclick = async function() {
    const adminsPanel = document.getElementById("admins-panel");
    const csvPanel = document.getElementById("csv-file-list");
    const csvEditor = document.getElementById("csv-editor");
    // Luk CSV-panel hvis åbent
    if (csvPanel) csvPanel.style.display = "none";
    if (csvEditor) csvEditor.style.display = "none";
    // Toggle admins-panel
    if (adminsPanel.style.display === "none" || adminsPanel.style.display === "") {
      await loadAdminsList();
      adminsPanel.style.display = "block";
    } else {
      adminsPanel.style.display = "none";
    }
  };

  async function loadAdminsList() {
    const res = await fetch("/api/admin/list-admins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id })
    });
    const data = await res.json();
    const admins = data.admins || [];
    const listDiv = document.getElementById("admins-list");
    listDiv.innerHTML = "";
    admins.forEach(obserkode => {
      const card = document.createElement("div");
      card.className = "card";
      card.style.display = "flex";
      card.style.justifyContent = "space-between";
      card.style.alignItems = "center";
      card.style.marginBottom = "8px";
      card.innerHTML = `
        <span>${escapeHTML(obserkode)}</span>
        <button class="remove-admin-btn" data-obserkode="${escapeHTML(obserkode)}" style="margin-left:1em;">Slet</button>
      `;
      listDiv.appendChild(card);
    });
    // Slet-knapper
    listDiv.querySelectorAll(".remove-admin-btn").forEach(btn => {
      btn.onclick = async function() {
        const kode = btn.getAttribute("data-obserkode");
        if (kode === "8220CVH") {
          alert("Du kan ikke fjerne hovedadmin.");
          return;
        }
        if (!confirm("Er du sikker på, at du vil fjerne admin: " + kode + "?")) return;
        await fetch("/api/admin/remove-admin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id, obserkode: kode })
        });
        await loadAdminsList();
      };
    });
  }

  // Modal tilføj admin
  document.getElementById("add-admin-btn").onclick = function() {
    document.getElementById("add-admin-obserkode").value = "";
    document.getElementById("add-admin-modal").style.display = "flex";
    setTimeout(() => document.getElementById("add-admin-obserkode").focus(), 50);
  };
  document.getElementById("add-admin-cancel-btn").onclick = function() {
    document.getElementById("add-admin-modal").style.display = "none";
  };
  document.getElementById("add-admin-save-btn").onclick = async function() {
    const kode = document.getElementById("add-admin-obserkode").value.trim().toUpperCase();
    if (!kode) {
      alert("Indtast en obserkode.");
      return;
    }
    if (!confirm("Er du sikker på, at du vil tilføje admin: " + kode + "?")) return;
    await fetch("/api/admin/add-admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id, obserkode: kode })
    });
    document.getElementById("add-admin-modal").style.display = "none";
    await loadAdminsList();
  };

  try {
    const res = await fetch('/api/is-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id, device_id })
    });
    const data = await res.json();
    if (data.admin) {
      document.getElementById("admin-content").style.display = "";
      await loadCommentThreads();
      await loadBlacklist();
    } else {
      document.getElementById("no-access").style.display = "";
    }
  } catch {
    document.getElementById("no-access").style.display = "";
  }

  // Modal knapper
  document.getElementById("blacklist-cancel-btn").onclick = hideBlacklistModal;
  let blacklistModalBusy = false;
  async function saveBlacklistModal() {
    if (blacklistModalBusy) return;
    blacklistModalBusy = true;
    const reason = document.getElementById("blacklist-reason").value.trim();
    if (!reason) {
      alert("Du skal angive en årsag til blacklistning.");
      blacklistModalBusy = false;
      return;
    }
    const user_id = getOrCreateUserId();
    await fetch("/api/admin/blacklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ obsid: blacklistObserkode, user_id, reason, navn: blacklistNavn, body: blacklistBody })
    });
    hideBlacklistModal();
    await loadCommentThreads();
    await loadBlacklist();
    blacklistModalBusy = false;
  }
  document.getElementById("blacklist-save-btn").onclick = saveBlacklistModal;

  // Ctrl+Enter eller Cmd+Enter i textarea
  document.getElementById("blacklist-reason").addEventListener("keydown", function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      saveBlacklistModal();
    }
  });

  // CSV-fil editor
  const csvFiles = [
    { file: "data/arter_filter_klassificeret.csv", title: "Arter - Kategori" },
    { file: "data/faenologi.csv", title: "Arter - Fænologi" },
    { file: "data/bornholm_bemaerk_parsed.csv", title: "Bornholm - Bemærkelsesværdig" },
    { file: "data/fyn_bemaerk_parsed.csv", title: "Fyn - Bemærkelsesværdig" },
    { file: "data/koebenhavn_bemaerk_parsed.csv", title: "København - Bemærkelsesværdig" },
    { file: "data/nordjylland_bemaerk_parsed.csv", title: "Nordjylland - Bemærkelsesværdig" },
    { file: "data/nordsjaelland_bemaerk_parsed.csv", title: "Nordsjælland - Bemærkelsesværdig" },
    { file: "data/nordvestjylland_bemaerk_parsed.csv", title: "Nordvestjylland - Bemærkelsesværdig" },
    { file: "data/oestjylland_bemaerk_parsed.csv", title: "Østjylland - Bemærkelsesværdig" },
    { file: "data/soenderjylland_bemaerk_parsed.csv", title: "Sønderjylland - Bemærkelsesværdig" },
    { file: "data/storstroem_bemaerk_parsed.csv", title: "Storstrøm - Bemærkelsesværdig" },
    { file: "data/sydoestjylland_bemaerk_parsed.csv", title: "Sydøstjylland - Bemærkelsesværdig" },
    { file: "data/sydvestjylland_bemaerk_parsed.csv", title: "Sydvestjylland - Bemærkelsesværdig" },
    { file: "data/vestjylland_bemaerk_parsed.csv", title: "Vestjylland - Bemærkelsesværdig" },
    { file: "data/vestsjaelland_bemaerk_parsed.csv", title: "Vestsjælland - Bemærkelsesværdig" }
  ];

  // "Rediger Artsdata"-knap
  document.getElementById("show-csv-files-btn").onclick = function() {
    const adminsPanel = document.getElementById("admins-panel");
    const csvPanel = document.getElementById("csv-file-list");
    const csvEditor = document.getElementById("csv-editor");
    // Luk admins-panel hvis åbent
    if (adminsPanel) adminsPanel.style.display = "none";
    // Toggle CSV-panel
    if (csvPanel.style.display === "" || csvPanel.style.display === "block") {
      csvPanel.style.display = "none";
      if (csvEditor) csvEditor.style.display = "none";
    } else {
      csvPanel.innerHTML = "<h2>Vælg en fil</h2><ul>" +
        csvFiles.map(f => `<li><a href=\"#\" onclick=\"loadCsvEditor('${f.file}', '${f.title}');return false;\">${f.title}</a></li>`).join("") +
        "</ul>";
      csvPanel.style.display = "block";
      if (csvEditor) csvEditor.style.display = "none";
    }
  };

  window.loadCsvEditor = async function(filename, title) {
    const user_id = getOrCreateUserId();
    const device_id = getOrCreateDeviceId();
    const res = await fetch("/api/admin/csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: filename, user_id, device_id, action: "read" })
    });
    if (!res.ok) {
      alert("Du har ikke adgang eller filen findes ikke.");
      return;
    }
    const text = await res.text();
    document.getElementById("csv-editor").innerHTML = `
      <h3>Rediger: ${title}</h3>
      <textarea id="csv-edit-area" style="width:100%;height:300px;">${text}</textarea><br>
      <button onclick="saveCsvFile('${filename}', '${title}')">Gem</button>
      <button onclick="document.getElementById('csv-editor').style.display='none'">Luk</button>
    `;
    document.getElementById("csv-editor").style.display = "";
  };

  window.saveCsvFile = async function(filename, title) {
    const user_id = getOrCreateUserId();
    const device_id = getOrCreateDeviceId();
    const content = document.getElementById("csv-edit-area").value;
    const res = await fetch("/api/admin/csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: filename, user_id, device_id, action: "write", content })
    });
    if (res.ok) {
      alert(`Filen "${title}" er gemt!`);
    } else {
      alert("Kunne ikke gemme filen (mangler admin-rettigheder?)");
    }
  };

  document.getElementById("add-art-btn").onclick = function() {
    document.getElementById("add-art-modal").style.display = "flex";
  };

  document.getElementById("add-art-form").onsubmit = async function(e) {
    e.preventDefault();
    const artsid = document.getElementById("add-artsid").value.trim();
    const artsnavn = document.getElementById("add-artsnavn").value.trim();
    const klassifikation = document.getElementById("add-klassifikation").value;
    const bemaerk_antal = document.getElementById("add-bemaerk-antal").value.trim();
    const user_id = getOrCreateUserId();
    const device_id = getOrCreateDeviceId();

    // Kald backend
    const res = await fetch("/api/admin/add-art", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artsid, artsnavn, klassifikation, bemaerk_antal, user_id, device_id })
    });
    if (res.ok) {
      alert("Art tilføjet!");
      document.getElementById("add-art-modal").style.display = "none";
    } else {
      alert("Kunne ikke tilføje art (mangler admin-rettigheder?)");
    }
  };
});

// Modal-knapper og sync-request (udenfor DOMContentLoaded)
document.getElementById("sync-threads-btn").onclick = function() {
  document.getElementById("sync-modal").style.display = "flex";
};
document.getElementById("sync-cancel-btn").onclick = function() {
  document.getElementById("sync-modal").style.display = "none";
};

async function sendSyncRequest(syncType) {
  const user_id = getOrCreateUserId();
  const res = await fetch("/api/request_sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sync: syncType, user_id })
  });
  if (res.ok) {
    alert("Sync-anmodning sendt: " + syncType);
  } else {
    alert("Kunne ikke sende sync-anmodning (mangler admin-rettigheder?)");
  }
  document.getElementById("sync-modal").style.display = "none";
}

document.getElementById("sync-today-btn").onclick = function() { sendSyncRequest("today"); };
document.getElementById("sync-yesterday-btn").onclick = function() { sendSyncRequest("yesterday"); };
document.getElementById("sync-both-btn").onclick = function() { sendSyncRequest("both"); };

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

