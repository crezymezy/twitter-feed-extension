/* X Fresh Feed Tracker — background service worker (v1.1)
 * - receives fresh tweets from the content script
 * - global dedup + ring buffer in storage.local
 * - optional desktop notifications (click opens the post)
 * - optional Telegram forwarding (English, tidy format) to a group
 * - optional forwarding to a local live API (POST /ingest)
 * - exposes the live feed to localhost pages (external messaging API)
 * - optional auto-reload of X tabs (chrome.alarms)
 */
"use strict";

const DEFAULTS = {
  freshnessMinutes: 15,
  trackedHandles: [],
  notifyEnabled: true,
  requireTrackedOnly: false,
  autoReloadSeconds: 0,
  telegramEnabled: false,
  telegramBotToken: "",
  telegramChatId: "",
  includeMedia: false,
  apiEnabled: false,
  apiUrl: "http://127.0.0.1:8787",
  maxFeed: 500
};
const FEED_KEY = "feed";
const SEEN_KEY = "seen";
const AUTO_ALARM = "xfft-auto-reload";

let _tgCooldown = {}; // chatId -> ts (simple rate-limit)

async function getCfg() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

async function getStore(keys) {
  return chrome.storage.local.get(keys);
}

/* ── English, tidy Telegram message ─────────────────────────────────────── */
function formatTweetEN(t) {
  const age = t.ageMin == null ? "" : `${Math.round(t.ageMin)} min ago`;
  const star = t.tracked ? " ⭐" : "";
  const text = (t.text || "(no text)").replace(/[<>]/g, "").trim().slice(0, 700);

  // Media as links (preferred): images + video link
  const media = [];
  if (Array.isArray(t.images)) {
    for (const u of t.images.slice(0, 4)) if (u) media.push(`🖼 ${u}`);
  }
  if (t.videoUrl) media.push(`🎬 ${t.videoUrl}`);
  const mediaBlock = media.length ? "\n\n" + media.join("\n") : "";

  return (
    `🟢 <b>New post</b> — @${t.handle}${star}\n\n` +
    `${text}\n\n` +
    `🔗 ${t.url}${mediaBlock}\n` +
    `⏱ ${age}`
  );
}

async function sendTelegram(tweet, cfg) {
  if (!cfg.telegramEnabled) return;
  const token = (cfg.telegramBotToken || "").trim();
  const chat = (cfg.telegramChatId || "").trim();
  if (!token || !chat) return;

  // simple rate-limit: max ~1 msg / 2s per chat
  const now = Date.now();
  if (now - (_tgCooldown[chat] || 0) < 2000) return;
  _tgCooldown[chat] = now;

  const caption = formatTweetEN(tweet).slice(0, 1024);
  const base = `https://api.telegram.org/bot${token}`;
  const imgs = Array.isArray(tweet.images) ? tweet.images.filter(Boolean).slice(0, 10) : [];

  try {
    // Optional: attach images as files (album). Default = images are sent as links
    // inside the text message (so they are clickable even if Telegram cannot fetch them).
    if (cfg.includeMedia === true && imgs.length) {
      const media = imgs.map((u, i) => (
        i === 0
          ? { type: "photo", media: u, caption, parse_mode: "HTML" }
          : { type: "photo", media: u }
      ));
      const res = await fetch(`${base}/sendMediaGroup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, media: JSON.stringify(media) })
      });
      if (res.ok) return;
      const body = await res.text().catch(() => "");
      console.warn("[XFFT] sendMediaGroup failed", res.status, body.slice(0, 120), "-> text fallback");
    }

    const res2 = await fetch(`${base}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text: caption,
        parse_mode: "HTML",
        disable_web_page_preview: false
      })
    });
    if (!res2.ok) {
      const body = await res2.text().catch(() => "");
      console.warn("[XFFT] Telegram error", res2.status, body.slice(0, 120));
    }
  } catch (e) {
    console.warn("[XFFT] Telegram send failed", e && e.message);
  }
}

async function postToApi(tweets, cfg) {
  if (!cfg.apiEnabled) return;
  const base = (cfg.apiUrl || "").replace(/\/+$/, "");
  if (!base) return;
  try {
    await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "x-fresh-feed", tweets })
    });
  } catch (e) {
    console.warn("[XFFT] API post failed", e && e.message);
  }
}

