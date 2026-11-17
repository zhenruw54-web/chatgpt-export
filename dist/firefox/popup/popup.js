const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const btnCurrent = $("current");
const btnAll = $("all");
const btnPick = $("pick");
const btnReview = $("review-delete");
const historyExportDialog = $("history-export-dialog");
const autoDeleteAfterExport = $("auto-delete-after-export");
const autoDeleteProjects = $("auto-delete-projects");
const autoDeleteProjectsRow = $("auto-delete-projects-row");
const deleteProjectsWarning = $("delete-projects-warning");
const confirmAutoDeleteRow = $("confirm-auto-delete-row");
const confirmAutoDelete = $("confirm-auto-delete");
const startHistoryExport = $("start-history-export");
const tabHint = $("tab-hint");
const formatHint = $("format-hint");
const btnCancel = $("cancel-job");
const btnGrant = $("grant");
const bar = $("bar");
const progressWrap = $("progress-wrap");
const progressPercent = $("progress-percent");
const activityWrap = $("activity-wrap");
const activityList = $("activity-list");
const status = $("status");
const btnLog = $("download-log");
const btnFailures = $("download-failures");
const help = $("help");
const optImages = $("opt-images");
const optJson = $("opt-json");
const optThinking = $("opt-thinking");
const optFiles = $("opt-files");
const optBranches = $("opt-branches");
const optIncremental = $("opt-incremental");
const optChecksums = $("opt-checksums");
const optPartSize = $("opt-part-size");
const optJexDelay = $("opt-jex-delay");
const optHistoryCount = $("opt-history-count");
const optLimit = $("opt-limit");
const FORMAT_HINTS = {
  md: "Markdown (.md) files with images and attachments.",
  html: "Standalone web pages (.html) you can open in any browser.",
  both: "Markdown and HTML side by side.",
  jex: "One .jex file to import into Joplin (File › Import › JEX)."
};
const formatInputs = [...document.querySelectorAll('input[name="format"]')];
const mediaModeInputs = [...document.querySelectorAll('input[name="media-mode"]')];
const mdHtmlInputs = [...document.querySelectorAll('input[name="md-html"]')];
const ALL_SITES = { origins: ["<all_urls>"] };

let tabId = null;
let tabChecked = false;
let exportTabId = null;
let activeTabUrl = null;
let diagnostic = null;
let diagnosticDownload = null;
let diagnosticCreatedAt = null;
let lastProgressLabel = "";
let liveFailures = [];

function manifestVersion() {
  try { return api.runtime.getManifest().version || "unknown"; } catch (_) { return "unknown"; }
}

function safePageUrl(raw) {
  try {
    const u = new URL(raw || "");
    const path = u.pathname.split("/").map((part) => /^[A-Za-z0-9_-]{16,}$/.test(part) ? `<id:${part.length}>` : part).join("/");
    return `${u.origin}${path}`;
  } catch (_) { return "unavailable"; }
}

function errorDetails(error) {
  if (!error) return null;
  return {
    name: String(error.name || "Error"),
    message: String(error.message || error),
    stack: error.stack ? String(error.stack) : null
  };
}

function startDiagnostic(type) {
  diagnostic = {
    schema: 1,
    extension: { name: "ChatGPT Markdown Export", version: manifestVersion() },
    started_at: new Date().toISOString(),
    export_type: type,
    page: safePageUrl(activeTabUrl),
    browser: { user_agent: navigator.userAgent, platform: navigator.platform || null },
    options: currentOptions(),
    events: []
  };
  diagnosticDownload = null;
  diagnosticCreatedAt = null;
  lastProgressLabel = "";
  btnLog.hidden = true;
  btnLog.textContent = "Download diagnostic log";
}

function addDiagnostic(event, details = null) {
  if (!diagnostic) return;
  diagnostic.events.push({ at: new Date().toISOString(), event, ...(details ? { details } : {}) });
  if (diagnostic.events.length > 250) diagnostic.events.splice(0, diagnostic.events.length - 250);
}

function prepareDiagnosticLog({ error = null, remote = null, result = null } = {}) {
  if (!diagnostic) startDiagnostic("unknown");
  diagnostic.finished_at = new Date().toISOString();
  diagnostic.page = safePageUrl(activeTabUrl);
  if (error) diagnostic.error = errorDetails(error);
  if (result) diagnostic.result = result;
  const payload = {
    notice: "Diagnostic log generated locally by ChatGPT Markdown Export. Conversation text, authentication tokens, query strings, and raw message content are intentionally not included.",
    popup: diagnostic,
    content_script: remote || null
  };
  diagnosticDownload = JSON.stringify(payload, null, 2) + "\n";
  diagnosticCreatedAt = new Date().toISOString();
  try { localStorage.setItem("cgx-last-diagnostic", JSON.stringify({ created_at: diagnosticCreatedAt, text: diagnosticDownload })); } catch (_) {}
  btnLog.textContent = "Download diagnostic log";
  btnLog.hidden = false;
}

function restoreDiagnosticLog() {
  try {
    const saved = JSON.parse(localStorage.getItem("cgx-last-diagnostic") || "null");
    if (!saved || typeof saved.text !== "string" || !saved.text) return;
    diagnosticDownload = saved.text;
    diagnosticCreatedAt = saved.created_at || null;
    btnLog.textContent = "Download last diagnostic log";
    btnLog.hidden = false;
  } catch (_) {}
}

