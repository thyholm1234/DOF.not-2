// Version: 4.10.17 - 2025-12-08 00.46.39
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
      let html = "<h2 style='margin-top:0'>Trafik i dag</h2>";

      // Tilføj knapper til superadmin
      if (window.isSuperadmin) {
        html += `
          <div style="display:flex;gap:0.5em;align-items:center;margin-bottom:1em;">
            <button id="archive-traffic-log-btn">Gem masterlog nu</button>
            <button type="button" id="download-masterlog-btn">Download masterlog</button>
            <button type="button" id="download-pageviews-btn">Download pageviews.log</button>
            <button type="button" id="save-traffic-panel-png">Gem som PNG</button>
          </div>
        `;
      }

      // Unikke brugere i alt og total visninger som card
      if (typeof stats.unique_users_total === "number" && typeof stats.total_views === "number") {
        html += `<div class="card" style="margin-bottom:1em;">
          <b>Unikke brugere i alt: ${stats.unique_users_total}</b><br>
          <b>Visninger i alt: ${stats.total_views}</b>
        </div><hr style="margin:1em 0;">`;
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
      let sharelinkHtml = "";
      let notificationHtml = "";
      if (page === "obsid.html" && typeof info.sharelink === "number" && info.sharelink > 0) {
        sharelinkHtml = `<div>Fra sharelink: <b>${info.sharelink}</b></div>`;
      }
      if (page === "obsid.html" && typeof info.notification === "number" && info.notification > 0) {
        notificationHtml = `<div>Fra notifikation: <b>${info.notification}</b></div>`;
      }
      if (page === "traad.html" && typeof info.sharelink === "number" && info.sharelink > 0) {
        sharelinkHtml = `<div>Fra sharelink: <b>${info.sharelink}</b></div>`;
      }
      if (page === "traad.html" && typeof info.notification === "number" && info.notification > 0) {
        notificationHtml = `<div>Fra notifikation: <b>${info.notification}</b></div>`;
      }
      const cardHtml = `
        <div class="card" style="margin-bottom:0.5em;">
          <div style="font-weight:bold;">${page}</div>
          <div>Unikke brugere: <b>${info.unique}</b></div>
          <div>Visninger: <b>${info.total}</b></div>
          ${sharelinkHtml}
          ${notificationHtml}
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
        // Fold-ud container og knap
        html += `<div class="card" style="margin-bottom:0.5em; position:relative;">
          <div style="font-weight:bold;">traad.html (alle tråde)</div>
          <div>Unikke brugere: <b>${stats["traad.html"].unique}</b></div>
          <div>Visninger: <b>${stats["traad.html"].total}</b></div>
          ${stats["traad.html"].sharelink > 0 ? `<div>Fra sharelink: <b>${stats["traad.html"].sharelink}</b></div>` : ""}
          ${stats["traad.html"].notification > 0 ? `<div>Fra notifikation: <b>${stats["traad.html"].notification}</b></div>` : ""}
          <button id="toggle-threads-btn" style="position:absolute;top:10px;right:10px;">Vis tråde ▼</button>
          <div id="threads-list" style="display:none;margin-top:1em;"></div>
        </div><hr style="margin:1em 0;">`;

        // Pr. tråd som cards, sorteret efter flest unikke brugere
        const threads = Object.entries(stats["traad.html"].threads || {})
          .sort((a, b) => (b[1].unique || 0) - (a[1].unique || 0));
        let threadsHtml = "";
        for (const [thread, tinfo] of threads) {
          const match = thread.match(/(.+)-(\d{6,})-(\d{2}-\d{2}-\d{4})$/);
          let link = "#";
          if (match) {
            const id = match[1] + "-" + match[2];
            const date = match[3];
            link = `/traad.html?date=${encodeURIComponent(date)}&id=${encodeURIComponent(id)}`;
          }
          threadsHtml += `<a href="${link}" style="text-decoration:none;color:inherit;">
            <div class="card" style="margin-bottom:0.5em;">
              <div style="font-weight:bold;">${thread}</div>
              <div>Unikke brugere: <b>${tinfo.unique}</b></div>
              <div>Visninger: <b>${tinfo.total}</b></div>
              ${tinfo.sharelink > 0 ? `<div>Fra sharelink: <b>${tinfo.sharelink}</b></div>` : ""}
              ${tinfo.notification > 0 ? `<div>Fra notifikation: <b>${tinfo.notification}</b></div>` : ""}
            </div>
          </a>`;
        }
        setTimeout(() => {
          const btn = document.getElementById("toggle-threads-btn");
          const list = document.getElementById("threads-list");
          if (btn && list) {
            btn.onclick = function() {
              if (list.style.display === "none") {
                list.innerHTML = threadsHtml;
                list.style.display = "block";
                btn.textContent = "Skjul tråde ▲";
              } else {
                list.style.display = "none";
                btn.textContent = "Vis tråde ▼";
              }
            };
          }
        }, 0);

      }

      // Tilføj grafer for superadmin
      if (window.isSuperadmin) {
        // Tilføj horisontal linje før første graf
        html += `<div class="card" style="margin-bottom:1em;">
            <h4>Traffik de sidste 7 dage</h4>
            <canvas id="traffic-graph-7d" height="120"></canvas>
          </div>
          <div class="card" style="margin-bottom:1em;">
            <h4>Traffik det sidste år</h4>
            <canvas id="traffic-graph-52w" height="120"></canvas>
          </div>
          <div class="card" style="margin-bottom:1em;">
            <h4>Sidevisninger i dag</h4>
            <canvas id="traffic-graph-rolling" height="120"></canvas>
          </div>
          <hr style="margin:1em 0;">
          <div class="card" style="margin-bottom:1em;">
            <h4>PWA installation blandt brugere i dag</h4>
            <canvas id="traffic-pwa-pie" style="max-height:400px;height:400px;width:100%;"></canvas>
          </div>
          <div class="card" style="margin-bottom:1em;">
            <h4>Platforme og browsere pr. bruger i dag</h4>
            <canvas id="traffic-platform-bar" height="120"></canvas>
          </div>
        `;
      }
      panel.innerHTML = html;    

      // Kald rolling-grafen når DOM er opdateret
      refreshTrafficRollingGraph();

      setTimeout(() => {
        const saveBtn = document.getElementById("save-traffic-panel-png");
        if (saveBtn) {
          saveBtn.onclick = async function() {
            const panel = document.getElementById("traffic-panel");
            saveBtn.disabled = true;
            saveBtn.textContent = "Gemmer...";
            await html2canvas(panel, {
              backgroundColor: "#fff",
              scale: 3 // <-- højere opløsning
            }).then(canvas => {
              const link = document.createElement("a");
              link.download = "trafik-rapport.png";
              link.href = canvas.toDataURL();
              link.click();
            });
            saveBtn.disabled = false;
            saveBtn.textContent = "Gem som PNG";
          };
        }
      }, 0);

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

            // Sidste 7 dage - brug dagsværdier for unique_obserkoder_total_db og users_total
            const labels7 = data.last7.map(d => d.date.slice(5));
            const users7 = data.last7.map(d => d.unique_users_total);
            const uniqueObserkoder7 = data.last7.map(d => d.unique_obserkoder_total_db);
            const usersTotal7 = data.last7.map(d => d.users_total);
            const totalViews7 = data.last7.map(d => d.total_views);

            new Chart(document.getElementById("traffic-graph-7d").getContext("2d"), {
              type: "line",
              data: {
                labels: labels7,
                datasets: [
                  { label: "Unikke besøgende", data: users7, borderColor: "#0074D9", fill: false },
                  { label: "Unikke obserkoder", data: uniqueObserkoder7, borderColor: "#2ECC40", fill: false },
                  { label: "Antal enheder", data: usersTotal7, borderColor: "#FF4136", fill: false },
                  { label: "Sidevisninger", data: totalViews7, borderColor: "#888", fill: false, hidden: true  } // <-- tilføj denne linje
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
            let minDate, maxDate;
            const today = new Date();
            const todayStr = today.toISOString().slice(0, 10);

            // Vis altid mindst 14 dage (inkl. i dag)
            const minNeeded = new Date(today);
            minNeeded.setDate(today.getDate() - 13); // 14 dage inkl. i dag
            const minNeededStr = minNeeded.toISOString().slice(0, 10);

            if (allDates.length >= 1) {
              minDate = allDates[0];
              maxDate = allDates[allDates.length - 1];
              if (minDate > minNeededStr) minDate = minNeededStr;
              if (maxDate < todayStr) maxDate = todayStr;
            } else {
              minDate = minNeededStr;
              maxDate = todayStr;
            }

            const dayMap = {};
            (data.last365 || []).forEach(d => { dayMap[d.date] = d; });

            const labels365 = [];
            const users365 = [];
            const uniqueObserkoder365 = [];
            const usersTotal365 = [];
            const totalViews365 = []; // <-- tilføj denne linje

            let dObj = new Date(minDate);
            const maxObj = new Date(maxDate);

            while (dObj <= maxObj) {
              const ds = dObj.toISOString().slice(0, 10);
              labels365.push(ds);
              if (dayMap[ds]) {
                users365.push(dayMap[ds].unique_users_total);
                uniqueObserkoder365.push(dayMap[ds].unique_obserkoder_total_db);
                usersTotal365.push(dayMap[ds].users_total);
                totalViews365.push(dayMap[ds].total_views); // <-- tilføj denne linje
              } else {
                users365.push(0);
                uniqueObserkoder365.push(0);
                usersTotal365.push(0);
                totalViews365.push(0); // <-- tilføj denne linje
              }
              dObj.setDate(dObj.getDate() + 1);
            }

            new Chart(document.getElementById("traffic-graph-52w").getContext("2d"), {
              type: "line",
              data: {
                labels: labels365,
                datasets: [
                  { label: "Unikke besøgende", data: users365, borderColor: "#0074D9", fill: false, pointRadius: 0 },
                  { label: "Unikke obserkoder", data: uniqueObserkoder365, borderColor: "#2ECC40", fill: false, pointRadius: 0 },
                  { label: "Antal enheder", data: usersTotal365, borderColor: "#FF4136", fill: false, pointRadius: 0 },
                  { label: "Visninger", data: totalViews365, borderColor: "#888", fill: false, pointRadius: 0, hidden: true  } // <-- tilføj denne linje
                ]
              },
              options: {
                responsive: true,
                plugins: { legend: { display: true } },
                scales: {
                  y: { beginAtZero: true },
                  x: {
                    ticks: {
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
            // Brug userplatforms-data
            const userplatforms = data.userplatforms || {};
            // Doughnut: PWA installeret/ikke installeret
            if (userplatforms && typeof userplatforms.pwa_installed === "number") {
              new Chart(document.getElementById("traffic-pwa-pie").getContext("2d"), {
                type: "doughnut",
                data: {
                  labels: ["Installeret", "Ikke installeret"],
                  datasets: [{
                    data: [userplatforms.pwa_installed, userplatforms.pwa_not_installed],
                    backgroundColor: ["#2ECC40", "#FF4136"]
                  }]
                },
                options: {
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: { legend: { display: true } }
                }
              });
            }

            // Bar: OS/Browser kombinationer
            if (userplatforms && Array.isArray(userplatforms.platform_combinations)) {
              const combos = userplatforms.platform_combinations;
              const labels = combos.map(c => `${c.os} / ${c.browser}`);
              const counts = combos.map(c => c.count);
              new Chart(document.getElementById("traffic-platform-bar").getContext("2d"), {
                type: "bar",
                data: {
                  labels: labels,
                  datasets: [{
                    label: "Antal brugere",
                    data: counts,
                    backgroundColor: "#0074D9"
                  }]
                },
                options: {
                  responsive: true,
                  plugins: { legend: { display: false } },
                  scales: {
                    y: {
                      beginAtZero: true,
                      ticks: {
                        stepSize: 1,
                        callback: function(value) {
                          if (Number.isInteger(value)) return value;
                          return '';
                        }
                      }
                    }
                  }
                }
              });
            }

            // Tilføj tre kasser med udvikling
            const diff = data.diffs || {};
            const metrics = [
              { key: "unique_users_total", icon: "👤", color: "#0074D9" },
              { key: "unique_obserkoder_total_db", icon: "🦉", color: "#2ECC40" },
              { key: "users_total", icon: "📱", color: "#FF4136" },
              { key: "total_views", icon: "👁️", color: "#888" } // <-- tilføj denne linje
            ];

            function pctStr(val) {
              if (val === null || val === undefined) return "-";
              const pct = Math.round(val); // altid heltal
              return (pct > 0 ? "+" : "") + pct + "%";
            }
            function diffStr(val) {
              if (val === null || val === undefined) return "-";
              const n = Math.round(Number(val) || 0); // altid heltal
              return (n > 0 ? "+" : "") + n;
            }
            function formatInt(val) {
              if (val === null || val === undefined) return "-";
              const n = Math.round(Number(val) || 0); // altid heltal
              return String(n);
            }


            let cardsHtml = `<div style="display:flex;gap:1em;flex-wrap:wrap;margin-bottom:0em;">`;
            metrics.forEach(m => {
              const d = diff[m.key] || {};
              cardsHtml += `
                <div class="card" style="flex:1;min-width:220px;max-width:320px;border-left:6px solid ${m.color};">
                  <div style="font-size:2em;line-height:1">${m.icon}</div>
                  <div style="font-weight:bold;font-size:1.2em;margin-bottom:0.2em;">${d.label || ""}</div>
                  <div style="font-size:2em;margin-bottom:0.2em;">${formatInt(d.today)}</div>
                  <div style="font-size:0.95em;margin-bottom:0.2em;">
                    <span style="color:#888;">I går:</span> 
                    <b>${diffStr(d.diff_yesterday)}</b> 
                    <span style="color:#888;">(${pctStr(d.pct_yesterday)})</span>
                  </div>
                  <div style="font-size:0.95em;margin-bottom:0.2em;">
                    <span style="color:#888;">Uge siden:</span> 
                    <b>${diffStr(d.diff_week)}</b> 
                    <span style="color:#888;">(${pctStr(d.pct_week)})</span>
                  </div>
                  <div style="font-size:0.95em;">
                    <span style="color:#888;">Måned siden:</span> 
                    <b>${diffStr(d.diff_month)}</b> 
                    <span style="color:#888;">(${pctStr(d.pct_month)})</span>
                  </div>
                </div>
              `;
            });
            cardsHtml += `</div>`;

            
            // Indsæt kasserne før første graf-card
            const graphPanel = document.getElementById("traffic-panel");
            const firstGraphCard = document.getElementById("traffic-graph-7d")?.closest(".card");
            if (firstGraphCard) {
                firstGraphCard.insertAdjacentHTML("beforebegin", cardsHtml);
            } else {
                graphPanel.insertAdjacentHTML("afterbegin", cardsHtml);
            }

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
      csvPanel.innerHTML = `
        <h2>Vælg en fil</h2>
        <div class="card" style="margin:1em; display:flex; gap:1em; flex-wrap:wrap;">
          <button id="fetch-arter-csv-btn" style="margin:0;">Opdater arter</button>
          <button id="fetch-faenologi-btn" style="margin:0;">Opdater fænologi</button>
          <button id="fetch-bemaerk-btn" style="margin:0;">Opdater bemærkelsesværdige</button>
          <button id="fetch-all-btn" style="margin:0;">Opdater alt</button>
        </div>
        <ul>
          ${csvFiles.map(f => `<li><a href="#" onclick="loadCsvEditor('${f.file}', '${f.title}');return false;">${f.title}</a></li>`).join("")}
        </ul>
      `;
      csvPanel.style.display = "block";
      if (csvEditor) csvEditor.style.display = "none";

      const fetchAllBtn = document.getElementById("fetch-all-btn");
      if (fetchAllBtn) {
        fetchAllBtn.onclick = async function() {
          if (!confirm("Vil du opdatere alle arter, fænologi og bemærkelsesværdige?")) return;
          fetchAllBtn.disabled = true;
          fetchAllBtn.textContent = "Opdaterer alt...";
          try {
            // Opdater arter
            const arterBtn = document.getElementById("fetch-arter-csv-btn");
            arterBtn.disabled = true;
            arterBtn.textContent = "Opdaterer...";
            let res = await fetch("/api/admin/fetch-arter-csv", { method: "POST" });
            arterBtn.disabled = false;
            arterBtn.textContent = "Opdater arter fra DOFbasen";
            if (!res.ok) throw new Error("Fejl ved arter");

            // Opdater fænologi
            const faenologiBtn = document.getElementById("fetch-faenologi-btn");
            faenologiBtn.disabled = true;
            faenologiBtn.textContent = "Opdaterer...";
            res = await fetch("/api/admin/fetch-faenologi-csv", { method: "POST" });
            faenologiBtn.disabled = false;
            faenologiBtn.textContent = "Opdater fænologi";
            if (!res.ok) throw new Error("Fejl ved fænologi");

            // Opdater bemærkelsesværdige
            const bemaerkBtn = document.getElementById("fetch-bemaerk-btn");
            bemaerkBtn.disabled = true;
            bemaerkBtn.textContent = "Opdaterer...";
            res = await fetch("/api/admin/fetch-all-bemaerk-csv", { method: "POST" });
            bemaerkBtn.disabled = false;
            bemaerkBtn.textContent = "Opdater bemærkelsesværdige";
            if (!res.ok) throw new Error("Fejl ved bemærkelsesværdige");

            alert("Alle data opdateret!");
          } catch (e) {
            alert("Fejl under opdatering: " + (e.message || e));
          }
          fetchAllBtn.disabled = false;
          fetchAllBtn.textContent = "Opdater alt";
        };
      }

      // Tilføj event handler HER:
      document.getElementById("fetch-faenologi-btn").onclick = async function() {
        if (!confirm("Hent og opdater fænologi fra DOFbasen?")) return;
        const btn = this;
        btn.disabled = true;
        btn.textContent = "Opdaterer...";
        try {
          const res = await fetch("/api/admin/fetch-faenologi-csv", { method: "POST" });
          if (res.ok) {
            alert("Fænologi opdateret!");
          } else {
            alert("Fejl ved opdatering af fænologi.");
          }
        } catch {
          alert("Netværksfejl ved opdatering.");
        }
        btn.disabled = false;
        btn.textContent = "Opdater fænologi";
      };

      document.getElementById("fetch-bemaerk-btn").onclick = async function() {
        if (!confirm("Hent og opdater bemærkelsesværdige for alle regioner?")) return;
        const btn = this;
        btn.disabled = true;
        btn.textContent = "Opdaterer...";
        try {
          const res = await fetch("/api/admin/fetch-all-bemaerk-csv", { method: "POST" });
          if (res.ok) {
            alert("Bemærkelsesværdige opdateret!");
          } else {
            alert("Fejl ved opdatering af bemærkelsesværdige.");
          }
        } catch {
          alert("Netværksfejl ved opdatering.");
        }
        btn.disabled = false;
        btn.textContent = "Opdater bemærkelsesværdige";
      };

      const fetchBtn = document.getElementById("fetch-arter-csv-btn");
      if (fetchBtn) {
        fetchBtn.onclick = async function() {
          if (!confirm("Hent og opdater arter fra DOFbasen?")) return;
          const btn = this;
          btn.disabled = true;
          btn.textContent = "Opdaterer...";
          try {
            const res = await fetch("/api/admin/fetch-arter-csv", { method: "POST" });
            if (res.ok) {
              alert("Arter opdateret!");
            } else {
              alert("Fejl ved opdatering af arter.");
            }
          } catch {
            alert("Netværksfejl ved opdatering.");
          }
          btn.disabled = false;
          btn.textContent = "Opdater arter fra DOFbasen";
        };
      }
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
      alert("Kunne ikke hente brugere.");
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

  // --- Nyhedspanel ---
  function renderNewsPanel() {
  const user_id = getOrCreateUserId();
  const device_id = getOrCreateDeviceId();
  const html = `
    <div class="card" style="margin-bottom:1em;">
      <h2 style="margin-top:0;">Opret/redigér nyhed</h2>
      <form id="nyhedForm">
        <input type="hidden" name="id">
        <div class="card" style="margin-bottom:1em;">
          <label>Titel: <input name="titel" required style="width:100%;"></label>
        </div>
        <div class="card" id="body-preview-card" style="margin-bottom:1em;background:#f8f8f8;"></div>
        <div class="card" style="margin-bottom:1em;">
          <label>Brødtekst (markdown): <textarea name="body" required style="width:100%;height:100px;"></textarea></label>
        </div>
        <div style="display:flex;gap:1em;align-items:center;margin-bottom:1em;">
          <button type="submit" style="margin:0;">Gem nyhed</button>
          <button type="button" id="resetBtn" style="margin:0;">Ny tom</button>
          <button type="button" id="deleteBtn" style="margin:0;background:#c00;color:#fff;">Slet nyhed</button>
        </div>
        <label>Slettes: <input name="slet_tidspunkt" type="datetime-local" required></label>
        <label>Send notifikation til alle?
          <select name="send_notifikation">
            <option value="0" selected>Nej</option>
            <option value="1">Ja</option>
          </select>
        </label>
      </form>
      <div class="result" id="result"></div>
    </div>
    <h3>Aktuelle nyheder</h3>
    <div class="nyheder-list" id="nyhederList">Indlæser...</div>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  `;
  const panel = document.getElementById('news-panel');
  panel.innerHTML = html;
  panel.style.display = "block";

  // Live markdown preview
  const bodyInput = panel.querySelector('textarea[name="body"]');
  const titleInput = panel.querySelector('input[name="titel"]');
  const previewCard = panel.querySelector('#body-preview-card');

  function updatePreview() {
    const title = titleInput.value.trim();
    const body = bodyInput.value || "";
    previewCard.innerHTML =
      (title ? `<h2>${title}</h2>` : "") +
      marked.parse(body);
  }
  bodyInput.addEventListener("input", updatePreview);
  titleInput.addEventListener("input", updatePreview);
  updatePreview();

  // --- Nyhed JS ---
  function isoToLocal(iso) {
    if (!iso) return '';
    return iso.replace(' ', 'T').slice(0,16);
  }

  async function loadNyheder() {
    const list = document.getElementById('nyhederList');
    list.textContent = "Indlæser...";
    try {
      const res = await fetch('/api/nyheder');
      const nyheder = await res.json();
      if (!nyheder.length) {
        list.textContent = "Ingen nyheder.";
        return;
      }
      list.innerHTML = '';
      nyheder.forEach(n => {
        const div = document.createElement('div');
        div.className = 'card';
        div.style.marginBottom = "1em";
        div.innerHTML = `
          <h2 style="margin-bottom:0.3em;">${n.titel}</h2>
          <div style="font-size:0.92em;color:#888;margin-top:-0.5em;margin-bottom:0.5em;">
            ${n.forfatter} - ${n.oprettet_tidspunkt}
          </div>
          <div style="display:flex;gap:0.5em;margin-bottom:1em;">
            <button type="button" class="show-news-btn">Vis nyhed</button>
            <button type="button" class="edit-news-btn">Redigér</button>
            <button type="button" class="delete-news-btn" style="background:#c00;color:#fff;">Slet nyhed</button>
          </div>
        `;
        // Vis nyhed-knap
        div.querySelector('.show-news-btn').onclick = () => {
          window.open(`https://notifikation.dofbasen.dk/nyhed.html?id=${encodeURIComponent(n.id)}`, "_blank");
        };
        // Redigér-knap
        div.querySelector('.edit-news-btn').onclick = () => loadNyhedTilForm(n.id);
        // Slet-knap event
        div.querySelector('.delete-news-btn').onclick = async () => {
          if (!confirm('Er du sikker på at du vil slette denne nyhed?')) return;
          const user_id = getOrCreateUserId();
          const device_id = getOrCreateDeviceId();
          const res = await fetch('/api/admin/nyhed?id=' + encodeURIComponent(n.id), {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id, device_id })
          });
          const json = await res.json();
          if (res.ok && json.ok) {
            div.remove();
          } else {
            alert("Fejl: " + (json.detail || JSON.stringify(json)));
          }
        };
        list.appendChild(div);
      });
    } catch (e) {
      list.textContent = "Kunne ikke hente nyheder.";
    }
  }

  async function loadNyhedTilForm(id) {
    const resultDiv = document.getElementById('result');
    resultDiv.textContent = '';
    try {
      const res = await fetch('/api/admin/nyhed?id=' + encodeURIComponent(id));
      if (!res.ok) throw new Error("Nyhed ikke fundet");
      const n = await res.json();
      const f = document.getElementById('nyhedForm');
      f.id.value = n.id;
      f.titel.value = n.titel;
      f.body.value = n.body;
      f.slet_tidspunkt.value = isoToLocal(n.slet_tidspunkt || '');
      f.send_notifikation.value = "0"; // Altid default til Nej
    } catch (e) {
      resultDiv.textContent = "Kunne ikke hente nyheden.";
    }
  }

  document.getElementById('resetBtn').onclick = function() {
    const f = document.getElementById('nyhedForm');
    f.id.value = '';
    f.titel.value = '';
    f.body.value = '';
    f.slet_tidspunkt.value = '';
    f.send_notifikation.value = "0";
    document.getElementById('result').textContent = '';
  };

  document.getElementById('deleteBtn').onclick = async function() {
    const f = document.getElementById('nyhedForm');
    if (!f.id.value) return;
    if (!confirm('Er du sikker på at du vil slette denne nyhed?')) return;
    const user_id = getOrCreateUserId();
    const device_id = getOrCreateDeviceId();
    const resultDiv = document.getElementById('result');
    resultDiv.textContent = "Sletter...";
    try {
      const res = await fetch('/api/admin/nyhed?id=' + encodeURIComponent(f.id.value), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id, device_id })
      });
      const json = await res.json();
      if (res.ok && json.ok) {
        resultDiv.textContent = "Nyhed slettet!";
        f.id.value = '';
        f.titel.value = '';
        f.body.value = '';
        f.slet_tidspunkt.value = '';
        f.send_notifikation.value = "0";
        loadNyheder();
      } else {
        resultDiv.textContent = "Fejl: " + (json.detail || JSON.stringify(json));
      }
    } catch (err) {
      resultDiv.textContent = "Netværksfejl: " + err;
    }
  };

  document.getElementById('nyhedForm').onsubmit = async function(e) {
    e.preventDefault();
    const form = e.target;
    const data = {
      user_id: getOrCreateUserId(),
      device_id: getOrCreateDeviceId(),
      titel: form.titel.value,
      body: form.body.value,
      slet_tidspunkt: form.slet_tidspunkt.value,
      send_notifikation: form.send_notifikation.value
    };
    if (form.id.value) data.id = form.id.value;
    const resultDiv = document.getElementById('result');
    resultDiv.textContent = "Sender...";
    try {
      const res = await fetch('/api/admin/nyhed', {
        method: form.id.value ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const json = await res.json();
      if (res.ok && json.ok) {
        resultDiv.textContent = "Nyhed gemt! ID: " + json.id;
        loadNyheder();
      } else {
        resultDiv.textContent = "Fejl: " + (json.detail || JSON.stringify(json));
      }
    } catch (err) {
      resultDiv.textContent = "Netværksfejl: " + err;
    }
  };

  loadNyheder();
}

  // Fold ud med toolbar-knap
  document.getElementById('show-news-btn').onclick = function() {
    const panel = document.getElementById('news-panel');
    if (panel.style.display === "block") {
      panel.style.display = "none";
      panel.innerHTML = "";
    } else {
      renderNewsPanel();
    }
  }
});

