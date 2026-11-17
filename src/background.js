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


// CGX_V02_DOWNLOAD_TRACKER
// Browser completion is the FIRST receipt only: it is not V0.1/ZIP validation.
// A service-worker crash deliberately loses in-flight acknowledgements. The
// content script then must NOT advance its index, even if a ZIP was written.
// This favors a possible duplicate download over silently missing knowledge.
const CGX_V02_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const cgxV02Tracked = new Map();
const cgxV02TrackedByUrl = new Map();
function cgxV02DownloadError(err) {
  return String(err?.message || err || "Download failed").slice(0, 180);
}
function cgxV02DownloadSenderValid(sender) {
  if (!sender || sender.id !== api.runtime.id ||
      !Number.isInteger(sender.tab?.id) || sender.tab.id < 0) return false;
  try {
    const u = new URL(sender.url || "");
    return u.protocol === "https:" &&
      (u.hostname === "chatgpt.com" || u.hostname === "chat.openai.com");
  } catch (_) { return false; }
}
function cgxV02FinishDownload(record, outcome) {
  if (record.terminal) return;
  record.terminal = outcome;
  if (record.resolve) record.resolve(outcome);
}
async function cgxV02ValidateDownloadItem(record, id) {
  const matches = await api.downloads.search({ id });
  const item = matches && matches[0];
  if (!item || item.id !== id || item.state !== "complete" ||
      item.url !== record.url || !/\.zip$/i.test(item.filename || ""))
    throw new Error("Completed ZIP download could not be matched to the tracked blob.");
  // Chrome may report -1 for unknown size. A reported positive size must
  // match; a reported zero for a nonempty blob is never valid.
  for (const n of [item.fileSize, item.bytesReceived]) {
    if (typeof n === "number" && n >= 0 && n !== record.expectedBytes)
      throw new Error("Downloaded ZIP byte count differs from in-memory ZIP.");
  }
  return { ok: true, status: "browser_download_complete", byteCount: record.expectedBytes };
}
if (api.downloads?.onCreated?.addListener &&
    api.downloads?.onChanged?.addListener && api.downloads?.search) {
  api.downloads.onCreated.addListener(item => {
    if (!item?.url || !cgxV02TrackedByUrl.has(item.url)) return;
    const token = cgxV02TrackedByUrl.get(item.url);
    const record = cgxV02Tracked.get(token);
    if (!record || record.terminal || record.downloadId != null) return;
    if (item.tabId != null && item.tabId >= 0 && item.tabId !== record.tabId) return;
    record.downloadId = item.id;
    if (item.state === "interrupted") {
      cgxV02FinishDownload(record, { ok: false, error: "ZIP download interrupted." });
    } else if (item.state === "complete") {
      cgxV02ValidateDownloadItem(record, item.id).then(
        result => cgxV02FinishDownload(record, result),
        error => cgxV02FinishDownload(record, {ok:false,error:cgxV02DownloadError(error)})
      );
    }
  });
  api.downloads.onChanged.addListener(delta => {
    if (!delta?.state || !["complete", "interrupted"].includes(delta.state.current)) return;
    const record = [...cgxV02Tracked.values()].find(
      r => r.downloadId === delta.id && !r.terminal
    );
    if (!record) return;
    if (delta.state.current === "interrupted") {
      cgxV02FinishDownload(record, {ok:false,error:"ZIP download interrupted."});
      return;
    }
    cgxV02ValidateDownloadItem(record, delta.id).then(
      result => cgxV02FinishDownload(record, result),
      error => cgxV02FinishDownload(record, {ok:false,error:cgxV02DownloadError(error)})
    );
  });
}
async function cgxV02WatchZip(message, sender) {
  if (!cgxV02Active || !cgxV02DownloadSenderValid(sender) ||
      !api.downloads?.search || !api.downloads?.onCreated)
    return {ok:false,error:"Scheduled download tracker is unavailable or unauthorized."};
  const {url, filename, expectedBytes} = message;
  if (typeof url !== "string" || url.length > 350 ||
      !/^blob:https:\/\/(?:chatgpt\.com|chat\.openai\.com)\/[A-Za-z0-9-]+$/.test(url) ||
      typeof filename !== "string" ||
      !/^chatgpt-export_[A-Za-z0-9_-]+(?:_part-\d{3})?\.zip$/.test(filename) ||
      !Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 ||
      expectedBytes > 2 * 1024 * 1024 * 1024 ||
      cgxV02TrackedByUrl.has(url) || cgxV02Tracked.size >= 10)
    return {ok:false,error:"Invalid scheduled ZIP registration; download not started."};
  const token = crypto.randomUUID();
  const record = {
    token, url, filename, expectedBytes, tabId: sender.tab.id,
    downloadId: null, terminal: null, resolve: null, pending: null,
    createdAt: Date.now()
  };
  cgxV02Tracked.set(token, record);
  cgxV02TrackedByUrl.set(url, token);
  return {ok:true,token};
}
async function cgxV02AwaitZip(message, sender) {
  if (!cgxV02DownloadSenderValid(sender)) {
    return {ok:false,error:"Unauthorized ZIP confirmation request."};
  }
  const record = cgxV02Tracked.get(message.token);
  if (!record || record.tabId !== sender.tab.id) {
    return {ok:false,error:"ZIP session missing (worker may have restarted). Index unchanged."};
  }
  let timeout;
  try {
    if (record.terminal) return record.terminal;
    if (!record.pending) record.pending = new Promise(resolve => { record.resolve = resolve; });
    const result = await Promise.race([
      record.pending,
      new Promise(resolve => { timeout=setTimeout(() => resolve({
        ok:false,error:"No browser download completion receipt before timeout; index unchanged."
      }), CGX_V02_DOWNLOAD_TIMEOUT_MS); })
    ]);
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
    cgxV02Tracked.delete(message.token);
    cgxV02TrackedByUrl.delete(record.url);
  }
}
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !["cgx-v02-watch-zip","cgx-v02-await-zip"].includes(message.type))
    return false;
  const promise = message.type === "cgx-v02-watch-zip" ?
    cgxV02WatchZip(message, sender) : cgxV02AwaitZip(message, sender);
  promise.then(sendResponse).catch(e => sendResponse({
    ok:false,error:cgxV02DownloadError(e)
  }));
  return true;
});

