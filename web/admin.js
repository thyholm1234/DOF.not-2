// Version: 4.3.10.15 - 2025-11-10 21.52.00
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
          <strong>${comment.navn}${comment.obserkode ? " (" + comment.obserkode + ")" : ""}</strong><br>
          ${comment.body}
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
});