/* ── Core: store + distribute ───────────────────────────────────────────── */
async function pushTweets(tweets) {
  const cfg = await getCfg();
  const { [FEED_KEY]: feed = [], [SEEN_KEY]: seen = {} } =
    await getStore([FEED_KEY, SEEN_KEY]);

  const fresh = [];
  for (const t of tweets) {
    if (!t || !t.id) continue;
    if (seen[t.id]) continue;
    seen[t.id] = Date.now();
    fresh.push(t);
  }
  if (!fresh.length) return;

  const merged = fresh.concat(feed).slice(0, cfg.maxFeed);

  const seenKeys = Object.keys(seen);
  if (seenKeys.length > 5000) {
    seenKeys.sort((a, b) => seen[a] - seen[b]);
    for (const k of seenKeys.slice(0, seenKeys.length - 5000)) delete seen[k];
  }

  await chrome.storage.local.set({ [FEED_KEY]: merged, [SEEN_KEY]: seen });

  if (cfg.notifyEnabled) {
    for (const t of fresh.slice(0, 3)) {
      try {
        chrome.notifications.create("xfft-" + t.id, {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title: `@${t.handle}${t.tracked ? " ⭐" : ""} • ${Math.round(t.ageMin)}min`,
          message: (t.text || "(no text)").slice(0, 220),
          priority: 2,
          requireInteraction: false
        });
      } catch (e) {}
    }
  }

  // Forward to Telegram + local API
  for (const t of fresh) { await sendTelegram(t, cfg); }
  await postToApi(fresh, cfg);

  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#1d9bf0" });
    await chrome.action.setBadgeText({ text: String(merged.length > 99 ? "99+" : merged.length) });
  } catch (e) {}
}

/* ── Notifications click → open post ────────────────────────────────────── */
chrome.notifications.onClicked.addListener(async (notifId) => {
  const id = notifId.replace(/^xfft-/, "");
  const { [FEED_KEY]: feed = [] } = await getStore([FEED_KEY]);
  const t = feed.find((x) => String(x.id) === String(id));
  if (t && t.url) chrome.tabs.create({ url: t.url });
  chrome.notifications.clear(notifId);
});

/* ── Auto reload ────────────────────────────────────────────────────────── */
async function reloadXTabs() {
  const tabs = await chrome.tabs.query({
    url: ["https://x.com/*", "https://twitter.com/*"]
  });
  for (const tab of tabs) {
    try { await chrome.tabs.reload(tab.id); } catch (e) {}
  }
}

async function applyAutoReload() {
  const cfg = await getCfg();
  try { await chrome.alarms.clear(AUTO_ALARM); } catch (e) {}
  const sec = Number(cfg.autoReloadSeconds) || 0;
  if (sec >= 30) {
    chrome.alarms.create(AUTO_ALARM, { periodInMinutes: Math.max(0.5, sec / 60) });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_ALARM) reloadXTabs();
});

/* ── Internal messages (popup/content) ──────────────────────────────────── */
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === "freshTweets" && Array.isArray(msg.tweets)) {
    pushTweets(msg.tweets).then(() => reply && reply({ ok: true }));
    return true;
  }
  if (msg && msg.type === "reloadXTabs") {
    reloadXTabs().then(() => reply && reply({ ok: true }));
    return true;
  }
  if (msg && msg.type === "clearFeed") {
    chrome.storage.local.set({ [FEED_KEY]: [] }).then(() => {
      chrome.action.setBadgeText({ text: "" });
      reply && reply({ ok: true });
    });
    return true;
  }
  if (msg && msg.type === "getFeed") {
    (async () => {
      const { [FEED_KEY]: feed = [] } = await getStore([FEED_KEY]);
      reply({ ok: true, count: feed.length, feed });
    })();
    return true;
  }
  if (msg && msg.type === "testTelegram") {
    (async () => {
      const cfg = await getCfg();
      const token = (cfg.telegramBotToken || "").trim();
      const chat = (cfg.telegramChatId || "").trim();
      if (!token || !chat) { reply({ ok: false, error: "missing_token_or_chat" }); return; }
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chat, text: "✅ X Fresh Feed Tracker connected. This group will receive fresh posts in English.", parse_mode: "HTML" })
        });
        const body = await res.json().catch(() => ({}));
        reply({ ok: res.ok, status: res.status, description: body.description || "" });
      } catch (e) {
        reply({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
  return false;
});

/* ── External messaging API (localhost pages can read the live feed) ─────── */
chrome.runtime.onMessageExternal.addListener((msg, _sender, reply) => {
  if (!msg) return false;
  if (msg.type === "ping") { reply({ ok: true, app: "xfft", version: "1.1.0" }); return true; }
  if (msg.type === "getFeed") {
    (async () => {
      const { [FEED_KEY]: feed = [] } = await getStore([FEED_KEY]);
      const limit = Number(msg.limit) || 100;
      reply({ ok: true, count: feed.length, feed: feed.slice(0, limit) });
    })();
    return true;
  }
  return false;
});

/* ── Lifecycle ──────────────────────────────────────────────────────────── */
chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.sync.get(DEFAULTS);
  await chrome.storage.sync.set({ ...DEFAULTS, ...s });
  applyAutoReload();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.autoReloadSeconds) applyAutoReload();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
});
