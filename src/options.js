"use strict";
const DEFAULTS = {
  trackedHandles: [],
  requireTrackedOnly: false,
  freshnessMinutes: 15,
  autoReloadSeconds: 0,
  notifyEnabled: true,
  telegramEnabled: false,
  telegramBotToken: "",
  telegramChatId: "",
  includeMedia: false,
  apiEnabled: false,
  apiUrl: "http://127.0.0.1:8787"
};

const $ = (id) => document.getElementById(id);

function parseHandles(text) {
  return String(text || "")
    .split(/[\n,;]+/)
    .map((h) => h.replace(/^@/, "").trim().toLowerCase())
    .filter(Boolean);
}

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $("trackedHandles").value = (s.trackedHandles || []).join("\n");
  $("requireTrackedOnly").checked = s.requireTrackedOnly === true;
  $("freshnessMinutes").value = s.freshnessMinutes || 15;
  $("autoReloadSeconds").value = s.autoReloadSeconds || 0;
  $("notifyEnabled").checked = s.notifyEnabled !== false;
  $("telegramEnabled").checked = s.telegramEnabled === true;
  $("telegramBotToken").value = s.telegramBotToken || "";
  $("telegramChatId").value = s.telegramChatId || "";
  $("includeMedia").checked = s.includeMedia === true;
  $("apiEnabled").checked = s.apiEnabled === true;
  $("apiUrl").value = s.apiUrl || "http://127.0.0.1:8787";
}

async function save() {
  const cfg = {
    trackedHandles: parseHandles($("trackedHandles").value),
    requireTrackedOnly: $("requireTrackedOnly").checked,
    freshnessMinutes: Math.max(1, Number($("freshnessMinutes").value) || 15),
    autoReloadSeconds: Math.max(0, Number($("autoReloadSeconds").value) || 0),
    notifyEnabled: $("notifyEnabled").checked,
    telegramEnabled: $("telegramEnabled").checked,
    telegramBotToken: $("telegramBotToken").value.trim(),
    telegramChatId: $("telegramChatId").value.trim(),
    includeMedia: $("includeMedia").checked,
    apiEnabled: $("apiEnabled").checked,
    apiUrl: ($("apiUrl").value || "").trim()
  };
  await chrome.storage.sync.set(cfg);
  const st = $("status");
  st.textContent = `✅ Saved (${cfg.trackedHandles.length} accounts, <${cfg.freshnessMinutes} min)`;
  setTimeout(() => { st.textContent = ""; }, 2500);
}

async function testTelegram() {
  await save();
  $("tgStatus").textContent = "Sending…";
  chrome.runtime.sendMessage({ type: "testTelegram" }, (res) => {
    if (res && res.ok) {
      $("tgStatus").textContent = "✅ Test message sent. Check the group.";
    } else {
      $("tgStatus").textContent = "❌ " + ((res && (res.description || res.error)) || "failed");
    }
    setTimeout(() => { $("tgStatus").textContent = ""; }, 4000);
  });
}

$("save").addEventListener("click", save);
$("testTg").addEventListener("click", testTelegram);
load();