// Tilføj knap i din HTML, fx: <button id="show-database-btn">Database</button>
function isAllRed(u, allAfd) {
  // Tjek for manglende eller tom obserkode
  const noObserkode = !(u.obserkode && typeof u.obserkode === "string" && u.obserkode.trim());
  // Tjek for advanced-flag: null, undefined, 0, false eller ikke sat
  const noAdv = !u.advanced || u.advanced === 0 || u.advanced === "0";
  // Tjek for alle lokalafdelinger: mangler, null, "Ingen", 0, tom streng eller undefined
  const allRedAfd = allAfd.every(afd => {
    if (!u.lokalafdelinger || typeof u.lokalafdelinger !== "object") return true;
    const val = u.lokalafdelinger[afd];
    return (
      val === undefined ||
      val === null ||
      val === "" ||
      val === "Ingen" ||
      val === 0 ||
      val === "0"
    );
  });
  return noObserkode && noAdv && allRedAfd;
}

document.getElementById("show-database-btn").onclick = async function() {
  const container = document.getElementById("database-list");
  // Toggle
  if (container.style.display === "block") {
    container.style.display = "none";
    return;
  }
  // Hent brugere
  const user_id = getOrCreateUserId();
  const device_id = getOrCreateDeviceId();
  const res = await fetch("/api/users-overview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id, device_id })
  });
  if (!res.ok) {
    alert("Kunne ikke hente brugere.");
    return;
  }
  let users = await res.json();

  // Find alle lokalafdelinger der findes
  const allAfd = [
    "DOF København", "DOF Nordsjælland", "DOF Vestsjælland", "DOF Storstrøm", "DOF Bornholm",
    "DOF Fyn", "DOF Sønderjylland", "DOF Sydvestjylland", "DOF Sydøstjylland", "DOF Vestjylland",
    "DOF Østjylland", "DOF Nordvestjylland", "DOF Nordjylland"
  ];
  // Korte navne til kolonneoverskrifter
  const afdShort = [
    "KBH", "NSJ", "VSJ", "STR", "BOR",
    "FYN", "SJL", "SVJ", "SØJ", "VEJ",
    "ØJY", "NVJ", "NJY"
  ];

  // Sortér: helt røde øverst, derefter brugere med obserkode øverst
  users.sort((a, b) => {
    const aRed = isAllRed(a, allAfd) ? 0 : 1;
    const bRed = isAllRed(b, allAfd) ? 0 : 1;
    if (aRed !== bRed) return aRed - bRed;
    const aHas = (a.obserkode && a.obserkode.trim()) ? 0 : 1;
    const bHas = (b.obserkode && b.obserkode.trim()) ? 0 : 1;
    if (aHas !== bHas) return aHas - bHas;
    // Sidste sortering: obserkode alfabetisk (tomme til sidst)
    const ao = (a.obserkode || "").toLowerCase();
    const bo = (b.obserkode || "").toLowerCase();
    if (ao && bo) return ao.localeCompare(bo);
    if (!ao && bo) return 1;
    if (ao && !bo) return -1;
    return 0;
  });

  let html = `<table style="width:auto;border-collapse:collapse;">
    <thead>
      <tr style="background:var(--card-bg);">
        <th style="border:1px solid #eee; position:sticky; top:0; background:var(--card-bg); z-index:2;">user_id</th>
        <th style="border:1px solid #eee; position:sticky; top:0; background:var(--card-bg); z-index:2;">obserkode</th>
        ${afdShort.map(short => `<th style="border:1px solid #eee;width:32px;height:32px;text-align:center;vertical-align:middle;font-size:11px; position:sticky; top:0; background:var(--card-bg); z-index:2;">${short}</th>`).join("")}
        <th style="border:1px solid #eee;width:32px;height:32px;text-align:center;vertical-align:middle; position:sticky; top:0; background:var(--card-bg); z-index:2;">Adv</th>
        <th style="border:1px solid #eee; position:sticky; top:0; background:var(--card-bg); z-index:2;">Slet</th>
      </tr>
    </thead>
    <tbody>`;
  users.forEach((u, idx) => {
    html += `<tr>
      <td style="border:1px solid #eee;">${escapeHTML(u.user_id)}</td>`;
    const obserkodeColor = (u.obserkode && u.obserkode.trim()) ? "#27ae60" : "#e74c3c";
    html += `<td style="border:1px solid #eee;background:${obserkodeColor};color:#fff;font-weight:bold;">${escapeHTML(u.obserkode || "")}</td>`;
    allAfd.forEach((afd, i) => {
      let val = (u.lokalafdelinger && u.lokalafdelinger[afd]) || "Ingen";
      let vis = val === "Bemærk" ? "BV" : (val === "Ingen" ? "" : escapeHTML(val));
      const color = val === "Ingen" ? "#e74c3c" : "#27ae60";
      html += `<td style="border:1px solid #eee;width:32px;height:32px;text-align:center;vertical-align:middle;background:${color};color:#fff;font-weight:bold;">${vis}</td>`;
    });
    // Advanced
    const advColor = u.advanced ? "#27ae60" : "#e74c3c";
    html += `<td style="border:1px solid #eee;width:32px;height:32px;text-align:center;vertical-align:middle;background:${advColor};color:#fff;font-weight:bold;">${u.advanced ? "1" : "0"}</td>`;
    // Slet-knap
    html += `<td style="border:1px solid #eee;text-align:center;">
        <button onclick="deleteUser('${u.user_id}', '${u.obserkode || ""}')">Slet</button>
      </td>
    </tr>`;
  });
  html += "</tbody></table>";
  container.innerHTML = html;
  container.style.display = "block";
};