function downloadDiagnosticLog() {
  if (!diagnosticDownload) return;
  const stamp = String(diagnosticCreatedAt || new Date().toISOString()).replace(/[:.]/g, "-");
  const blob = new Blob([diagnosticDownload], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `chatgpt-export-diagnostic-${stamp}.log`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function updateFailureLog(failures) {
  if (!Array.isArray(failures)) return;
  liveFailures = failures;
  btnFailures.hidden = !liveFailures.length;
  btnFailures.textContent = `Download failure log (${liveFailures.length})`;
}

function downloadFailureLog() {
  if (!liveFailures.length) return;
  const payload = {
    notice: "Per-conversation export failures. Conversation contents and authentication data are omitted.",
    extension_version: manifestVersion(), generated_at: new Date().toISOString(), failures: liveFailures
  };
  const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url;
  a.download = `chatgpt-export-failures-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ---------- Saved options ----------

function loadOptions() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem("cgx-options") || "{}");
  } catch (_) {}
  const format = ["md", "html", "both", "jex"].includes(saved.format) ? saved.format : "both";
  formatInputs.forEach((el) => (el.checked = el.value === format));
  optImages.checked = saved.images ?? true;
  optJson.checked = saved.json ?? false;
  optThinking.checked = saved.thinking ?? false;
  const mediaMode = saved.embeddedMd ? "embedded" : "links";
  mediaModeInputs.forEach((el) => (el.checked = el.value === mediaMode));
  const mdHtml = saved.mdHtml === false ? "pure" : "html";
  mdHtmlInputs.forEach((el) => (el.checked = el.value === mdHtml));
  if (saved.modernEmbeddedMd) {
    const jex = formatInputs.find((el) => el.value === "jex");
    if (jex) jex.checked = true;
  }
  optFiles.checked = saved.files ?? true;
  optBranches.checked = saved.branches ?? false;
  optIncremental.checked = saved.incremental ?? false;
  optChecksums.checked = saved.checksums ?? true;
  optPartSize.value = String(saved.partSizeMB ?? 1024);
  optJexDelay.value = String(Math.max(0, Math.min(30, Number(saved.jexDelayMs ?? 2000) / 1000)));
  optHistoryCount.value = String(Math.max(1, Math.min(100000, Number(saved.historyCount) || 100)));
  optLimit.checked = !!saved.historyLimit;
}

function historyLimit() {
  return Math.max(1, Math.min(100000, Math.floor(Number(optHistoryCount.value) || 100)));
}

function selectedFormat() {
  const el = formatInputs.find((i) => i.checked);
  return el ? el.value : "both";
}

function currentOptions(f = selectedFormat()) {
  const jex = f === "jex";
  const embeddedMd = !jex && mediaModeInputs.find((el) => el.checked)?.value === "embedded";
  return {
    format: f, md: jex || f !== "html", html: !jex && f !== "md", images: jex || optImages.checked, files: jex || optFiles.checked, json: jex ? false : optJson.checked, thinking: optThinking.checked,
    mdHtml: mdHtmlInputs.find((el) => el.checked)?.value !== "pure",
    embeddedMd, modernEmbeddedMd: jex, branches: jex ? false : optBranches.checked, incremental: jex ? false : optIncremental.checked, checksums: jex ? false : optChecksums.checked,
    partSizeMB: Math.max(100, Math.min(4096, Number(optPartSize.value) || 1024)),
    jexDelayMs: Math.max(0, Math.min(30000, Math.round((Number(optJexDelay.value) || 0) * 1000))),
    historyCount: historyLimit(), historyLimit: optLimit.checked
  };
}

function updateFormatUI() {
  const format = selectedFormat();
  const jex = format === "jex";
  document.querySelectorAll(".jex-hidden").forEach((el) => { el.hidden = jex; });
  document.querySelectorAll(".jex-only").forEach((el) => { el.hidden = !jex; });
  formatHint.textContent = FORMAT_HINTS[format] || "";
  optHistoryCount.disabled = !optLimit.checked;
  $("all-title").textContent = optLimit.checked
    ? `The ${historyLimit().toLocaleString()} most recent conversations`
    : (jex ? "Entire history (one .jex)" : "Entire history (.zip)");
  refreshButtons();
  checkPermission();
}

function saveOptions() {
  try {
    localStorage.setItem("cgx-options", JSON.stringify(currentOptions()));
  } catch (_) {}
  updateFormatUI();
  refreshButtons();
  checkPermission();
}

// ---------- State ----------


function showProgress(percent = 0, label = "") {
  const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  progressWrap.hidden = false;
  bar.max = 100;
  bar.value = value;
  progressPercent.textContent = `${value}%`;
  if (label) {
    if (diagnostic && (label !== lastProgressLabel || value === 0 || value === 100)) {
      addDiagnostic("progress", { percent: value, label });
      lastProgressLabel = label;
    }
    setStatus(`${value}%: ${label}`);
  }
}

function updateActivity(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  activityList.replaceChildren();
  for (const entry of entries.slice(-8)) {
    const item = document.createElement("li");
    item.textContent = typeof entry === "string" ? entry : String(entry.label || "Working…");
    activityList.appendChild(item);
  }
  activityWrap.hidden = false;
}

function setStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle("error", isError);
}

let busy = false;
function refreshButtons() {
  // Keep the actions immediately clickable while the popup is resolving the
  // active tab. Conversation detection and export work happen only after a
  // click; we disable the buttons only once we know this is not a ChatGPT tab
  // or while an export launched from this popup is running.
  const unavailable = tabChecked && !tabId;
  btnCurrent.disabled = busy || unavailable;
  btnAll.disabled = busy || unavailable;
  btnPick.disabled = busy || unavailable;
  if (unavailable) {
    tabHint.textContent = "Open chatgpt.com in this tab to export.";
    tabHint.classList.add("error");
  }
}

function setBusy(b) {
  busy = b;
  btnCancel.hidden = !b;
  $("keep-tab").hidden = !b;
  btnCancel.disabled = false;
  btnCancel.textContent = "Cancel export";
  refreshButtons();
}

btnCancel.addEventListener("click", async () => {
  if (exportTabId == null) return;
  btnCancel.disabled = true;
  btnCancel.textContent = "Cancelling…";
  setStatus("Cancellation requested. Waiting for the current request to finish safely…");
  try {
    const result = await api.tabs.sendMessage(exportTabId, { type: "cgx-cancel-job" });
    if (!result || !result.ok) throw new Error(result?.error || "Could not cancel the running job.");
  } catch (error) {
    btnCancel.disabled = false;
    btnCancel.textContent = "Cancel export";
    setStatus(error.message || "Could not cancel the running job.", true);
  }
});

// Images outside chatgpt.com (web search, products) require access to all sites.
async function checkPermission() {
  const embedded = mediaModeInputs.find((el) => el.checked)?.value === "embedded";
  const grantHint = $("grant-hint");
  if ((!optImages.checked && !optFiles.checked && !embedded && selectedFormat() !== "jex") || !api.permissions) {
    btnGrant.hidden = grantHint.hidden = true;
    return;
  }
  try {
    const granted = await api.permissions.contains(ALL_SITES);
    btnGrant.hidden = grantHint.hidden = false;
    btnGrant.textContent = granted ? "Disable external media" : "Allow external media";
    btnGrant.title = granted
      ? "Remove permission to download media hosted outside ChatGPT"
      : "Optional permission to download media hosted outside ChatGPT";
    btnGrant.setAttribute("aria-pressed", String(granted));
    btnGrant.dataset.granted = String(granted);
  } catch (_) {
    btnGrant.hidden = true;
  }
}

btnGrant.addEventListener("click", async () => {
  try {
    // Read the state prepared by checkPermission so request() remains the
    // first permission API call made from this user-initiated event.
    const granted = btnGrant.dataset.granted === "true";
    if (granted) {
      const removed = await api.permissions.remove(ALL_SITES);
      setStatus(removed ? "External media permission disabled." : "Permission could not be disabled.", !removed);
    } else {
      const ok = await api.permissions.request(ALL_SITES);
      setStatus(ok ? "Access granted." : "Without this access, only generated images will be saved.", !ok);
    }
  } catch (e) {
    setStatus(e.message, true);
  }
  checkPermission();
});

// Each "i" bubble shows its explanation right under its own option; clicking
// it again hides it.
const infoButtons = [...document.querySelectorAll(".info")];
infoButtons.forEach((button) => {
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const wasOpen = button.getAttribute("aria-expanded") === "true";
    infoButtons.forEach((other) => other.setAttribute("aria-expanded", "false"));
    if (wasOpen) { help.hidden = true; return; }
    button.setAttribute("aria-expanded", "true");
    help.textContent = button.dataset.help || "";
    (button.closest("label, .grant-row") || button).after(help);
    help.hidden = !help.textContent;
  });
});

const CONTENT_SCRIPT_FILES = [
  "lib/marked.umd.js",
  "src/zip.js",
  "src/render.js",
  "src/content.js",
  "src/picker.js"
];

function missingReceiver(error) {
  const text = String((error && error.message) || error || "");
  return /receiving end does not exist|could not establish connection|message port closed before/i.test(text);
}

async function injectContentScript() {
  if (!tabId) throw new Error("No active ChatGPT tab.");
  addDiagnostic("content-script.inject.start", { files: CONTENT_SCRIPT_FILES });
  showProgress(1, "Connecting extension to this tab...");

  if (api.scripting && api.scripting.executeScript) {
    // Inject sequentially so content.js always sees marked, ZIP and renderer globals.
    for (const file of CONTENT_SCRIPT_FILES) {
      await api.scripting.executeScript({ target: { tabId }, files: [file] });
      addDiagnostic("content-script.inject.file", { file });
    }
    return;
  }

  // Compatibility fallback for browsers exposing the legacy API.
  if (api.tabs && api.tabs.executeScript) {
    for (const file of CONTENT_SCRIPT_FILES) {
      await api.tabs.executeScript(tabId, { file, runAt: "document_idle" });
      addDiagnostic("content-script.inject.file", { file, legacy: true });
    }
    return;
  }

  throw new Error("The page connector could not be injected. Reload the ChatGPT tab and try again.");
}

async function send(msg, allowInjectionRetry = true) {
  try {
    return await api.tabs.sendMessage(tabId, msg);
  } catch (error) {
    addDiagnostic("message.send.error", errorDetails(error));
    if (!allowInjectionRetry || !missingReceiver(error)) throw error;
    addDiagnostic("message.send.retry", { reason: "missing receiver" });
    await injectContentScript();
    // Give the newly injected listener one event-loop turn to register.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return api.tabs.sendMessage(tabId, msg);
  }
}

async function resolveActiveTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const onChatGPT = tab && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || "");
  tabChecked = true;
  activeTabUrl = tab && tab.url ? tab.url : null;
  tabId = onChatGPT ? tab.id : null;
  if (diagnostic) { diagnostic.page = safePageUrl(activeTabUrl); addDiagnostic("tab.resolved", { on_chatgpt: !!onChatGPT, page: diagnostic.page }); }
  refreshButtons();
  return !!tabId;
}

async function init() {
  try {
    const onChatGPT = await resolveActiveTab();
    const resumed = await restoreExportActivity();
    if (resumed) pollExportActivity();
  } catch {
    tabChecked = true;
    tabId = null;
    refreshButtons();
    setStatus("Reload the ChatGPT page, then reopen this window.", true);
  }
}

function showFinishedExport(job) {
  if (!job) return;
  const key = `cgx-seen-export-${job.finishedAt}`;
  if (!job.finishedAt) return;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch (_) {}
  setBusy(false);
  if (job.cancelled) {
    updateActivity([{ label: "Export cancelled. You can start a new export." }]);
    setStatus("Export cancelled. Start a new export whenever you’re ready.");
    return;
  }
  if (!job.ok) {
    updateActivity([{ label: `Export failed: ${job.error || "Unknown error."}` }]);
    setStatus(`The previous export failed: ${job.error || "Unknown error."}`, true);
    return;
  }
  const message = job.joplinHistory
    ? `${job.count} conversations exported as notes in one JEX notebook. Import the single JEX file into Joplin.`
    : (job.joplin ? "Joplin JEX export ready. Import it with File > Import > JEX." : `${job.count} conversation(s) exported.`);
  const deletionMessage = job.autoDeleteRequested
    ? ` Automatic deletion succeeded for ${job.autoDeleted || 0} conversation(s).${job.autoDeleteFailed ? ` ${job.autoDeleteFailed} remain undeleted.` : ""} Removed conversations may take up to 10 minutes to disappear from history.`
    : "";
  const projectDeletionMessage = job.autoDeleteProjectsRequested
    ? ` Project deletion succeeded for ${job.autoDeletedProjects || 0} project(s).${job.autoDeleteProjectsFailed ? ` ${job.autoDeleteProjectsFailed} were kept or could not be deleted; see the export result.` : ""}`
    : "";
  setStatus(`${message}${job.failed ? ` ${job.failed} export(s) failed; check the downloaded errors report and diagnostic log.` : ""}${deletionMessage}${projectDeletionMessage}`, !!(job.failed || job.autoDeleteFailed || job.autoDeleteProjectsFailed));
  updateActivity([{ label: job.autoDeleteRequested ? `Export complete; automatic deletion succeeded for ${job.autoDeleted || 0} conversation(s).` : (job.failed ? `Export completed with ${job.failed} failed conversation(s).` : "Export completed successfully.") }]);
  offerReview(job.reviewCount || 0);
}

async function restoreExportActivity() {
  let tabs = [];
  try { tabs = await api.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] }); } catch (_) { return false; }
  for (const tab of tabs) {
    if (tab.id == null) continue;
    try {
      const state = await api.tabs.sendMessage(tab.id, { type: "cgx-ping" });
      if (state && state.busy) {
        exportTabId = tab.id;
        activeTabUrl = tab.url || null;
        setBusy(true);
        const progress = state.progress || { percent: 0, label: "Export is running in another tab…" };
        const activeElsewhere = tab.id !== tabId;
        showProgress(progress.percent, `${progress.label || "Export in progress…"}${activeElsewhere ? " · running in another tab" : ""}`);
        updateActivity(state.activity);
        updateFailureLog(state.failures);
        return true;
      }
      if (state && state.lastJob && Date.now() - state.lastJob.finishedAt < 10 * 60 * 1000) {
        showFinishedExport(state.lastJob);
      }
    } catch (_) {}
  }
  return false;
}

function pollExportActivity() {
  if (exportTabId == null || !busy) return;
  const sourceTabId = exportTabId;
  api.tabs.sendMessage(sourceTabId, { type: "cgx-ping" }).then((state) => {
    if (sourceTabId !== exportTabId) return;
    if (state && state.busy) {
      const progress = state.progress || {};
      showProgress(progress.percent, progress.label || "Export in progress…");
      updateActivity(state.activity);
      updateFailureLog(state.failures);
      setTimeout(pollExportActivity, 1200);
    } else {
      setBusy(false);
      exportTabId = null;
      if (state && state.lastJob) showFinishedExport(state.lastJob);
    }
  }).catch(() => setTimeout(pollExportActivity, 1800));
}

async function run(type, optionOverrides = {}) {
  if (busy) return;
  let keepBusy = false;
  startDiagnostic(type);
  addDiagnostic("export.requested");
  // Do not preflight the conversation when opening the popup. Resolve the
  // active ChatGPT tab at click time, then let the content script perform all
  // conversation detection, API access, fallbacks and export processing.
  if (!tabId) {
    try {
      if (!(await resolveActiveTab())) {
        const e = new Error("Open chatgpt.com in this tab to export.");
        addDiagnostic("export.error", errorDetails(e));
        prepareDiagnosticLog({ error: e });
        setStatus(`${e.message} Diagnostic log available below.`, true);
        return;
      }
    } catch (e) {
      addDiagnostic("export.error", errorDetails(e));
      prepareDiagnosticLog({ error: e });
      setStatus(`${e.message || "Could not access the active ChatGPT tab."} Diagnostic log available below.`, true);
      return;
    }
  }
  setBusy(true);
  exportTabId = tabId;
  activityWrap.hidden = false;
  updateFailureLog([]);
  offerReview(0);
  updateActivity([{ label: type === "cgx-export-all" ? "Starting account history scan…" : "Starting conversation export…" }]);
  showProgress(0, type === "cgx-export-all" ? "Loading conversation list…" : "Starting export…");
  try {
    addDiagnostic("message.send", { type });
    const r = await send({ type, options: { ...currentOptions(), ...optionOverrides } });
    if (!r.ok) {
      const err = new Error(r.error || "Export failed.");
      err.cancelled = !!r.cancelled;
      err.remoteDiagnostics = r.diagnostics || null;
      throw err;
    }
    addDiagnostic("export.response", { count: r.count || 0, failed: r.failed || 0, image_failures: r.imageFailures || 0, file_failures: r.fileFailures || 0, parts: r.parts || 0 });
    let text = r.joplinHistory
      ? `${r.count} conversations exported as notes in one JEX notebook. Import the single JEX file into Joplin.`
      : (r.joplin ? "Joplin JEX export ready. Import it with File > Import > JEX." : (r.count > 1 ? `${r.count} conversations exported.` : "Conversation exported."));
    if (r.failed) text += r.joplinHistory ? ` ${r.failed} failed; see the downloaded errors report and diagnostic log.` : ` ${r.failed} failed; see _erreurs.txt.`;
    updateFailureLog(r.failureDetails);
    if (r.imageFailures) text += ` ${r.imageFailures} image(s) could not be downloaded; kept as remote links.`;
    if (r.fileFailures) text += ` ${r.fileFailures} file(s) could not be downloaded.`;
    if (currentOptions().embeddedMd && !currentOptions().modernEmbeddedMd) text += " Self-contained MIME/Base64 Markdown included.";
    if (Array.isArray(r.autoDeleteResults)) {
      const deleted = r.autoDeleteResults.filter((entry) => entry.ok).length;
      const failedDeletes = r.autoDeleteResults.length - deleted;
      text += ` Automatic deletion succeeded for ${deleted} conversation(s).${failedDeletes ? ` ${failedDeletes} remain undeleted; use Review to inspect them.` : ""} Removed conversations may take up to 10 minutes to disappear from history.`;
    }
    if (Array.isArray(r.autoDeleteProjectResults)) {
      const deleted = r.autoDeleteProjectResults.filter((entry) => entry.ok).length;
      const failedDeletes = r.autoDeleteProjectResults.length - deleted;
      text += ` Project deletion succeeded for ${deleted} project(s).${failedDeletes ? ` ${failedDeletes} project(s) were kept or could not be deleted.` : ""}`;
    }
    showProgress(100);
    const hasIssues = !!(r.failed || r.imageFailures || r.fileFailures || (r.autoDeleteResults && r.autoDeleteResults.some((entry) => !entry.ok)) || (r.autoDeleteProjectResults && r.autoDeleteProjectResults.some((entry) => !entry.ok)));
    if (hasIssues) {
      prepareDiagnosticLog({
        remote: r.diagnostics || null,
        result: { failed: r.failed || 0, image_failures: r.imageFailures || 0, file_failures: r.fileFailures || 0, automatic_deletions_failed: r.autoDeleteResults ? r.autoDeleteResults.filter((entry) => !entry.ok).length : 0, project_deletions_failed: r.autoDeleteProjectResults ? r.autoDeleteProjectResults.filter((entry) => !entry.ok).length : 0, count: r.count || 0, parts: r.parts || 0, conversation_failures: r.failureDetails || [] }
      });
      text += " Diagnostic log available below.";
    }
    setStatus(text, hasIssues);
    offerReview(r.reviewCount || 0);
  } catch (e) {
    if (e.cancelled || e.name === "AbortError") {
      updateActivity([{ label: "Export cancelled. You can start a new export." }]);
      setStatus("Export cancelled. Start a new export whenever you’re ready.");
      return;
    }
    if (/already running in this tab/i.test(e.message || "")) {
      if (await restoreExportActivity()) { keepBusy = true; pollExportActivity(); return; }
    }
    addDiagnostic("export.error", errorDetails(e));
    prepareDiagnosticLog({ error: e, remote: e.remoteDiagnostics || null });
    updateActivity([{ label: `Export failed: ${e.message || "Unknown error."}` }]);
    setStatus(`${e.message || "Export failed."} Diagnostic log available below.`, true);
  } finally {
    if (!keepBusy) {
      setBusy(false);
      exportTabId = null;
    }
  }
}

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "cgx-progress") return;
  if (exportTabId != null && sender && sender.tab && sender.tab.id !== exportTabId) return;
  const percent = Number.isFinite(Number(msg.percent))
    ? Number(msg.percent)
    : (Number(msg.total) > 0 ? (Number(msg.done) / Number(msg.total)) * 100 : 0);
  showProgress(percent, msg.label || "Processing…");
  updateActivity(msg.activity);
  updateFailureLog(msg.failures);
  if (percent >= 100 && exportTabId != null) setTimeout(pollExportActivity, 150);
});

[...formatInputs, ...mediaModeInputs, ...mdHtmlInputs, optImages, optFiles, optJson, optThinking, optBranches, optIncremental, optChecksums, optPartSize, optJexDelay, optHistoryCount, optLimit].forEach((el) => el.addEventListener("change", saveOptions));
optHistoryCount.addEventListener("input", updateFormatUI);
btnCurrent.addEventListener("click", () => run("cgx-export-current"));
btnAll.addEventListener("click", () => {
  autoDeleteAfterExport.checked = false;
  autoDeleteProjects.checked = false;
  autoDeleteProjects.disabled = projectDeleteUnavailable();
  deleteProjectsWarning.hidden = true;
  confirmAutoDelete.checked = false;
  autoDeleteProjectsRow.hidden = true;
  confirmAutoDeleteRow.hidden = true;
  startHistoryExport.disabled = false;
  historyExportDialog.showModal();
});
$("cancel-history-export").addEventListener("click", () => historyExportDialog.close());
function updateHistoryDeleteOptions() {
  const deleteChats = autoDeleteAfterExport.checked;
  autoDeleteProjectsRow.hidden = !deleteChats;
  autoDeleteProjects.disabled = projectDeleteUnavailable();
  if (autoDeleteProjects.disabled) autoDeleteProjects.checked = false;
  deleteProjectsWarning.hidden = !(deleteChats && autoDeleteProjects.checked);
  confirmAutoDeleteRow.hidden = !deleteChats;
  if (!deleteChats) {
    autoDeleteProjects.checked = false;
    confirmAutoDelete.checked = false;
    deleteProjectsWarning.hidden = true;
  }
  startHistoryExport.disabled = deleteChats && !confirmAutoDelete.checked;
}
function projectDeleteUnavailable() {
  return optLimit.checked || (selectedFormat() !== "jex" && optIncremental.checked);
}
autoDeleteAfterExport.addEventListener("change", () => {
  updateHistoryDeleteOptions();
});
autoDeleteProjects.addEventListener("change", () => {
  deleteProjectsWarning.hidden = !autoDeleteProjects.checked;
});
confirmAutoDelete.addEventListener("change", () => {
  startHistoryExport.disabled = autoDeleteAfterExport.checked && !confirmAutoDelete.checked;
});
optLimit.addEventListener("change", () => {
  if (historyExportDialog.open) updateHistoryDeleteOptions();
});
optIncremental.addEventListener("change", () => {
  if (historyExportDialog.open) updateHistoryDeleteOptions();
});
formatInputs.forEach((el) => el.addEventListener("change", () => {
  if (historyExportDialog.open) updateHistoryDeleteOptions();
}));
startHistoryExport.addEventListener("click", () => {
  if (autoDeleteAfterExport.checked && !confirmAutoDelete.checked) return;
  const autoDelete = autoDeleteAfterExport.checked;
  const autoDeleteProjectsValue = autoDelete && autoDeleteProjects.checked && !autoDeleteProjects.disabled;
  historyExportDialog.close();
  run("cgx-export-all", {
    conversationLimit: optLimit.checked ? historyLimit() : 0,
    autoDeleteAfterExport: autoDelete,
    autoDeleteProjectsAfterExport: autoDeleteProjectsValue
  });
});
// Opens the large conversation picker inside the ChatGPT page, then closes
// the popup so the user can work in it directly.
async function openPicker(review = false) {
  if (busy) return;
  try {
    if (!tabId && !(await resolveActiveTab())) { setStatus("Open chatgpt.com in this tab to export.", true); return; }
    const formats = Object.fromEntries(["md", "html", "both", "jex"].map((f) => [f, { ...currentOptions(f), incremental: false }]));
    const r = await send({ type: "cgx-open-picker", formats, format: selectedFormat(), review });
    if (!r || !r.ok) throw new Error(r?.error || "Could not open the conversation picker.");
    window.close();
  } catch (e) {
    progressWrap.hidden = true;
    setStatus(e.message || "Could not open the conversation picker. Reload the ChatGPT tab and try again.", true);
  }
}
btnPick.addEventListener("click", () => openPicker(false));
// After a history export, deleting the exported conversations is offered in
// the page (list + two-step confirmation); it is never done automatically.
function offerReview(count) {
  btnReview.hidden = !count;
  btnReview.textContent = `Review or delete the ${Number(count).toLocaleString()} exported conversations…`;
}
btnReview.addEventListener("click", () => openPicker(true));
// Widen the popup while the options are open (see body.wide in popup.html)
// and remember the choice for the next time the popup opens.
const advanced = $("advanced");
function applyOptionsLayout() { document.body.classList.toggle("wide", advanced.open); }
try { advanced.open = localStorage.getItem("cgx-options-open") === "1"; } catch (_) {}
applyOptionsLayout();
advanced.addEventListener("toggle", () => {
  applyOptionsLayout();
  try { localStorage.setItem("cgx-options-open", advanced.open ? "1" : "0"); } catch (_) {}
});
btnLog.addEventListener("click", downloadDiagnosticLog);
btnFailures.addEventListener("click", downloadFailureLog);
loadOptions();
updateFormatUI();
checkPermission();
restoreDiagnosticLog();
init();


// V0.2 opt-in schedule; a freshly forked extension has no old incremental
// index. Keep the switch unavailable until the index is safely migrated.
async function cgxV02InitUI() {
  const enabled = $("cgx-v02-enabled");
  const info = $("cgx-v02-status");
  const importButton = $("cgx-v02-import-index");
  const sourceFile = $("cgx-v02-source-file");
  const baselineFile = $("cgx-v02-baseline-file");
  const aliasFile = $("cgx-v02-alias-file");
  const importResult = $("cgx-v02-import-result");
  const previewButton = $("cgx-v02-preview-button");
  const previewResult = $("cgx-v02-preview-result");
  const pilotConversation = $("cgx-v02-pilot-conversation");
  const pilotWorkspace = $("cgx-v02-pilot-workspace");
  const pilotPrepare = $("cgx-v02-pilot-prepare");
  const pilotStart = $("cgx-v02-pilot-start");
  const pilotResult = $("cgx-v02-pilot-result");
  const pilotReceipt = $("cgx-v02-pilot-receipt");
  const pilotFinalize = $("cgx-v02-pilot-finalize");
  if (!enabled || !info || !importButton || !sourceFile || !baselineFile || !aliasFile || !importResult || !previewButton || !previewResult ||
      !pilotConversation || !pilotWorkspace || !pilotPrepare || !pilotStart || !pilotResult || !pilotReceipt || !pilotFinalize) return;
  let baselineReady = false;
  let pilotGateToken = "";
  let currentData = null;
  function canImport() {
    return !baselineReady && !!(sourceFile.files?.length && baselineFile.files?.length && !enabled.checked);
  }
  function validPilotInput() {
    return /^[A-Za-z0-9_-]{8,160}$/.test(pilotConversation.value.trim()) &&
      /^[A-Za-z0-9_-]{4,160}$/.test(pilotWorkspace.value.trim());
  }
  function updatePilotButtons() {
    const pending = currentData?.pilot?.pendingStatus || "";
    const aliasesReady = currentData?.migration?.verifiedSharedAliases === 2;
    const ready = baselineReady && aliasesReady && !enabled.checked && !pending;
    pilotPrepare.disabled = !ready || !validPilotInput();
    pilotStart.disabled = !ready || !pilotGateToken;
    pilotFinalize.disabled = pending !== "browser_download_complete_v01_pending" ||
      !pilotReceipt.files?.length;
  }
  function showState(data) {
    currentData = data;
    const state = data.state || {};
    enabled.checked = !!state.enabled;
    baselineReady = !!data.indexReady;
    enabled.disabled = !data.indexReady;
    previewButton.disabled = !data.indexReady;
    importButton.disabled = !canImport();
    updatePilotButtons();
    if (!data.indexReady) {
      info.textContent = "旧版增量索引尚未通过核对。自动采集已锁定，避免重新下载全部历史。";
      return;
    }
    const due = state.nextDueAt ? new Date(state.nextDueAt).toLocaleString("zh-CN", {timeZone:"Asia/Shanghai"}) : "未设置";
    info.textContent = state.enabled
      ? "已开启；下次计划：" + due + "（北京时间）；上次状态：" + (state.lastStatus || "无")
      : "历史基线已存在；自动采集当前关闭。";
    if (state.lastError) info.textContent += "；错误：" + state.lastError;
    if (data.pilot?.pendingStatus === "browser_download_complete_v01_pending")
      pilotResult.textContent = "浏览器下载已确认，真实索引尚未提交；请先完成 ZIP 与 V0.1 测试副本验收。";
    else if (data.pilot?.pendingStatus === "committed")
      pilotResult.textContent = "单条 ZIP 已通过 V0.1 回执核对，该条索引已提交。";
  }
  async function refresh() {
    try {
      const response = await api.runtime.sendMessage({type:"cgx-v02-get"});
      if (!response?.ok) throw new Error(response?.error || "状态读取失败");
      showState(response);
    } catch (error) {
      enabled.disabled = true;
      info.textContent = "无法读取定时任务状态：" + String(error?.message || error);
    }
  }
  enabled.addEventListener("change", async () => {
    enabled.disabled = true;
    try {
      const response = await api.runtime.sendMessage({
        type:"cgx-v02-set", enabled:!!enabled.checked
      });
      if (!response?.ok) throw new Error(response?.error || "保存失败");
    } catch (error) {
      info.textContent = String(error?.message || error);
    }
    await refresh();
  });
  function updateImportButton() {
    importButton.disabled = !canImport();
  }
  previewButton.addEventListener("click", async () => {
    previewButton.disabled = true;
    previewResult.textContent = "正在只读扫描；不会生成或下载 ZIP…";
    try {
      const result = await api.runtime.sendMessage({type:"cgx-v02-preview-now"});
      if(!result?.ok) throw new Error(result?.error || "预检失败");
      previewResult.textContent =
        "扫描 " + result.listed + " 条，新增 " + result.newCount +
        " 条，修改 " + result.modified + " 条；" +
        (result.safeToTest ? "低于测试保护上限，可进入受控验收。"
          : "超出保护上限 " + result.maxPilotDelta + " 条，禁止自动导出。");
    } catch (e) {
      previewResult.textContent = "预检未通过，不会下载：" + String(e?.message || e);
    }
    await refresh();
  });

  function pilotInputChanged() {
    pilotGateToken = "";
    pilotResult.textContent = "";
    updatePilotButtons();
  }
  pilotConversation.addEventListener("input", pilotInputChanged);
  pilotWorkspace.addEventListener("input", pilotInputChanged);
  pilotReceipt.addEventListener("change", updatePilotButtons);
  pilotPrepare.addEventListener("click", async () => {
    pilotPrepare.disabled = true;
    pilotStart.disabled = true;
    pilotResult.textContent = "正在精确核对目标并记录本次变化摘要；不会下载…";
    try {
      const result = await api.runtime.sendMessage({
        type:"cgx-v02-pilot-prepare",
        target:{conversationId:pilotConversation.value.trim(),workspaceId:pilotWorkspace.value.trim()}
      });
      if(!result?.ok || !result.gateToken) throw new Error(result?.error || "目标核对失败");
      pilotGateToken = result.gateToken;
      pilotResult.textContent = "已核对 1 条新目标；本次扫描共 " + result.changed +
        " 条变化，低于保护上限。下载前仍会重新扫描。";
    } catch (error) {
      pilotGateToken = "";
      pilotResult.textContent = "目标未通过，不会下载：" + String(error?.message || error);
    }
    updatePilotButtons();
  });
  pilotStart.addEventListener("click", async () => {
    const token = pilotGateToken;
    pilotGateToken = "";
    pilotStart.disabled = true;
    pilotPrepare.disabled = true;
    pilotResult.textContent = "正在重新扫描并生成一条测试 ZIP；真实索引保持不变…";
    try {
      const result = await api.runtime.sendMessage({type:"cgx-v02-pilot-start",gateToken:token});
      if(!result?.ok || result.indexCommitted !== false)
        throw new Error(result?.error || "单条下载未安全完成");
      pilotResult.textContent = "下载已由浏览器确认；真实索引尚未提交，等待 V0.1 本地验收回执。";
    } catch (error) {
      pilotResult.textContent = "下载验收未通过，真实索引未改变：" + String(error?.message || error);
    }
    await refresh();
  });
  pilotFinalize.addEventListener("click", async () => {
    pilotFinalize.disabled = true;
    try {
      const file = pilotReceipt.files?.[0];
      if(!file || file.size > 64 * 1024) throw new Error("请选择小于64KB的本地V0.1验收回执。");
      const receipt = JSON.parse(await file.text());
      const result = await api.runtime.sendMessage({type:"cgx-v02-pilot-finalize",receipt});
      if(!result?.ok || result.status !== "committed")
        throw new Error(result?.error || "回执核对失败");
      pilotResult.textContent = result.alreadyCommitted
        ? "该回执已提交过，索引保持幂等。"
        : "V0.1回执已核对，仅新增这一条索引。";
      pilotReceipt.value = "";
    } catch (error) {
      pilotResult.textContent = "未提交索引：" + String(error?.message || error);
    }
    await refresh();
  });

  sourceFile.addEventListener("change", updateImportButton);
  baselineFile.addEventListener("change", updateImportButton);
  aliasFile.addEventListener("change", updateImportButton);
  importButton.addEventListener("click", async () => {
    importButton.disabled = true;
    importResult.textContent = "正在本地验证两份索引文件…";
    try {
      const first = sourceFile.files?.[0];
      const second = baselineFile.files?.[0];
      const third = aliasFile.files?.[0] || null;
      if (!first || !second || [first, second, third].filter(Boolean).some(f => f.size > 512 * 1024))
        throw new Error("请选择必要JSON文件，单个文件不能超过512KB。");
      const source = JSON.parse(await first.text());
      const baseline = JSON.parse(await second.text());
      const aliasProof = third ? JSON.parse(await third.text()) : null;
      const result = await api.runtime.sendMessage({
        type: "cgx-v02-import-index", source, baseline, aliasProof
      });
      if (!result?.ok) throw new Error(result?.error || "迁移失败");
      importResult.textContent =
        "本地索引核验成功：" + result.matchedBaselineIds + "条基线已匹配，" +
        result.importedEntries + "条旧扩展记录已迁移，其中shared映射" +
        result.mappedSharedAliases + "条。后续仍需Windows受控增量验收。";
      sourceFile.value = "";
      baselineFile.value = "";
      aliasFile.value = "";
    } catch (error) {
      importResult.textContent = "未执行迁移：" + String(error?.message || error);
    }
    await refresh();
  });
  await refresh();
}
cgxV02InitUI();
