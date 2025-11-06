// Version: 4.3.3.7 - 2025-11-06 22.16.51
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

async function blacklistObsid(obsid) {
  const user_id = getOrCreateUserId();
  await fetch("/api/admin/blacklist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ obsid, user_id })
  });
  await loadCommentThreads();
}

async function unblacklistObsid(obsid) {
  const user_id = getOrCreateUserId();
  await fetch("/api/admin/unblacklist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ obsid, user_id })
  });
  await loadBlacklist();
}

async function loadCommentThreads() {
  const res = await fetch("/api/admin/comments");
  if (res.ok) {
    const threads = await res.json();
    const container = document.getElementById("comment-threads");
    container.innerHTML = "";
    threads.forEach(thread => {
      const threadHeader = document.createElement("h3");
      threadHeader.textContent = `${thread.art_lokation} (${thread.day})`;
      container.appendChild(threadHeader);

      thread.comments.forEach(comment => {
        const commentCard = document.createElement("div");
        commentCard.className = "card";
        commentCard.style.marginBottom = "1em";
        commentCard.style.position = "relative";
        commentCard.innerHTML = `
          <strong>${comment.navn}${comment.obserkode ? ", " + comment.obserkode : ""}</strong><br>
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
          btn.onclick = () => showBlacklistModal(comment.obserkode);
          btnWrap.appendChild(btn);

          commentCard.appendChild(btnWrap);
        }
        container.appendChild(commentCard);
      });
    });
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
    if (list.length === 0) {
      container.innerHTML = "<p>Ingen blacklistede observationer.</p>";
      return;
    }
    list.forEach(obserkode => {
      const card = document.createElement("div");
      card.className = "card";
      card.style.marginBottom = "1em";
      card.innerHTML = `
        <strong>${obserkode}</strong><br>
        <button type="button" class="unblacklist-btn">Ophæv blacklist</button>
      `;
      card.querySelector(".unblacklist-btn").onclick = () => unblacklistObsid(obserkode);
      container.appendChild(card);
    });
  }
}

let blacklistObserkode = null;

function showBlacklistModal(obserkode) {
  blacklistObserkode = obserkode;
  document.getElementById("blacklist-modal-obserkode").textContent = "Obserkode: " + obserkode;
  document.getElementById("blacklist-reason").value = "";
  document.getElementById("blacklist-modal").style.display = "flex";
}

function hideBlacklistModal() {
  document.getElementById("blacklist-modal").style.display = "none";
}

document.addEventListener('DOMContentLoaded', async () => {
  const user_id = getOrCreateUserId();
  const device_id = getOrCreateDeviceId();
  try {
    const res = await fetch(`/api/is-admin?user_id=${encodeURIComponent(user_id)}&device_id=${encodeURIComponent(device_id)}`);
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
});