// Slet-funktion
window.deleteUser = async function(target_user_id, obserkode) {
  if (!confirm("Er du sikker på at du vil slette denne bruger og alle data?")) return;
  const requester_id = getOrCreateUserId();
  // Byg body: brug obserkode hvis den findes, ellers target_user_id
  let body = { user_id: requester_id };
  if (obserkode && obserkode.trim()) {
    body.obserkode = obserkode;
  } else if (target_user_id) {
    body.target_user_id = target_user_id;
  } else {
    alert("Kan ikke slette: Mangler både user_id og obserkode.");
    return;
  }
  const res = await fetch("/api/admin/delete-user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await res.json();
  if (result.ok) {
  alert("Bruger og alle data er slettet.");
    // Fjern rækken fra tabellen uden reload
    const row = document.querySelector(`button[onclick*="'${target_user_id}'"]`)?.closest("tr");
    if (row) row.remove();
  } else {
    alert("Kunne ikke slette bruger: " + (result.detail || result.error || "Ukendt fejl"));
  }
};

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

let trafficGraphsTimer = null;
let trafficChart7d = null;
let traffic365Chart = null;
let trafficPwaPie = null;
let trafficPlatformBar = null;
let trafficRollingTimer = null; // <-- Tilføj denne linje

// Funktion til kun at opdatere rolling-grafen
async function refreshTrafficRollingGraph() {
  const user_id = getOrCreateUserId();
  try {
    const res = await fetch("/api/admin/pageviews-rolling", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id })
    });
    if (res.ok) {
      const rolling = await res.json();
      const ctx = document.getElementById("traffic-graph-rolling").getContext("2d");

      // Gem synlighed for datasets
      let hiddenRolling = {};
      if (window.trafficRollingChart) {
        window.trafficRollingChart.data.datasets.forEach((ds, i) => {
          hiddenRolling[ds.label] = window.trafficRollingChart.isDatasetVisible(i) === false;
        });
        window.trafficRollingChart.destroy();
      }

      window.trafficRollingChart = new Chart(ctx, {
        type: "line",
        data: {
          labels: rolling.intervals,
          datasets: [
            {
              label: "Sidevisninger (5 min)",
              data: rolling.counts,
              borderColor: "#888",
              backgroundColor: "rgba(136,136,136,0.1)",
              fill: false,
              pointRadius: 0,
              hidden: hiddenRolling["Sidevisninger (5 min)"] ?? false
            },
            {
              label: "Glidende snit (30 min)",
              data: rolling.rolling_30min,
              borderColor: "#0074D9",
              backgroundColor: "rgba(0,116,217,0.1)",
              fill: false,
              pointRadius: 0,
              hidden: hiddenRolling["Glidende snit (30 min)"] ?? true
            },
            {
              label: "Glidende snit (1 time)",
              data: rolling.rolling_1h,
              borderColor: "#2ECC40",
              backgroundColor: "rgba(46,204,64,0.1)",
              fill: false,
              pointRadius: 0,
              hidden: hiddenRolling["Glidende snit (1 time)"] ?? true
            },
            {
              label: "Glidende snit (2 timer)",
              data: rolling.rolling_2h,
              borderColor: "#FF4136",
              backgroundColor: "rgba(255,65,54,0.1)",
              fill: false,
              pointRadius: 0,
              hidden: hiddenRolling["Glidende snit (2 timer)"] ?? false // evt. true som default
            }
          ]
        },
        options: {
          responsive: true,
          plugins: { legend: { display: true } },
          scales: {
            y: { beginAtZero: true },
            x: {
              title: {
                display: true,
                text: "Tid på døgnet"
              },
              ticks: {
                autoSkip: false,
                callback: function(val, idx) {
                  if (idx % 12 === 0) {
                    const label = rolling.intervals[idx];
                    if (label && label.length >= 2) {
                      return label.slice(0, 2).replace(/^0/, '');
                    }
                    return label;
                  }
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

// Start/stop rolling-timer sammen med trafik-panelet
function startTrafficRollingTimer() {
  if (!trafficRollingTimer) {
    refreshTrafficRollingGraph(); // Opdater straks
    trafficRollingTimer = setInterval(refreshTrafficRollingGraph, 60000); // 15 sekunder
  }
}
function stopTrafficRollingTimer() {
  if (trafficRollingTimer) {
    clearInterval(trafficRollingTimer);
    trafficRollingTimer = null;
  }
}

// Opdater start/stop logik:
document.getElementById("traffic-btn").addEventListener("click", function() {
  setTimeout(() => {
    if (isTrafficPanelVisible()) {
      startTrafficGraphsTimer();
      startTrafficRollingTimer(); // <-- Tilføj denne linje
      refreshTrafficGraphsData();
    } else {
      stopTrafficGraphsTimer();
      stopTrafficRollingTimer(); // <-- Tilføj denne linje
    }
  }, 200);
});


// Funktion til kun at opdatere grafer og udviklingskasser
async function refreshTrafficGraphsData() {
  const panel = document.getElementById("traffic-panel");
  if (!panel || panel.style.display === "none") return;
  const user_id = getOrCreateUserId();

  try {
    const res = await fetch("/api/admin/traffic-graphs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id })
    });
    if (!res.ok) return;
    const data = await res.json();

    // --- Opdater udviklingskasser ---
    const diff = data.diffs || {};
    const metrics = [
      { key: "unique_users_total", icon: "👤", color: "#0074D9" },
      { key: "unique_obserkoder_total_db", icon: "🦉", color: "#2ECC40" },
      { key: "users_total", icon: "📱", color: "#FF4136" },
      { key: "total_views", icon: "👁️", color: "#888" }
    ];
    function pctStr(val) {
      if (val === null || val === undefined) return "-";
      const pct = Math.round(val);
      return (pct > 0 ? "+" : "") + pct + "%";
    }
    function diffStr(val) {
      if (val === null || val === undefined) return "-";
      const n = Math.round(Number(val) || 0);
      return (n > 0 ? "+" : "") + n;
    }
    function formatInt(val) {
      if (val === null || val === undefined) return "-";
      const n = Math.round(Number(val) || 0);
      return String(n);
    }

    // Fjern gamle udviklingskasser hvis de findes
    const oldDevCards = document.getElementById("traffic-dev-cards");
    if (oldDevCards) oldDevCards.remove();

    let cardsHtml = `<div id="traffic-dev-cards" style="display:flex;gap:1em;flex-wrap:wrap">`;
    metrics.forEach(m => {
      const d = diff[m.key] || {};
      cardsHtml += `
        <div class="card" style="flex:1;min-width:220px;max-width:320px;border-left:6px solid ${m.color};">
          <div style="font-size:2em;line-height:1">${m.icon}</div>
          <div style="font-weight:bold;font-size:1.2em;margin-bottom:0.2em;">${d.label || ""}</div>
          <div style="font-size:2em;margin-bottom:0.2em;">${formatInt(d.today)}</div>
          <div style="font-size:0.95em;margin-bottom:0.2em;">
            <span style="color:#888;">I går:</span> 
            <b>${diffStr(d.diff_yesterday)}</b> 
            <span style="color:#888;">(${pctStr(d.pct_yesterday)})</span>
          </div>
          <div style="font-size:0.95em;margin-bottom:0.2em;">
            <span style="color:#888;">Uge siden:</span> 
            <b>${diffStr(d.diff_week)}</b> 
            <span style="color:#888;">(${pctStr(d.pct_week)})</span>
          </div>
          <div style="font-size:0.95em;">
            <span style="color:#888;">Måned siden:</span> 
            <b>${diffStr(d.diff_month)}</b> 
            <span style="color:#888;">(${pctStr(d.pct_month)})</span>
          </div>
        </div>
      `;
    });
    cardsHtml += `</div>`;

    // Indsæt kasserne før første graf-card
    const graphPanel = document.getElementById("traffic-panel");
    const firstGraphCard = document.getElementById("traffic-graph-7d")?.closest(".card");
    if (firstGraphCard) {
        firstGraphCard.insertAdjacentHTML("beforebegin", cardsHtml);
    } else {
        graphPanel.insertAdjacentHTML("afterbegin", cardsHtml);
    }

    // --- Opdater grafer ---
    // 7 dage
    const labels7 = data.last7.map(d => d.date.slice(5));
    const users7 = data.last7.map(d => d.unique_users_total);
    const uniqueObserkoder7 = data.last7.map(d => d.unique_obserkoder_total_db);
    const usersTotal7 = data.last7.map(d => d.users_total);
    const totalViews7 = data.last7.map(d => d.total_views);

    // Gem synlighed for datasets i 7d-grafen
    let hidden7d = {};
    if (trafficChart7d) {
      trafficChart7d.data.datasets.forEach((ds, i) => {
        hidden7d[ds.label] = trafficChart7d.isDatasetVisible(i) === false;
      });
      trafficChart7d.destroy();
    }
    trafficChart7d = new Chart(document.getElementById("traffic-graph-7d").getContext("2d"), {
      type: "line",
      data: {
        labels: labels7,
        datasets: [
          { label: "Unikke besøgende", data: users7, borderColor: "#0074D9", fill: false, hidden: hidden7d["Unikke besøgende"] ?? false },
          { label: "Unikke obserkoder", data: uniqueObserkoder7, borderColor: "#2ECC40", fill: false, hidden: hidden7d["Unikke obserkoder"] ?? false },
          { label: "Antal enheder", data: usersTotal7, borderColor: "#FF4136", fill: false, hidden: hidden7d["Antal enheder"] ?? false },
          { label: "Sidevisninger", data: totalViews7, borderColor: "#888", fill: false, hidden: hidden7d["Sidevisninger"] ?? true }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: true } },
        scales: { y: { beginAtZero: true } }
      }
    });

    // 365 dage
    const allDates = (data.last365 || []).map(d => d.date);
    let minDate, maxDate;
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const minNeeded = new Date(today);
    minNeeded.setDate(today.getDate() - 13);
    const minNeededStr = minNeeded.toISOString().slice(0, 10);

    if (allDates.length >= 1) {
      minDate = allDates[0];
      maxDate = allDates[allDates.length - 1];
      if (minDate > minNeededStr) minDate = minNeededStr;
      if (maxDate < todayStr) maxDate = todayStr;
    } else {
      minDate = minNeededStr;
      maxDate = todayStr;
    }

    const dayMap = {};
    (data.last365 || []).forEach(d => { dayMap[d.date] = d; });

    const labels365 = [];
    const users365 = [];
    const uniqueObserkoder365 = [];
    const usersTotal365 = [];
    const totalViews365 = [];

    let dObj = new Date(minDate);
    const maxObj = new Date(maxDate);

    while (dObj <= maxObj) {
      const ds = dObj.toISOString().slice(0, 10);
      labels365.push(ds);
      if (dayMap[ds]) {
        users365.push(dayMap[ds].unique_users_total);
        uniqueObserkoder365.push(dayMap[ds].unique_obserkoder_total_db);
        usersTotal365.push(dayMap[ds].users_total);
        totalViews365.push(dayMap[ds].total_views);
      } else {
        users365.push(0);
        uniqueObserkoder365.push(0);
        usersTotal365.push(0);
        totalViews365.push(0);
      }
      dObj.setDate(dObj.getDate() + 1);
    }

    // Gem synlighed for datasets i 365d-grafen
    let hidden365 = {};
    if (traffic365Chart) {
      traffic365Chart.data.datasets.forEach((ds, i) => {
        hidden365[ds.label] = traffic365Chart.isDatasetVisible(i) === false;
      });
      traffic365Chart.destroy();
    }
    traffic365Chart = new Chart(document.getElementById("traffic-graph-52w").getContext("2d"), {
      type: "line",
      data: {
        labels: labels365,
        datasets: [
          { label: "Unikke besøgende", data: users365, borderColor: "#0074D9", fill: false, pointRadius: 0, hidden: hidden365["Unikke besøgende"] ?? false },
          { label: "Unikke obserkoder", data: uniqueObserkoder365, borderColor: "#2ECC40", fill: false, pointRadius: 0, hidden: hidden365["Unikke obserkoder"] ?? false },
          { label: "Antal enheder", data: usersTotal365, borderColor: "#FF4136", fill: false, pointRadius: 0, hidden: hidden365["Antal enheder"] ?? false },
          { label: "Sidevisninger", data: totalViews365, borderColor: "#888", fill: false, pointRadius: 0, hidden: hidden365["Sidevisninger"] ?? true }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: true } },
        scales: {
          y: { beginAtZero: true },
          x: {
            ticks: {
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

    // --- Opdater PWA doughnut ---
    const userplatforms = data.userplatforms || {};
    if (userplatforms && typeof userplatforms.pwa_installed === "number") {
      if (trafficPwaPie) trafficPwaPie.destroy();
      trafficPwaPie = new Chart(document.getElementById("traffic-pwa-pie").getContext("2d"), {
        type: "doughnut",
        data: {
          labels: ["Installeret", "Ikke installeret"],
          datasets: [{
            data: [userplatforms.pwa_installed, userplatforms.pwa_not_installed],
            backgroundColor: ["#2ECC40", "#FF4136"]
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: true } }
        }
      });
    }

    // --- Opdater platform-bar ---
    if (userplatforms && Array.isArray(userplatforms.platform_combinations)) {
      if (trafficPlatformBar) trafficPlatformBar.destroy();
      const combos = userplatforms.platform_combinations;
      const labels = combos.map(c => `${c.os} / ${c.browser}`);
      const counts = combos.map(c => c.count);
      trafficPlatformBar = new Chart(document.getElementById("traffic-platform-bar").getContext("2d"), {
        type: "bar",
        data: {
          labels: labels,
          datasets: [{
            label: "Antal brugere",
            data: counts,
            backgroundColor: "#0074D9"
          }]
        },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                stepSize: 1,
                callback: function(value) {
                  if (Number.isInteger(value)) return value;
                  return '';
                }
              }
            }
          }
        }
      });
    }
  } catch (e) {
    // evt. fejl-håndtering
  }
}

// Timer-setup
function isTrafficPanelVisible() {
  const panel = document.getElementById("traffic-panel");
  return panel && panel.style.display === "block";
}

function startTrafficGraphsTimer() {
  if (!trafficGraphsTimer) {
    trafficGraphsTimer = setInterval(() => {
      if (isTrafficPanelVisible()) refreshTrafficGraphsData();
    }, 30000); // 30 sekunder
  }
}

function stopTrafficGraphsTimer() {
  if (trafficGraphsTimer) {
    clearInterval(trafficGraphsTimer);
    trafficGraphsTimer = null;
  }
}

// Start/stop timer når trafik-panelet åbnes/lukkes
document.getElementById("traffic-btn").addEventListener("click", function() {
  setTimeout(() => {
    if (isTrafficPanelVisible()) {
      startTrafficGraphsTimer();
      refreshTrafficGraphsData(); // Opdater straks ved åbning
    } else {
      stopTrafficGraphsTimer();
    }
  }, 200);
});

