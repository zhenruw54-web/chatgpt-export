// Downloads images hosted outside chatgpt.com (search thumbnails, products).
// A content script cannot bypass CORS in Chrome; the background context can
// do so with host permission.
const api = globalThis.browser ?? globalThis.chrome;
const FETCH_TIMEOUT_MS = 20000;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "cgx-fetch") return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  fetch(msg.url, { credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get("content-type") || "";
      sendResponse({ ok: true, type, data: toBase64(await res.arrayBuffer()) });
    })
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }))
    .finally(() => clearTimeout(timer));
  return true;
});


// V0.2 Edge scheduler (opt-in; disabled by default).  The export engine stays
// in the existing ChatGPT content script; this worker only schedules it.
// Never attempt the first automatic export without a migrated incremental index.
const CGX_V02_KEY = "cgx-v02-scheduler";
const CGX_V02_ALARM = "cgx-v02-daily-2345-beijing";
const CGX_V02_TIMEZONE = "Asia/Shanghai";
const CGX_V02_RETRY_GUARD_MS = 60 * 60 * 1000;

function cgxV02NextBeijing2345(afterMs) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: CGX_V02_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date(afterMs)).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)])
  );
  // China Standard Time is UTC+08:00 and has no daylight-saving transitions.
  let next = Date.UTC(parts.year, parts.month - 1, parts.day, 15, 45, 0);
  if (next <= afterMs) next += 24 * 60 * 60 * 1000;
  return next;
}

async function cgxV02Read() {
  const result = await api.storage.local.get([CGX_V02_KEY, "cgx-export-index"]);
  const state = result[CGX_V02_KEY] || {};
  const index = result["cgx-export-index"];
  return {
    state: {
      enabled: state.enabled === true,
      nextDueAt: Number(state.nextDueAt) || 0,
      lastAttemptAt: Number(state.lastAttemptAt) || 0,
      lastExportCompletedAt: Number(state.lastExportCompletedAt) || 0,
      lastStatus: String(state.lastStatus || "disabled"),
      lastError: String(state.lastError || "").slice(0, 240)
    },
    indexReady: !!(index && typeof index === "object" && !Array.isArray(index) && Object.keys(index).length)
  };
}

async function cgxV02Write(state) {
  await api.storage.local.set({ [CGX_V02_KEY]: state });
}

async function cgxV02Arm(state) {
  if (!state.enabled) {
    await api.alarms.clear(CGX_V02_ALARM);
    return;
  }
  // The timestamp persists in storage even if the browser loses its alarm.
  if (!state.nextDueAt) {
    state.nextDueAt = cgxV02NextBeijing2345(Date.now());
    await cgxV02Write(state);
  }
  await api.alarms.create(CGX_V02_ALARM, {
    when: Math.max(Date.now() + 1000, state.nextDueAt)
  });
}

async function cgxV02FindTab() {
  const existing = await api.tabs.query({
    url: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
  });
  const tab = existing.find(t => t.id != null && t.status === "complete")
    || existing.find(t => t.id != null);
  if (tab) return tab;
  // Open a background tab only after the user explicitly enables scheduling.
  return api.tabs.create({ url: "https://chatgpt.com/", active: false });
}