// V0.2 Edge scheduler (opt-in; disabled by default).  The export engine stays
// in the existing ChatGPT content script; this worker only schedules it.
// Never attempt the first automatic export without a migrated incremental index.
const CGX_V02_KEY = "cgx-v02-scheduler";
const CGX_V02_ALARM = "cgx-v02-daily-2345-beijing";
const CGX_V02_TIMEZONE = "Asia/Shanghai";
const CGX_V02_RETRY_GUARD_MS = 60 * 60 * 1000;
const CGX_V02_RECEIPT_KEY = "cgx-v02-index-migration";
const CGX_V02_EXPECTED_BASELINE_COUNT = 65;
const CGX_V02_MAX_TRANSFER_CHARS = 512 * 1024;
// Conservative pilot cap: a mass metadata mismatch must never trigger full re-export.
const CGX_V02_MAX_DAILY_DELTA = 10;

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
  const result = await api.storage.local.get([CGX_V02_KEY, "cgx-export-index", CGX_V02_RECEIPT_KEY]);
  const state = result[CGX_V02_KEY] || {};
  const index = result["cgx-export-index"];
  const receipt = result[CGX_V02_RECEIPT_KEY];
  // A bare index is never treated as a verified migrated baseline.
  const indexReady = cgxV02ReceiptCoversIndex(index, receipt);
  return {
    state: {
      enabled: state.enabled === true,
      nextDueAt: Number(state.nextDueAt) || 0,
      lastAttemptAt: Number(state.lastAttemptAt) || 0,
      lastExportCompletedAt: Number(state.lastExportCompletedAt) || 0,
      lastStatus: String(state.lastStatus || "disabled"),
      lastError: String(state.lastError || "").slice(0, 240)
    },
    indexReady,
    migration: receipt && receipt.schema === "cgx-v02-receipt-v1" ? {
      importedAt: receipt.importedAt,
      baselineCount: receipt.baselineIds?.length || 0,
      verifiedSharedAliases: receipt.sharedAliases?.length || 0,
      indexCountAtImport: receipt.indexCountAtImport || 0,
      currentIndexCount: index && typeof index === "object" ? Object.keys(index).length : 0
    } : null
  };
}


function cgxV02IsPlainObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x) &&
    (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
}

function cgxV02ExtractConversationId(key) {
  if (typeof key !== "string" || key.length > 300) return null;
  const at = key.lastIndexOf(":");
  if (at < 1 || at >= key.length - 1) return null;
  const id = key.slice(at + 1);
  // Supports UUID and non-UUID conversation IDs without accepting paths or URLs.
  return /^[A-Za-z0-9_-]{8,160}$/.test(id) ? id : null;
}

