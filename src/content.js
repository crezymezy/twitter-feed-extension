/* X Fresh Feed Tracker — content script
 * Runs on x.com / twitter.com. Reads visible tweets from the feed
 * (home/list/profile), filters by freshness + optionally tracked accounts,
 * and reports new posts to the background (notifications + popup list).
 *
 * No login trick, no API key: purely client-side via the DOM the browser
 * already renders. Works best with a tracking account that follows only the
 * accounts you care about.
 */
(() => {
  "use strict";

  const DEFAULTS = {
    freshnessMinutes: 15,     // "very fresh" = younger than X minutes
    trackedHandles: [],       // empty = all authors in the feed
    notifyEnabled: true,
    requireTrackedOnly: false // true = ONLY tracked accounts (otherwise all, marked)
  };

  const seen = new Set();     // status IDs already reported by this page
  let cfg = { ...DEFAULTS };

  async function loadConfig() {
    try {
      const s = await chrome.storage.sync.get(DEFAULTS);
      cfg = {
        freshnessMinutes: Number(s.freshnessMinutes) || DEFAULTS.freshnessMinutes,
        trackedHandles: (Array.isArray(s.trackedHandles) ? s.trackedHandles : [])
          .map((h) => String(h).replace(/^@/, "").trim().toLowerCase()).filter(Boolean),
        notifyEnabled: s.notifyEnabled !== false,
        requireTrackedOnly: s.requireTrackedOnly === true
      };
    } catch (e) { /* keep defaults */ }
  }

  function firstStatusAnchor(article) {
    // <a href="/user/status/123..."> containing a <time datetime="...">
    const times = article.querySelectorAll("time[datetime]");
    for (const t of times) {
      const a = t.closest("a[href*='/status/']");
      if (a) return { anchor: a, time: t };
    }
    const a = article.querySelector("a[href*='/status/']");
    return a ? { anchor: a, time: null } : null;
  }

  function parseTweet(article) {
    try {
      const sa = firstStatusAnchor(article);
      if (!sa) return null;
      const href = sa.anchor.getAttribute("href") || "";
      const idMatch = href.match(/\/status\/(\d+)/);
      const id = idMatch ? idMatch[1] : href;

      // Author (handle): first link to /<handle> inside the User-Name row
      let handle = "";
      const nameBlock = article.querySelector("[data-testid='User-Name']");
      if (nameBlock) {
        const links = nameBlock.querySelectorAll("a[href^='/']");
        for (const l of links) {
          const h = l.getAttribute("href") || "";
          const m = h.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
          if (m && !h.includes("/status/")) { handle = m[1]; break; }
        }
      }
      if (!handle) {
        const m = href.match(/^\/([A-Za-z0-9_]{1,15})\/status\//);
        if (m) handle = m[1];
      }

      const textEl = article.querySelector("[data-testid='tweetText']");
      const text = textEl ? textEl.innerText.trim() : "";

      let iso = null;
      if (sa.time) iso = sa.time.getAttribute("datetime");
      const ts = iso ? Date.parse(iso) : Date.now();
      const ageMin = isFinite(ts) ? (Date.now() - ts) / 60000 : 0;

      const display = nameBlock
        ? (nameBlock.querySelector("span")?.innerText || "").trim()
        : "";

      // Media: images (album) + video link (we do not download video; we share the link)
      const images = [];
      article.querySelectorAll("img[src*='pbs.twimg.com/media']").forEach((im) => {
        const u = im.getAttribute("src") || "";
        if (!u) return;
        const base = u.split("?")[0];
        const full = base + "?format=jpg&name=large";
        if (!images.includes(full)) images.push(full);
      });
      const hasVideo = !!article.querySelector(
        "[data-testid='videoPlayer'], [data-testid='videoComponent'], video"
      );
      let videoUrl = null;
      if (hasVideo && handle && id) {
        videoUrl = `https://x.com/${handle}/status/${id}/video/1`;
      }

      return {
        id: String(id),
        handle: (handle || "?").toLowerCase(),
        display,
        text: text.slice(0, 600),
        url: "https://x.com" + href,
        images: images.slice(0, 10),
        videoUrl,
        iso,
        ts,
        ageMin: Math.round(ageMin * 10) / 10
      };
    } catch (e) {
      return null;
    }
  }

  function scan(articles) {
    const out = [];
    for (const a of articles) {
      const t = parseTweet(a);
      if (!t) continue;
      if (seen.has(t.id)) continue;
      if (t.ageMin > cfg.freshnessMinutes) continue;         // not fresh enough
      if (cfg.trackedHandles.length) {
        const tracked = cfg.trackedHandles.includes(t.handle);
        if (cfg.requireTrackedOnly && !tracked) continue;
        t.tracked = tracked;
      }
      seen.add(t.id);
      out.push(t);
    }
    return out;
  }

  function sendBatch(list) {
    if (!list.length) return;
    try {
      chrome.runtime.sendMessage({ type: "freshTweets", tweets: list });
    } catch (e) { /* service worker may be inactive */ }
  }

  function scanAll() {
    const arts = document.querySelectorAll("article[data-testid='tweet']");
    const fresh = scan(arts);
    if (fresh.length) {
      console.log("[XFFT] fresh:", fresh.length, fresh.map(t => "@" + t.handle));
      sendBatch(fresh);
    }
    return fresh;
  }

  // Popup requests a manual scan
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === "scanNow") {
      loadConfig().then(() => { const r = scanAll(); reply({ ok: true, count: r.length }); });
      return true; // async
    }
  });

  // Observe new tweets (SPA keeps scrolling/updating)
  let timer = null;
  function scheduleScan() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; scanAll(); }, 800);
  }

  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.addedNodes && m.addedNodes.length) { scheduleScan(); return; }
    }
  });

  function startObserving() {
    const target = document.querySelector("main") || document.body;
    obs.observe(target, { childList: true, subtree: true });
  }

  (async () => {
    await loadConfig();
    // Apply config changes live
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "sync") loadConfig();
      });
    } catch (e) {}
    startObserving();
    // first scan + periodic fallback
    setTimeout(scanAll, 1500);
    setInterval(scanAll, 20000);
    console.log("[XFFT] active on", location.host);
  })();
})();