async function cgxV02WaitReceiver(tabId) {
  let error = null;
  for (let attempt = 0; attempt < 24; attempt++) {
    try {
      const ping = await api.tabs.sendMessage(tabId, { type: "cgx-ping" });
      if (ping && ping.ok) return;
    } catch (e) { error = e; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("ChatGPT tab connector not ready; reload or sign in on chatgpt.com.");
}

function cgxV02ShortError(error) {
  const raw = String((error && error.message) || error || "Unknown error");
  return raw.replace(/https?:\/\/\S+/g, "[URL]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[ID]").slice(0, 240);
}

let cgxV02Active = false;
async function cgxV02Run(reason = "alarm") {
  if (cgxV02Active) return { ok: false, status: "already_running" };
  cgxV02Active = true;
  try {
  const { state, indexReady } = await cgxV02Read();
  const now = Date.now();
  if (!state.enabled) return { ok: false, status: "disabled" };
  if (reason !== "manual" && state.nextDueAt > now) {
    await cgxV02Arm(state);
    return { ok: true, status: "not_due" };
  }
  if (state.lastAttemptAt && now - state.lastAttemptAt < CGX_V02_RETRY_GUARD_MS) {
    state.nextDueAt = cgxV02NextBeijing2345(now);
    await cgxV02Write(state);
    await cgxV02Arm(state);
    return { ok: false, status: "retry_guard" };
  }

  state.lastAttemptAt = now;
  state.nextDueAt = cgxV02NextBeijing2345(now);
  state.lastStatus = "starting";
  state.lastError = "";
  await cgxV02Write(state);
  await cgxV02Arm(state);

  if (!indexReady) {
    state.lastStatus = "blocked_no_baseline";
    state.lastError = "No incremental index in this extension. Import and verify the previous index before enabling auto-export.";
    await cgxV02Write(state);
    return { ok: false, status: state.lastStatus };
  }

  try {
    const tab = await cgxV02FindTab();
    await cgxV02WaitReceiver(tab.id);
    state.lastStatus = "running";
    await cgxV02Write(state);
    const result = await api.tabs.sendMessage(tab.id, {
      type: "cgx-v02-auto-export",
      options: {
        format: "md", md: true, html: false, images: true, files: true,
        json: true, thinking: false, branches: false, mdHtml: false,
        embeddedMd: false, modernEmbeddedMd: false, incremental: true,
        checksums: true, partSizeMB: 1024, conversationLimit: 0,
        autoDeleteAfterExport: false, autoDeleteProjectsAfterExport: false
      }
    });
    // This confirms content-script processing, NOT durable filesystem or F-drive archiving.
    if (!result || !result.ok) throw new Error(result?.error || "Export did not complete.");
    state.lastStatus = result.noChanges ? "no_changes" :
      (result.failed || result.imageFailures || result.fileFailures ? "partial" : "export_completed_in_tab");
    state.lastExportCompletedAt = Date.now();
    await cgxV02Write(state);
    return {
      ok: true, status: state.lastStatus,
      count: result.count || 0, failed: result.failed || 0,
      imageFailures: result.imageFailures || 0, fileFailures: result.fileFailures || 0
    };
  } catch (error) {
    state.lastStatus = "failed";
    state.lastError = cgxV02ShortError(error);
    await cgxV02Write(state);
    return { ok: false, status: "failed", error: state.lastError };
  }
  } finally {
    cgxV02Active = false;
  }
}

async function cgxV02Wake() {
  const { state } = await cgxV02Read();
  if (!state.enabled) return cgxV02Arm(state);
  if (state.nextDueAt && state.nextDueAt <= Date.now()) {
    await cgxV02Run("startup");
  } else {
    await cgxV02Arm(state);
  }
}

api.runtime.onStartup.addListener(() => { cgxV02Wake().catch(() => {}); });
api.runtime.onInstalled.addListener(() => { cgxV02Wake().catch(() => {}); });
api.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === CGX_V02_ALARM) cgxV02Run("alarm").catch(() => {});
});

// Only explicit popup control may enable the schedule. It is additionally
// blocked when no migrated index exists, preventing a surprise 4+ GiB export.
api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !["cgx-v02-get", "cgx-v02-set", "cgx-v02-run-now"].includes(message.type)) return false;
  (async () => {
    if (message.type === "cgx-v02-get") {
      const data = await cgxV02Read();
      return { ok: true, ...data, timezone: CGX_V02_TIMEZONE };
    }
    if (message.type === "cgx-v02-set") {
      const { state, indexReady } = await cgxV02Read();
      if (typeof message.enabled !== "boolean") return { ok: false, error: "Invalid enabled value." };
      if (message.enabled && !indexReady) return { ok: false, error: "A verified incremental baseline is required before enabling automatic export." };
      state.enabled = message.enabled;
      state.nextDueAt = message.enabled ? cgxV02NextBeijing2345(Date.now()) : 0;
      state.lastStatus = message.enabled ? "scheduled" : "disabled";
      state.lastError = "";
      await cgxV02Write(state);
      await cgxV02Arm(state);
      return { ok: true, state, indexReady };
    }
    const { state, indexReady } = await cgxV02Read();
    if (!state.enabled || !indexReady) return { ok: false, error: "Enable scheduling with a verified index first." };
    return cgxV02Run("manual");
  })().then(sendResponse).catch(error => sendResponse({ ok: false, error: cgxV02ShortError(error) }));
  return true;
});

// Recreate lost alarms after the service worker is launched for any reason.
cgxV02Wake().catch(() => {});