function cgxV02ReceiptCoversIndex(index, receipt) {
  if (!cgxV02IsPlainObject(index) || !cgxV02IsPlainObject(receipt)) return false;
  if (receipt.schema !== "cgx-v02-receipt-v1" || receipt.verified !== true) return false;
  if (!Array.isArray(receipt.baselineIds) ||
      receipt.baselineIds.length !== CGX_V02_EXPECTED_BASELINE_COUNT ||
      new Set(receipt.baselineIds).size !== CGX_V02_EXPECTED_BASELINE_COUNT) return false;
  const keys = Object.keys(index);
  if (!Number.isInteger(receipt.indexCountAtImport) ||
      keys.length < receipt.indexCountAtImport ||
      keys.length < receipt.baselineIds.length) return false;
  const ids = new Set(keys.map(cgxV02ExtractConversationId).filter(Boolean));
  const aliases = Array.isArray(receipt.sharedAliases) ? receipt.sharedAliases : [];
  if (aliases.length > 2) return false;
  const map = new Map();
  const usedKeys = new Set();
  for (const record of aliases) {
    if (!cgxV02IsPlainObject(record) || typeof record.targetId !== "string" ||
        typeof record.sourceIndexKey !== "string" ||
        !receipt.baselineIds.includes(record.targetId) ||
        !Object.prototype.hasOwnProperty.call(index, record.sourceIndexKey) ||
        !cgxV02ExtractConversationId(record.sourceIndexKey) ||
        usedKeys.has(record.sourceIndexKey) || map.has(record.targetId)) return false;
    const current = index[record.sourceIndexKey];
    if (!cgxV02IsPlainObject(current) || typeof current.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/i.test(current.fingerprint) ||
        ids.has(record.targetId)) return false; // No conflicting direct key.
    usedKeys.add(record.sourceIndexKey);
    map.set(record.targetId, record.sourceIndexKey);
  }
  // Exact coverage with zero false matches: all 65 are either directly indexed
  // or linked to a specific verified shared-list key; never add synthetic keys.
  if (!receipt.baselineIds.every(id => ids.has(id) || map.has(id))) return false;
  // Imported aliased keys must remain distinct from the direct 63/65 entries.
  const directKeys = keys.filter(k => receipt.baselineIds.includes(cgxV02ExtractConversationId(k)));
  return !directKeys.some(k => usedKeys.has(k));
}

// This proof is a minimal, local extraction of TWO verified raw/metadata pairs.
// It does NOT cryptographically authenticate source ZIPs by itself. Work must
// first establish provenance by matching file hashes against the original ZIP
// and the recorded 2x2 fingerprint/workspace/timestamp evidence.
function cgxV02ValidateSharedAliases(index, baselineIds, proof) {
  const keys = Object.keys(index);
  const direct = new Set(keys.map(cgxV02ExtractConversationId).filter(Boolean));
  const missing = baselineIds.filter(id => !direct.has(id));
  if (!missing.length) {
    if (proof != null && !(cgxV02IsPlainObject(proof) &&
        proof.schema === "cgx-v02-shared-alias-proof-v1" &&
        Array.isArray(proof.mappings) && proof.mappings.length === 0))
      throw new Error("Unexpected shared-alias proof; all 65 IDs already match directly.");
    return [];
  }
  if (missing.length !== 2)
    throw new Error("Migration has " + missing.length +
      " missing baseline IDs; only the two locally verified shared aliases are supported.");
  if (!cgxV02IsPlainObject(proof) ||
      proof.schema !== "cgx-v02-shared-alias-proof-v1" ||
      !Array.isArray(proof.mappings) || proof.mappings.length !== 2)
    throw new Error("Two source-backed shared identity mappings are required. No index was changed.");
  const extraKeys = keys.filter(key => !baselineIds.includes(cgxV02ExtractConversationId(key)));
  if (extraKeys.length !== 2)
    throw new Error("Old index contains additional unmapped identities; manual review required.");

  const mapped = [];
  const seenIds = new Set();
  const seenKeys = new Set();
  for (const p of proof.mappings) {
    if (!cgxV02IsPlainObject(p) || !cgxV02IsPlainObject(p.raw) ||
        !cgxV02IsPlainObject(p.metadata) || !cgxV02IsPlainObject(p.index))
      throw new Error("Invalid shared alias evidence structure.");
    const target = p.raw.conversation_id;
    const key = p.index.key;
    const oldId = cgxV02ExtractConversationId(key);
    if (typeof target !== "string" || !missing.includes(target) ||
        seenIds.has(target) || !extraKeys.includes(key) || seenKeys.has(key))
      throw new Error("Shared alias evidence is missing, duplicated, or conflicts with a direct ID.");
    if (p.raw.backing_conversation_id !== oldId ||
        p.metadata.conversation_id !== target ||
        p.raw.workspace_id !== p.metadata.workspace_id ||
        typeof p.raw.workspace_id !== "string" || !p.raw.workspace_id ||
        p.index.workspace_id !== p.raw.workspace_id)
      throw new Error("Shared alias fields disagree with raw/metadata workspace or backing ID.");
    if (!cgxV02IsPlainObject(index[key]) ||
        p.index.fingerprint !== index[key].fingerprint ||
        p.index.updated_at !== index[key].updated_at)
      throw new Error("Shared alias index fingerprint/timestamp does not match the original index.");
    if (typeof p.raw_sha256 !== "string" ||
        !/^[0-9a-f]{64}$/i.test(p.raw_sha256) ||
        typeof p.metadata_sha256 !== "string" ||
        !/^[0-9a-f]{64}$/i.test(p.metadata_sha256))
      throw new Error("Shared proof must provide SHA-256 of the two source files.");
    seenIds.add(target);
    seenKeys.add(key);
    mapped.push({ targetId: target, sourceIndexKey: key });
  }
  if (seenIds.size !== 2 || seenKeys.size !== 2)
    throw new Error("Shared alias proof must form a unique two-to-two mapping.");
  return mapped;
}

