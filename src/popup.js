"use strict";
const FEED_KEY = "feed";

const $ = (id) => document.getElementById(id);

function ageLabel(min) {
  if (min < 1) return "just now";
  if (min < 60) return `${Math.round(min)} min`;
  return `${(min / 60).toFixed(1)} h`;
}

function esc(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
  ));
}

async function render() {
  const { [FEED_KEY]: feed = [] } = await chrome.storage.local.get([FEED_KEY]);
  const cfg = await chrome.storage.sync.get({ freshnessMinutes: 15, trackedHandles: [] });

  const now = Date.now();
  const items = feed
    .map((t) => ({ ...t, ageMin: t.ts ? (now - t.ts) / 60000 : t.ageMin }))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 60);

  const tracked = (cfg.trackedHandles || []).length;
  $("meta").textContent =
    `${items.length} saved posts · fresh <${cfg.freshnessMinutes} min · ` +
    (tracked ? `${tracked} tracked accounts` : "all authors");

  const list = $("list");
  if (!items.length) {
    list.innerHTML = `<li class="empty">No fresh posts yet.<br>` +
      `Open <b>x.com/home</b> (ideally with your tracking account) and click “Scan now”.</li>`;
    return;
  }

  list.innerHTML = items.map((t) => {
    const fresh = t.ageMin <= cfg.freshnessMinutes;
    return `<li data-url="${esc(t.url)}">
      <div class="top">
        <span class="who">@${esc(t.handle)}${t.tracked ? ' <span class="star">⭐</span>' : ""}</span>
        <span class="age ${fresh ? "" : "old"}">${ageLabel(t.ageMin)}</span>
      </div>
      <div class="txt">${esc((t.text || "(no text)").slice(0, 200))}</div>
    </li>`;
  }).join("");

  [...list.querySelectorAll("li[data-url]")].forEach((li) => {
    li.addEventListener("click", () => chrome.tabs.create({ url: li.dataset.url }));
  });
}

async function activeXTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && /https:\/\/(x|twitter)\.com\//.test(tab.url)) return tab;
  return null;
}

$("scan").addEventListener("click", async () => {
  const tab = await activeXTab();
  if (!tab) { $("meta").textContent = "Please open x.com in the active tab."; return; }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "scanNow" });
    setTimeout(render, 700);
  } catch (e) {
    $("meta").textContent = "Scan failed — reload the page (F5) and try again.";
  }
});

$("reload").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reloadXTabs" });
  setTimeout(render, 1500);
});

$("clear").addEventListener("click", async () => {
  await chrome.storage.local.set({ [FEED_KEY]: [] });
  try { await chrome.action.setBadgeText({ text: "" }); } catch (e) {}
  chrome.runtime.sendMessage({ type: "clearFeed" });
  render();
});

$("opts").addEventListener("click", () => chrome.runtime.openOptionsPage());

render();
setInterval(render, 3000);
