# 🔥 X Fresh Feed Tracker — Chrome Extension (v1.1)

Chrome/Edge/Brave extension (Manifest V3) that watches your **X (formerly Twitter)** feed,
detects **very fresh posts**, and delivers them **on click**, via **Telegram**, and through a
**local live API**. Best used with a **dedicated tracking account** that follows only the
accounts you want to watch.

Current URL: **`https://x.com`** (the old `twitter.com` redirects — the extension runs on both).

---

## Features

- **Fresh feed:** reads the visible feed (`x.com/home`, lists, profiles) and keeps posts
  younger than X minutes.
- **Tracked accounts:** optionally report only specific handles (⭐ marked).
- **Desktop notification** → click opens the post.
- **Telegram forwarding (English):** bot token + target group in the settings; the bot posts
  new finds, tidy, into the group (bot must be admin there).
- **Media (as links by default):** images are included as clickable links (`pbs.twimg.com/...`)
  and videos as a link (`https://x.com/<user>/status/<id>/video/1`) — no download needed.
  Optional “Attach images as files (album)” in the settings.
- **Live API (local):** the extension POSTs new posts to `http://127.0.0.1:8787/ingest`;
  the API serves `GET /feed` (JSON) plus a mini dashboard at `/`.
- **Icon & background:** `icon.png` is used as the extension icon and as the full popup/options background.
- **Auto-reload** of X tabs (configurable) + **badge** with the count.
- 100% local, no login trick, no third-party API for reading.

---

## Install (Load unpacked)

1. Chrome → `chrome://extensions` → enable **Developer mode**.
2. **“Load unpacked”** → select the folder `/server/twitter-feed-extension`.

Edge: `edge://extensions`, Brave: `brave://extensions`.

---

## Telegram setup

1. Create a bot with **@BotFather** → copy the **bot token**.
2. Add the bot to your **target group** and make it **admin**.
3. Get the group chat id (e.g. via **@userinfobot** or `getUpdates`) — usually starts with `-100…`.
4. Extension → **Settings** → *Telegram forwarding*: token + chat id + “Enable” → **Save** → **Send test message**.
5. From now on, fresh posts are shared into the group in English.

---

## Live API

The API runs as a system service already:

```bash
systemctl status xfft-api          # status
journalctl -u xfft-api -f          # logs
curl http://127.0.0.1:8787/feed?limit=50   # posts as JSON
```

Endpoints:
- `GET /` — mini dashboard (auto-refresh every 4 s)
- `GET /feed?limit=N&since=TS&handle=name` — JSON
- `GET /health`
- `POST /ingest` — body `{"source":"...","tweets":[{id,handle,text,url,ts,ageMin,tracked}]}`

Optional **server-side Telegram relay** (in addition to the extension):
```bash
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=-100... python3 api_server.py
```
(or add `Environment=` lines to `xfft-api.service` and `systemctl restart xfft-api`).

In the extension settings, enable *Live API* and set the URL to `http://127.0.0.1:8787`.

---

## Recommended setup (tracking account)

1. Use a separate X account that follows **only** the accounts you want.
2. Sign in to X in Chrome with that account, open `https://x.com/home`.
3. Settings: handles (optional), “Very fresh” e.g. **5 min**, **Auto-reload 90 s**,
   notifications + Telegram on.
4. Keep the tab open → finds appear in the popup, as a notification, in Telegram, and in the API.

---

## Structure

```
twitter-feed-extension/
├─ manifest.json
├─ icon.png                 (background + icon source)
├─ icons/                   (icon16/48/128.png, generated from icon.png)
├─ api_server.py            (local live API)
├─ xfft-api.service         (systemd unit)
├─ src/
│  ├─ content.js            DOM scraping + MutationObserver
│  ├─ background.js         dedup, notifications, Telegram, API, auto-reload, external API
│  ├─ popup.html/css/js
│  └─ options.html/js
└─ README.md
```

---

## Notes

- X is a SPA; the extension reacts to DOM changes and also scans every 20 s. For “guaranteed
  fresh”, use auto-reload.
- Telegram: the bot must be a member **and admin** of the group, otherwise `chat not found` /
  `not enough rights`.
- If X changes its layout, adjust the selectors in `src/content.js`.
