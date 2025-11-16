// Version: 4.7.1.0 - 2025-11-16 01.01.20
// © Christian Vemmelund Helligsø
function getOrCreateUserId() {
  let userid = localStorage.getItem("userid");
  if (!userid) {
    userid = "user-" + Math.random().toString(36).slice(2);
    localStorage.setItem("userid", userid);
  }
  return userid;
}

function downloadAdminFile(filename, user_id) {
  fetch(`/api/admin/download/${filename}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id })
  })
    .then(res => {
      if (!res.ok) throw new Error("Download fejlede");
      return res.blob();
    })
    .then(blob => {
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    })
    .catch(() => alert("Kun hovedadmin kan hente filen eller filen findes ikke."));
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

async function isSuperadmin(user_id, device_id) {
    const res = await fetch("/api/is-superadmin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id, device_id })
    });
    const data = await res.json();
    return !!data.superadmin;
}

// Tilføj event listeners til modal-knapperne
document.addEventListener('DOMContentLoaded', async () => {
  const user_id = getOrCreateUserId();
  const device_id = getOrCreateDeviceId();

  // Tjek admin og superadmin status
  let isAdmin = false;
  let isSuperadmin = false;
  let myObserkode = "";

  try {
    // Tjek admin-status
    const adminRes = await fetch('/api/is-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id, device_id })
    });
    const adminData = await adminRes.json();
    isAdmin = !!adminData.admin;

    // Tjek superadmin-status via din funktion
    isSuperadmin = await isSuperadmin(user_id, device_id);
    myObserkode = adminData.obserkode || "";

    window.isAdmin = isAdmin;
    window.isSuperadmin = isSuperadmin;
    window.myObserkode = myObserkode;
  } catch {}

  // Vis adminpanel hvis admin eller superadmin
  if (isAdmin || isSuperadmin) {
    document.getElementById("admin-action-card").style.display = "flex";
    document.getElementById("show-admins-btn").style.display = "";
    document.getElementById("add-admin-btn").style.display = "";
    document.getElementById("add-art-btn").style.display = "";
    document.getElementById("sync-threads-btn").style.display = "";
    document.getElementById("traffic-btn").style.display = "";
  } else {
    document.getElementById("admin-action-card").style.display = "none";
  }

  if (window.isSuperadmin) {
    const user_id = getOrCreateUserId();
    const showBtn = document.getElementById("show-serverlog-btn");
    const modal = document.getElementById("serverlog-modal");
    const closeBtn = document.getElementById("close-serverlog-btn");
    const content = document.getElementById("serverlog-content");
    const downloadJsonBtn = document.getElementById("download-serverlog-json-btn"); // Tilføj denne knap i din modal-html

    if (showBtn && modal && closeBtn && content) {
      showBtn.onclick = async () => {
        content.textContent = "Henter log...";
        modal.style.display = "block";
        const res = await fetch("/api/admin/serverlog", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id })
        });
        if (res.ok) {
          const data = await res.json();
          content.textContent = data.log || "(ingen log)";
        } else {
          content.textContent = "Kunne ikke hente log";
        }
      };
      closeBtn.onclick = () => { modal.style.display = "none"; };

      // Download som TXT
      if (downloadJsonBtn && content) {
        downloadJsonBtn.onclick = () => {
          const blob = new Blob([content.textContent], { type: "text/plain" });
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "serverlog.txt";
          document.body.appendChild(a);
          a.click();
          a.remove();
          window.URL.revokeObjectURL(url);
        };
      }
    }
  }

  document.getElementById("traffic-btn").onclick = async function() {
    const panel = document.getElementById("traffic-panel");
    // Toggle: hvis synlig, så skjul og returnér
    if (panel.style.display === "block" || panel.style.display === "") {
      panel.style.display = "none";
      panel.innerHTML = "";
      return;
    }
    const user_id = getOrCreateUserId();
    const device_id = getOrCreateDeviceId();
    panel.innerHTML = "<em>Henter trafiktal...</em>";
    panel.style.display = "block";
    try {
      const res = await fetch("/api/admin/pageview-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id, device_id })
      });
      if (!res.ok) {
        panel.innerHTML = "<b>Ingen adgang eller fejl ved hentning.</b>";
        return;
      }
      const stats = await res.json();
      let html = "<h3>Trafik i dag</h3>";

      // Tilføj knapper til superadmin
      if (window.isSuperadmin) {
        html += `
          <div style="display:flex;gap:0.5em;align-items:center;margin-bottom:1em;">
            <button id="archive-traffic-log-btn">Gem masterlog nu</button>
            <button type="button" id="download-masterlog-btn">Download masterlog</button>
            <button type="button" id="download-pageviews-btn">Download pageviews.log</button>
          </div>
        `;
      }

      // Unikke brugere i alt og total visninger som card
      if (typeof stats.unique_users_total === "number" && typeof stats.total_views === "number") {
        html += `<div class="card" style="margin-bottom:1em;">
          <b>Unikke brugere i alt: ${stats.unique_users_total}</b><br>
          <b>Visninger i alt: ${stats.total_views}</b>
        </div><hr>`;
      }
      // Side-statistik som cards (inkl. traad.html)
      const pageStats = Object.entries(stats)
        .filter(([page, info]) =>
          page !== "unique_users_total" &&
          page !== "total_views" &&
          page !== "traad.html"
        )
        .sort((a, b) => (b[1].unique || 0) - (a[1].unique || 0)); // Sortér efter flest unikke brugere

      for (const [page, info] of pageStats) {
        let link = null;
        if (page.endsWith(".html")) {
          link = `/${page}`;
        }
        const cardHtml = `
          <div class="card" style="margin-bottom:0.5em;">
            <div style="font-weight:bold;">${page}</div>
            <div>Unikke brugere: <b>${info.unique}</b></div>
            <div>Visninger: <b>${info.total}</b></div>
          </div>
        `;
        if (link) {
          html += `<a href="${link}" style="text-decoration:none;color:inherit;">${cardHtml}</a>`;
        } else {
          html += cardHtml;
        }
      }

      // traad.html total som card
      if (stats["traad.html"]) {
        html += `<div class="card" style="margin-bottom:0.5em;">
          <div style="font-weight:bold;">traad.html (alle tråde)</div>
          <div>Unikke brugere: <b>${stats["traad.html"].unique}</b></div>
          <div>Visninger: <b>${stats["traad.html"].total}</b></div>
        </div><hr>`;

        // Pr. tråd som cards, sorteret efter flest unikke brugere
        const threads = Object.entries(stats["traad.html"].threads || {})
          .sort((a, b) => (b[1].unique || 0) - (a[1].unique || 0));
        for (const [thread, tinfo] of threads) {
          const match = thread.match(/(.+)-(\d{6,})-(\d{2}-\d{2}-\d{4})$/);
          let link = "#";
          if (match) {
            const id = match[1] + "-" + match[2];
            const date = match[3];
            link = `/traad.html?date=${encodeURIComponent(date)}&id=${encodeURIComponent(id)}`;
          }
          html += `<a href="${link}" style="text-decoration:none;color:inherit;">
            <div class="card" style="margin-bottom:0.5em;">
              <div style="font-weight:bold;">${thread}</div>
              <div>Unikke brugere: <b>${tinfo.unique}</b></div>
              <div>Visninger: <b>${tinfo.total}</b></div>
            </div>
          </a>`;
        }
      }

      // Tilføj grafer for superadmin
      if (window.isSuperadmin) {
        // Tilføj horisontal linje før første graf
        html += `<hr style="margin:1.5em 0;">
          <div class="card" style="margin-bottom:1em;">
            <h4>Traffik de sidste 7 dage</h4>
            <canvas id="traffic-graph-7d" height="120"></canvas>
          </div>
          <div class="card" style="margin-bottom:1em;">
            <h4>Traffik det sidste år</h4>
            <canvas id="traffic-graph-52w" height="120"></canvas>
          </div>
        `;
      }
      panel.innerHTML = html;    

      // Tilføj event handler til "Gem masterlog nu"-knap
      if (window.isSuperadmin) {
        const user_id = getOrCreateUserId();
        const masterlogBtn = document.getElementById("download-masterlog-btn");
        const pageviewsBtn = document.getElementById("download-pageviews-btn");
        const archiveBtn = document.getElementById("archive-traffic-log-btn");

        if (masterlogBtn) {
          masterlogBtn.onclick = () => downloadAdminFile('pageview_masterlog.jsonl', user_id);
        }
        if (pageviewsBtn) {
          pageviewsBtn.onclick = () => downloadAdminFile('pageviews.log', user_id);
        }
        if (archiveBtn) {
          archiveBtn.onclick = async function() {
            archiveBtn.disabled = true;
            archiveBtn.textContent = "Gemmer...";
            try {
              const res = await fetch("/api/admin/archive-pageview-log", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user_id })
              });
              if (res.ok) {
                archiveBtn.textContent = "Masterlog gemt!";
                setTimeout(() => {
                  archiveBtn.textContent = "Gem masterlog nu";
                  archiveBtn.disabled = false;
                }, 1500);
              } else {
                archiveBtn.textContent = "Fejl!";
                setTimeout(() => {
                  archiveBtn.textContent = "Gem masterlog nu";
                  archiveBtn.disabled = false;
                }, 1500);
              }
            } catch {
              archiveBtn.textContent = "Fejl!";
              setTimeout(() => {
                archiveBtn.textContent = "Gem masterlog nu";
                archiveBtn.disabled = false;
              }, 1500);
            }
          };
        }
      }

      panel.scrollIntoView({behavior: "smooth"});

      // Hent og vis grafer hvis superadmin
      if (window.isSuperadmin) {
        try {
          const res = await fetch("/api/admin/traffic-graphs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_id })
          });
          if (res.ok) {
            const data = await res.json();

            // VIS UNIKKE OBSERKODER TOTALT (kort øverst)
            if (data.last7 && data.last7.length) {
              // Vis total_db for seneste dag (sidste dag i last7 med data)
              const lastDayWithData = [...data.last7].reverse().find(d => d.unique_obserkoder_total_db > 0);
              const totalDb = lastDayWithData ? lastDayWithData.unique_obserkoder_total_db : 0;
              const panel = document.getElementById("traffic-panel");
              const card = document.createElement("div");
              card.className = "card";
              card.style.marginBottom = "1em";
              card.innerHTML = `<b>Unikke obserkoder i databasen: ${totalDb}</b>`;
              panel.insertBefore(card, panel.firstChild);
            }

            // Sidste 7 dage - brug dagsværdier for unique_obserkoder_total_db og users_total
            const labels7 = data.last7.map(d => d.date.slice(5));
            const users7 = data.last7.map(d => d.unique_users_total);
            const uniqueObserkoder7 = data.last7.map(d => d.unique_obserkoder_total_db);
            const usersTotal7 = data.last7.map(d => d.users_total);

            new Chart(document.getElementById("traffic-graph-7d").getContext("2d"), {
              type: "line",
              data: {
                labels: labels7,
                datasets: [
                  { label: "Unikke besøgende", data: users7, borderColor: "#0074D9", fill: false },
                  { label: "Unikke obserkoder", data: uniqueObserkoder7, borderColor: "#2ECC40", fill: false },
                  { label: "Antal enheder", data: usersTotal7, borderColor: "#FF4136", fill: false }
                ]
              },
              options: {
                responsive: true,
                plugins: { legend: { display: true } },
                scales: { y: { beginAtZero: true } }
              }
            });

            // 365-dages graf - brug dagsværdier for unique_obserkoder_total_db og users_total
            const allDates = (data.last365 || []).map(d => d.date);
            let minDate = allDates.length ? new Date(allDates[0]) : new Date();
            let maxDate = allDates.length ? new Date(allDates[allDates.length - 1]) : new Date();
            const today = new Date();
            if ((maxDate - minDate) / 86400000 < 6) {
              minDate = new Date(today);
              minDate.setDate(today.getDate() - 6);
              maxDate = today;
            }
            const dayMap = {};
            (data.last365 || []).forEach(d => { dayMap[d.date] = d; });

            const labels365 = [];
            const users365 = [];
            const uniqueObserkoder365 = [];
            const usersTotal365 = [];

            let d = new Date(minDate);
            while (d <= maxDate) {
              const ds = d.toISOString().slice(0, 10);
              labels365.push(ds);
              if (dayMap[ds]) {
                users365.push(dayMap[ds].unique_users_total);
                uniqueObserkoder365.push(dayMap[ds].unique_obserkoder_total_db);
                usersTotal365.push(dayMap[ds].users_total);
              } else {
                users365.push(0);
                uniqueObserkoder365.push(0);
                usersTotal365.push(0);
              }
              d.setDate(d.getDate() + 1);
            }

            new Chart(document.getElementById("traffic-graph-52w").getContext("2d"), {
              type: "line",
              data: {
                labels: labels365,
                datasets: [
                  { label: "Unikke besøgende", data: users365, borderColor: "#0074D9", fill: false, pointRadius: 0 },
                  { label: "Unikke obserkoder", data: uniqueObserkoder365, borderColor: "#2ECC40", fill: false, pointRadius: 0 },
                  { label: "Antal enheder", data: usersTotal365, borderColor: "#FF4136", fill: false, pointRadius: 0 }
                ]
              },
              options: {
                responsive: true,
                plugins: { legend: { display: true } },
                scales: {
                  y: { beginAtZero: true },
                  x: {
                    ticks: {
                      // Vis kun hver 30. dag label for overskuelighed, og altid sidste label
                      callback: function(val, idx) {
                        if (idx % 30 === 0 || idx === labels365.length - 1) return labels365[idx];
                        return "";
                      },
                      maxRotation: 0,
                      minRotation: 0
                    }
                  }
                }
              }
            });
          }
        } catch (e) {
          // ignore
        }
      }
      // --- slut på knap ---
    } catch (e) {
      panel.innerHTML = "<b>Fejl ved hentning af trafiktal.</b>";
    }
  };

  // "Administrer admins"-knap
  document.getElementById("show-admins-btn").onclick = async function() {
    const adminsPanel = document.getElementById("admins-panel");
    const csvPanel = document.getElementById("csv-file-list");
    const csvEditor = document.getElementById("csv-editor");
    const usersPanel = document.getElementById("all-users-list");
    // Skjul andre paneler
    if (csvPanel) csvPanel.style.display = "none";
    if (csvEditor) csvEditor.style.display = "none";
    if (usersPanel) usersPanel.style.display = "none";
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
    // Forvent: [{obserkode: "...", navn: "..."}]
    const admins = data.admins || [];

    const superRes = await fetch("/api/admin/superadmin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get", user_id })
    });
    const superData = await superRes.json();
    const superadmins = superData.superadmins || [];

    const listDiv = document.getElementById("admins-list");
    listDiv.innerHTML = "";
    admins.forEach(admin => {
      const obserkode = admin.obserkode || "";
      const navn = admin.navn || "";
      const card = document.createElement("div");
      card.className = "card";
      card.style.display = "flex";
      card.style.justifyContent = "space-between";
      card.style.alignItems = "center";
      card.style.marginBottom = "8px";
      card.style.gap = "8px";

      // Admin navn og obserkode
      const span = document.createElement("span");
      span.textContent = `${escapeHTML(obserkode)}${navn ? " - " + escapeHTML(navn) : ""}`;

      // Knap-wrapper
      const btnWrap = document.createElement("div");
      btnWrap.style.display = "flex";
      btnWrap.style.gap = "8px";
      btnWrap.style.justifyContent = "flex-end";
      btnWrap.style.alignItems = "center";

      // Mail-knap
      const mailBtn = document.createElement("button");
      mailBtn.type = "button";
      mailBtn.textContent = "Mail";
      mailBtn.style.padding = "2px 8px";
      mailBtn.style.margin = "0";
      mailBtn.style.verticalAlign = "middle";
      mailBtn.onclick = () => {
        window.open(
          `https://dofbasen.dk/mine/sendmailtouser.php?obserkode=${encodeURIComponent(obserkode)}`,
          "_blank"
        );
      };

      // Superadmin twostate-knap
      const isSuper = superadmins.includes(obserkode);
      const superBtn = document.createElement("button");
      superBtn.type = "button";
      superBtn.textContent = "Superadmin";
      superBtn.style.padding = "2px 8px";
      superBtn.style.margin = "0";
      superBtn.style.verticalAlign = "middle";
      superBtn.style.background = isSuper ? "#FFD700" : "#ccc";
      superBtn.style.color = isSuper ? "#333" : "#000";
      superBtn.onclick = async () => {
        if (!confirm(`Vil du ${isSuper ? "fjerne" : "tilføje"} superadmin-status for ${obserkode}?`)) return;
        await fetch("/api/admin/superadmin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "toggle", user_id, obserkode })
        });
        await loadAdminsList();
      };

      // Slet-knap
      const delBtn = document.createElement("button");
      delBtn.className = "remove-admin-btn";
      delBtn.type = "button";
      delBtn.textContent = "Slet";
      delBtn.setAttribute("data-obserkode", obserkode);
      delBtn.style.margin = "0";
      delBtn.style.padding = "2px 8px";
      delBtn.style.background = "#c00";
      delBtn.style.color = "#fff";
      delBtn.style.verticalAlign = "middle";

      btnWrap.appendChild(mailBtn);
      btnWrap.appendChild(superBtn);
      btnWrap.appendChild(delBtn);

      card.appendChild(span);
      card.appendChild(btnWrap);
      listDiv.appendChild(card);
    });

    // Slet-knapper
    listDiv.querySelectorAll(".remove-admin-btn").forEach(btn => {
      btn.onclick = async function() {
        const kode = btn.getAttribute("data-obserkode");
        if (kode === window.myObserkode && window.isSuperadmin) {
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
    { file: "data/arter_dof_content.csv", title: "Arter - DOF Content" }, // <-- tilføj denne linje
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
    const usersPanel = document.getElementById("all-users-list");
    // Skjul andre paneler
    if (adminsPanel) adminsPanel.style.display = "none";
    if (usersPanel) usersPanel.style.display = "none";
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
  

  document.getElementById("show-users-btn").onclick = async function() {
    const container = document.getElementById("all-users-list");
    const adminsPanel = document.getElementById("admins-panel");
    const csvPanel = document.getElementById("csv-file-list");
    const csvEditor = document.getElementById("csv-editor");
    // Skjul andre paneler
    if (adminsPanel) adminsPanel.style.display = "none";
    if (csvPanel) csvPanel.style.display = "none";
    if (csvEditor) csvEditor.style.display = "none";
    // Toggle brugere-panel
    if (container.style.display === "block") {
      container.style.display = "none";
      return;
    }
    // Ellers hent og vis listen
    const user_id = getOrCreateUserId();
    const res = await fetch(`/api/admin/all-users?user_id=${encodeURIComponent(user_id)}`);
    if (!res.ok) {
      alert("Kun hovedadmin kan se listen.");
      return;
    }
    const users = await res.json();
    if (!users.length) {
      container.innerHTML = "<em>Ingen brugere registreret</em>";
      container.style.display = "block";
      return;
    }
    // Tjek om hovedadmin
    const isHovedadmin = window.isSuperadmin; // Brug status fra backend!
    let html = `<table style="width:100%;border-collapse:collapse;border:1px solid #eee;">
      <thead>
        <tr style="background:var(--card-bg);">
          <th style="border:1px solid #eee;">Navn</th>
          <th style="border:1px solid #eee;">Obserkode</th>
          <th style="border:1px solid #eee;">Antal oprettede</th>
          <th style="text-align:center;border:1px solid #eee;">Mail</th>
          ${isHovedadmin ? '<th style="text-align:center;border:1px solid #eee;">Slet</th>' : ''}
        </tr>
      </thead>
      <tbody>`;
    users.forEach((u, idx) => {
      html += `<tr>
        <td style="border:1px solid #eee; padding-left:5px;">${escapeHTML(u.navn || "")}</td>
        <td style="text-align:center;border:1px solid #eee;">${escapeHTML(u.obserkode || "")}</td>
        <td style="text-align:center;border:1px solid #eee;">${u.antal_oprettede || 1}</td>
        <td style="text-align:center;border:1px solid #eee; vertical-align:middle;" id="mailbtn-${idx}"></td>
        ${isHovedadmin ? `<td style="text-align:center;border:1px solid #eee; vertical-align:middle;" id="deletebtn-${idx}"></td>` : ''}
      </tr>`;
    });
    container.innerHTML = html;
    container.style.display = "block";
    // Tilføj knapper
    users.forEach((u, idx) => {
      if (u.obserkode) {
        const td = document.getElementById(`mailbtn-${idx}`);
        const mailBtn = document.createElement("button");
        mailBtn.type = "button";
        mailBtn.textContent = "Mail";
        mailBtn.style.padding = "2px 8px";
        mailBtn.style.verticalAlign = "middle";
        mailBtn.style.margin = "0";
        td.style.verticalAlign = "middle";
        td.style.height = "40px";
        mailBtn.onclick = () => {
          window.open(
            `https://dofbasen.dk/mine/sendmailtouser.php?obserkode=${encodeURIComponent(u.obserkode)}`,
            "_blank"
          );
        };
        td.appendChild(mailBtn);
      }
      // Slet-knap kun for hovedadmin
      if (isHovedadmin) {
        const tdDel = document.getElementById(`deletebtn-${idx}`);
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.textContent = "Slet";
        delBtn.style.padding = "2px 8px";
        delBtn.style.background = "#c00";
        delBtn.style.color = "#fff";
        delBtn.style.verticalAlign = "middle";
        delBtn.style.margin = "0"; // <-- Tilføj denne linje
        tdDel.style.verticalAlign = "middle";
        tdDel.style.height = "40px";
        delBtn.onclick = async () => {
          if (confirm(`Er du sikker på at du vil slette brugeren "${u.navn || u.obserkode}" og alle data?`)) {
            const res = await fetch("/api/admin/delete-user", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ obserkode: u.obserkode, user_id })
            });
            const result = await res.json();
            if (result.ok) {
              alert("Bruger og alle data er slettet.");
              container.style.display = "none";
            } else {
              alert("Kunne ikke slette bruger: " + (result.detail || result.error || "Ukendt fejl"));
            }
          }
        };
        tdDel.appendChild(delBtn);
      }
    });
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

