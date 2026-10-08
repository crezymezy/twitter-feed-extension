#!/usr/bin/env python3
"""
X Fresh Feed Tracker — Live API Server
======================================
Small, dependency-free local API that receives the postings from the Chrome
extension and serves them live.

Endpoints
  GET  /            -> mini dashboard (auto-refresh, live)
  GET  /feed?limit=N&since=TS&handle=name
                    -> {"ok":true,"count":N,"posts":[...]}   (JSON, CORS open)
  GET  /health      -> {"ok":true}
  POST /ingest      -> body {"source":"...","tweets":[{id,handle,text,url,ts,ageMin,tracked}]}
                    -> {"ok":true,"added":N,"total":M}

Optional: Telegram relay. If TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set,
new posts are also sent (in English) to the target group.

Start:
  python3 api_server.py                 # port 8787
  PORT=9000 python3 api_server.py
  TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=-100... python3 api_server.py
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("PORT", "8787"))
BIND = os.environ.get("BIND", "127.0.0.1")
STATE = Path(__file__).resolve().parent / "api_feed.json"
MAX_POSTS = int(os.environ.get("MAX_POSTS", "2000"))

TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
TG_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "").strip()

_lock = threading.Lock()
_posts: list[dict] = []
_seen: set[str] = set()


# -- Persistence -------------------------------------------------------------
def load_state() -> None:
    global _posts, _seen
    if STATE.exists():
        try:
            data = json.loads(STATE.read_text(encoding="utf-8"))
            _posts = data.get("posts", []) if isinstance(data, dict) else []
            _seen = {str(p.get("id")) for p in _posts if p.get("id")}
        except Exception:
            _posts, _seen = [], set()


def save_state() -> None:
    try:
        tmp = STATE.with_suffix(".tmp")
        tmp.write_text(json.dumps({"updated": time.time(), "posts": _posts},
                                  ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, STATE)
    except Exception:
        pass


# -- Telegram (English, tidy) ------------------------------------------------
def _tg_api(method: str, payload: dict) -> bool:
    try:
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{TG_TOKEN}/{method}",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=15).read()
        return True
    except Exception as e:
        print(f"[WARN] Telegram {method} failed: {type(e).__name__}")
        return False


def tg_send(t: dict) -> None:
    if not (TG_TOKEN and TG_CHAT):
        return
    media = [f"🖼 {u}" for u in (t.get("images") or [])[:4] if u]
    if t.get("videoUrl"):
        media.append(f"🎬 {t['videoUrl']}")
    media_block = ("\n\n" + "\n".join(media)) if media else ""
    caption = (
        f"🟢 <b>New post</b> — @{t.get('handle','?')}"
        f"{' ⭐' if t.get('tracked') else ''}\n\n"
        f"{(t.get('text') or '(no text)')[:700]}\n\n"
        f"🔗 {t.get('url','')}{media_block}\n"
        f"⏱ {t.get('ageMin','?')} min ago"
    )
    _tg_api("sendMessage", {"chat_id": TG_CHAT, "text": caption[:4096], "parse_mode": "HTML"})


# -- Ingest ------------------------------------------------------------------
def add_posts(tweets: list) -> int:
    added = 0
    with _lock:
        for t in tweets:
            if not isinstance(t, dict):
                continue
            tid = str(t.get("id") or "")
            if not tid or tid in _seen:
                continue
            t.setdefault("received", time.time())
            _posts.insert(0, t)
            _seen.add(tid)
            added += 1
            if added <= 10:
                threading.Thread(target=tg_send, args=(t,), daemon=True).start()
        if added:
            del _posts[MAX_POSTS:]
            save_state()
    return added


# -- Query -------------------------------------------------------------------
def query_posts(limit: int, since: float, handle: str) -> list:
    with _lock:
        out = []
        for p in _posts:
            if since and float(p.get("received") or 0) < since:
                continue
            if handle and str(p.get("handle", "")).lower() != handle.lower():
                continue
            out.append(p)
            if len(out) >= limit:
                break
        return out


DASHBOARD = """<!doctype html><html><head><meta charset="utf-8">
<title>X Fresh Feed — Live</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{background:#15202b;color:#e7e9ea;font:14px/1.5 system-ui,Arial;margin:0;padding:20px}
 h1{font-size:20px} .m{color:#8b98a5;font-size:12px;margin-bottom:12px}
 .p{border:1px solid #2f3336;border-radius:10px;padding:10px;margin:8px 0;background:#1e2732}
 .h{font-weight:700;color:#1d9bf0} .a{color:#00ba7c;font-size:12px}
 a{color:#1d9bf0;text-decoration:none} code{background:#0f1620;padding:1px 5px;border-radius:4px}
</style></head><body>
<h1>🔥 X Fresh Feed — Live API</h1>
<div class="m" id="meta">Loading…</div>
<div class="m">JSON: <code>/feed?limit=50</code> · Ingest: <code>POST /ingest</code></div>
<div id="list"></div>
<script>
 async function tick(){
   try{
     const r = await fetch('/feed?limit=50'); const d = await r.json();
     document.getElementById('meta').textContent = d.count + ' posts';
     document.getElementById('list').innerHTML = d.posts.map(p=>
       `<div class="p"><div><span class="h">@${p.handle}</span> <span class="a">${Math.round(p.ageMin||0)} min</span></div>
        <div>${(p.text||'').replace(/[<>&]/g,'')}</div>
        <div><a href="${p.url}" target="_blank">${p.url}</a></div></div>`).join('');
   }catch(e){}
 }
 tick(); setInterval(tick, 4000);
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "XFFT-API/1.0"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        if u.path in ("/", "/dashboard"):
            body = DASHBOARD.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self._cors(); self.end_headers(); self.wfile.write(body); return
        if u.path == "/health":
            self._json({"ok": True, "posts": len(_posts), "telegram": bool(TG_TOKEN and TG_CHAT)}); return
        if u.path == "/feed":
            limit = min(1000, int((qs.get("limit", ["100"])[0] or 100)))
            since = float((qs.get("since", ["0"])[0] or 0))
            handle = (qs.get("handle", [""])[0] or "").strip()
            posts = query_posts(limit, since, handle)
            self._json({"ok": True, "count": len(posts), "posts": posts}); return
        self._json({"ok": False, "error": "not_found"}, 404)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/ingest":
            self._json({"ok": False, "error": "not_found"}, 404); return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(n) if n else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")
            tweets = data.get("tweets") if isinstance(data, dict) else None
            if not isinstance(tweets, list):
                self._json({"ok": False, "error": "no_tweets"}, 400); return
            added = add_posts(tweets)
            self._json({"ok": True, "added": added, "total": len(_posts)})
        except Exception as e:
            self._json({"ok": False, "error": str(e)}, 400)

    def log_message(self, fmt, *args):
        pass


def main():
    load_state()
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"XFFT API on http://{BIND}:{PORT}  (feed: /feed, ingest: POST /ingest)")
    print(f"Telegram relay: {'ON' if (TG_TOKEN and TG_CHAT) else 'off'}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