function cgxV02ValidateTransfer(message) {
  const source = message && message.source;
  const baseline = message && message.baseline;
  if (!cgxV02IsPlainObject(source) ||
      source.schema !== "cgx-index-transfer-v1")
    throw new Error("Expected a cgx-index-transfer-v1 file from the original extension.");
  if (!cgxV02IsPlainObject(baseline) ||
      baseline.schema !== "cgx-v01-baseline-v1")
    throw new Error("Expected a cgx-v01-baseline-v1 file from the frozen V0.1 baseline.");

  const index = source.index;
  if (!cgxV02IsPlainObject(index)) throw new Error("Index must be a JSON object.");
  const keys = Object.keys(index);
  if (keys.length < CGX_V02_EXPECTED_BASELINE_COUNT || keys.length > 100000)
    throw new Error("Original index count does not cover the 65-conversation V0.1 baseline.");
  for (const key of keys) {
    if (!cgxV02ExtractConversationId(key)) throw new Error("Index contains invalid conversation IDs.");
    const item = index[key];
    if (!cgxV02IsPlainObject(item) ||
        typeof item.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/i.test(item.fingerprint))
      throw new Error("Index includes an invalid SHA-256 conversation fingerprint.");
    if (item.updated_at != null &&
        !["string", "number"].includes(typeof item.updated_at))
      throw new Error("Invalid updated_at in source index.");
  }

  const ids = baseline.conversation_ids;
  if (!Array.isArray(ids) || ids.length !== CGX_V02_EXPECTED_BASELINE_COUNT)
    throw new Error("V0.1 baseline must provide exactly 65 conversation IDs.");
  if (new Set(ids).size !== ids.length ||
      !ids.every(id => typeof id === "string" && /^[A-Za-z0-9_-]{8,160}$/.test(id)))
    throw new Error("V0.1 baseline IDs contain duplicates or invalid values.");

  const last = source.last_full_export;
  if (!Number.isFinite(last) || last < 1600000000000 || last > Date.now() + 86400000)
    throw new Error("Original extension last full export timestamp is missing or invalid.");
  const sharedAliases = cgxV02ValidateSharedAliases(index, ids, message.aliasProof);
  const validated = {
    schema: "cgx-v02-receipt-v1", verified: true,
    indexCountAtImport: keys.length, baselineIds: ids.slice(), sharedAliases
  };
  if (!cgxV02ReceiptCoversIndex(index, validated))
    throw new Error("Combined direct/shared coverage failed. No migration was performed.");

  return {
    index,
    receipt: {
      schema: "cgx-v02-receipt-v1",
      verified: true,
      importedAt: new Date().toISOString(),
      indexCountAtImport: keys.length,
      lastFullExportAtImport: last,
      baselineIds: ids.slice(),
      sharedAliases
    },
    last
  };
}

async function cgxV02ImportIndex(message) {
  // Payload stays inside the current Edge extension, never leaves for a server.
  if (JSON.stringify(message).length > CGX_V02_MAX_TRANSFER_CHARS)
    throw new Error("Migration data is too large. Expected only small JSON index files.");
  const { state } = await cgxV02Read();
  if (state.enabled || cgxV02Active)
    throw new Error("Turn off the scheduler before importing an index.");

  const current = await api.storage.local.get(["cgx-export-index", CGX_V02_RECEIPT_KEY]);
  if (current["cgx-export-index"] || current[CGX_V02_RECEIPT_KEY])
    throw new Error("Target index already exists. Refusing to overwrite it.");

  const { index, receipt, last } = cgxV02ValidateTransfer(message);
  await api.storage.local.set({
    "cgx-export-index": index,
    "cgx-last-full-export": last,
    [CGX_V02_RECEIPT_KEY]: receipt
  });
  const after = await cgxV02Read();
  if (!after.indexReady)
    throw new Error("Migration could not be read back correctly. Keep auto-export disabled.");
  return {
    ok: true, importedEntries: receipt.indexCountAtImport,
    matchedBaselineIds: receipt.baselineIds.length,
    mappedSharedAliases: receipt.sharedAliases.length,
    status: "migrated_and_verified_locally",
    // Do not return the conversation identifiers to the popup.
    indexReady: after.indexReady
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
    state.lastStatus = "previewing";
    await cgxV02Write(state);
    const preview = await api.tabs.sendMessage(tab.id, {type: "cgx-v02-preview"});
    if (!preview || preview.ok !== true ||
        !Number.isInteger(preview.changed) || preview.changed < 0 ||
        !Number.isInteger(preview.listed) || preview.listed < 1)
      throw new Error(preview?.error || "Safe delta preview failed. Export blocked.");
    if (preview.changed > CGX_V02_MAX_DAILY_DELTA) {
      state.lastStatus = "blocked_large_delta";
      state.lastError = "Delta preview found " + preview.changed +
        " changed entries; safety limit is " + CGX_V02_MAX_DAILY_DELTA +
        ". Review migration index; no ZIP was requested.";
      await cgxV02Write(state);
      return {ok:false,status:state.lastStatus,changed:preview.changed};
    }
    if (preview.changed === 0) {
      state.lastStatus = "no_changes";
      state.lastError = "";
      await cgxV02Write(state);
      return {ok:true,status:"no_changes",changed:0};
    }
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
      (result.failed || result.imageFailures || result.fileFailures ? "partial" : "browser_download_complete_v01_unverified");
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

// Explicit read-only preview from the V0.2 popup, without scheduler enable.
async function cgxV02PreviewNow() {
  if (cgxV02Active) return {ok:false,error:'Another V0.2 task is running.'};
  cgxV02Active = true;
  try {
    const { indexReady } = await cgxV02Read();
    if (!indexReady) return {ok:false,error:'Verified migrated index required for preview.'};
    const tab=await cgxV02FindTab();
    await cgxV02WaitReceiver(tab.id);
    const result=await api.tabs.sendMessage(tab.id,{type:'cgx-v02-preview'});
    if (!result || result.ok!==true || !Number.isInteger(result.changed) ||
        result.changed<0 || !Number.isInteger(result.listed) || result.listed<1)
      return {ok:false,error:'Read-only preview did not finish safely.'};
    return {ok:true,listed:result.listed,changed:result.changed,
      newCount:result.newCount||0,modified:result.modified||0,
      safeToTest:result.changed<=CGX_V02_MAX_DAILY_DELTA,
      maxPilotDelta:CGX_V02_MAX_DAILY_DELTA};
  } catch (error) {
    return {ok:false,error:cgxV02ShortError(error)};
  } finally {cgxV02Active=false;}
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
  if (!message || !["cgx-v02-get", "cgx-v02-set", "cgx-v02-run-now", "cgx-v02-import-index", "cgx-v02-preview-now"].includes(message.type)) return false;
  (async () => {
    if (message.type !== "cgx-v02-get") {
      // Only the extension's own popup may import baselines or control schedules.
      const trustedUrl = "chrome-extension://" + api.runtime.id + "/popup/popup.html";
      if (!_sender || _sender.url !== trustedUrl)
        return { ok: false, error: "Only the extension popup may change V0.2 settings." };
    }
    if (message.type === "cgx-v02-import-index") {
      return cgxV02ImportIndex(message);
    }
    if (message.type === "cgx-v02-preview-now") return cgxV02PreviewNow();
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
