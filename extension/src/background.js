importScripts("contracts.js", "filename.js", "attachments.js");

const api = globalThis.ChatGPTExporter;
const JOB_PREFIX = "chatgpt-export-job:";
const CONTENT_SCRIPT_FILES = [
  "src/contracts.js",
  "src/filename.js",
  "src/markdown.js",
  "src/attachments.js",
  "src/attachment-reconciler.js",
  "src/zip.js",
  "src/turn-normalizer.js",
  "src/chatgpt-adapter.js",
  "src/content-entry.js",
  "src/panel-shell.js",
  "panel.js"
];
const ACTION_ICONS = Object.freeze({
  light: Object.freeze({
    16: chrome.runtime.getURL("icons/icon-light-16.png").replace(chrome.runtime.getURL(""), ""),
    32: chrome.runtime.getURL("icons/icon-light-32.png").replace(chrome.runtime.getURL(""), ""),
    48: chrome.runtime.getURL("icons/icon-light-48.png").replace(chrome.runtime.getURL(""), ""),
    128: chrome.runtime.getURL("icons/icon-light-128.png").replace(chrome.runtime.getURL(""), "")
  }),
  dark: Object.freeze({
    16: chrome.runtime.getURL("icons/icon-dark-16.png").replace(chrome.runtime.getURL(""), ""),
    32: chrome.runtime.getURL("icons/icon-dark-32.png").replace(chrome.runtime.getURL(""), ""),
    48: chrome.runtime.getURL("icons/icon-dark-48.png").replace(chrome.runtime.getURL(""), ""),
    128: chrome.runtime.getURL("icons/icon-dark-128.png").replace(chrome.runtime.getURL(""), "")
  })
});

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      resolve(error ? { ok: false, error: error.message } : (response || { ok: false }));
    });
  });
}

async function handleActionClick(tab) {
  if (!tab || !Number.isInteger(tab.id) || !/^https:\/\/chatgpt\.com\//i.test(tab.url || "")) return;
  const toggled = await sendTabMessage(tab.id, { type: "TOGGLE_EXPORTER_PANEL" });
  if (toggled.ok) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPT_FILES });
  await sendTabMessage(tab.id, { type: "SHOW_EXPORTER_PANEL" });
}

chrome.action.onClicked.addListener((tab) => {
  handleActionClick(tab).catch(() => {});
});

function storageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new api.ExportError(api.ERROR_CODES.INVALID_INPUT, error.message));
      else resolve(result[key]);
    });
  });
}

function storageSet(key, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new api.ExportError(api.ERROR_CODES.INVALID_INPUT, error.message));
      else resolve();
    });
  });
}

function storageRemove(key) {
  return new Promise((resolve) => chrome.storage.local.remove(key, resolve));
}

function downloadUrl(url, filename) {
  if (!/^(blob:chrome-extension:\/\/|data:text\/)/i.test(url || "")) {
    throw new api.ExportError(api.ERROR_CODES.INVALID_INPUT, "Only extension-owned Blob or text data URLs may be downloaded.");
  }
  const safeName = api.sanitizeFilenamePart(filename, "chatgpt-export");
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename: safeName, saveAs: false, conflictAction: "uniquify" }, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error || !Number.isInteger(downloadId)) reject(new api.ExportError(api.ERROR_CODES.DOWNLOAD_FAILED, error ? error.message : "Chrome did not create a download."));
      else resolve(downloadId);
    });
  });
}

function markdownDataUrl(markdown) {
  api.ensureTranscriptSize(markdown);
  return `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`;
}

function searchOwnDownload(downloadId) {
  return new Promise((resolve, reject) => {
    chrome.downloads.search({ id: downloadId }, (items) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new api.ExportError(api.ERROR_CODES.DOWNLOAD_FAILED, error.message));
      else resolve(items && items[0]);
    });
  });
}

async function waitForDownloadTerminal(downloadId) {
  const deadline = Date.now() + api.LIMITS.downloadWaitMs;
  while (Date.now() < deadline) {
    const item = await searchOwnDownload(downloadId);
    if (item && item.state === "complete") {
      return { downloadId, state: item.state, filename: item.filename, bytesReceived: item.bytesReceived };
    }
    if (item && item.state === "interrupted") {
      throw new api.ExportError(api.ERROR_CODES.DOWNLOAD_FAILED, `Chrome interrupted the download: ${item.error || "unknown reason"}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new api.ExportError(api.ERROR_CODES.DOWNLOAD_TIMEOUT, "Chrome did not finish the download within two minutes.");
}

function fingerprintJob(request) {
  const value = `${request.sourceUrl}|${request.title}|${request.markdown.length}|${Boolean(request.options.includeMedia)}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function createJob(request, sender) {
  api.ensureTranscriptSize(request.markdown);
  const options = api.validateOptions(request.options || {});
  const attachments = api.assignArchivePaths(Array.isArray(request.attachments) ? request.attachments : []);
  if (attachments.length > api.LIMITS.maxMediaEntries) throw new api.ExportError(api.ERROR_CODES.MEDIA_LIMIT_EXCEEDED, "The conversation has more than 500 media entries.");
  const key = `${JOB_PREFIX}${options.jobId}`;
  const previous = await storageGet(key);
  const fingerprint = fingerprintJob(request);
  if (previous && previous.fingerprint === fingerprint && previous.expiresAt > Date.now()) return previous;
  const job = {
    schemaVersion: 1,
    id: options.jobId,
    fingerprint,
    phase: "awaiting-files",
    title: api.sanitizeFilenamePart(request.title, "chatgpt-conversation"),
    sourceUrl: request.sourceUrl,
    tabId: sender && sender.tab ? sender.tab.id : request.tabId || null,
    transcript: request.markdown,
    snapshotComplete: Boolean(request.snapshotComplete),
    attachments,
    options,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + api.LIMITS.jobExpiryMs
  };
  await storageSet(key, job);
  return job;
}

async function getJob(jobId) {
  if (!/^[a-z0-9-]{8,80}$/i.test(jobId || "")) throw new api.ExportError(api.ERROR_CODES.INVALID_INPUT, "Invalid job identifier.");
  const key = `${JOB_PREFIX}${jobId}`;
  const job = await storageGet(key);
  if (!job) throw new api.ExportError(api.ERROR_CODES.JOB_NOT_FOUND, "The export job was not found.");
  if (job.expiresAt <= Date.now()) {
    await storageRemove(key);
    throw new api.ExportError(api.ERROR_CODES.JOB_EXPIRED, "The export job expired. Start the export again.");
  }
  return job;
}

async function updateJob(jobId, update) {
  const job = await getJob(jobId);
  const phase = update && update.phase;
  if (!api.JOB_PHASES.includes(phase)) throw new api.ExportError(api.ERROR_CODES.INVALID_INPUT, "Invalid job phase.");
  const currentIndex = api.JOB_PHASES.indexOf(job.phase);
  const nextIndex = api.JOB_PHASES.indexOf(phase);
  const retry = job.phase === "failed" && phase === "building";
  if (nextIndex < currentIndex && !retry && !["failed", "cancelled"].includes(phase)) {
    throw new api.ExportError(api.ERROR_CODES.INVALID_INPUT, "Job phase cannot move backward.");
  }
  job.phase = phase;
  job.updatedAt = Date.now();
  if (update.result && typeof update.result === "object") job.result = update.result;
  await storageSet(`${JOB_PREFIX}${jobId}`, job);
  return job;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  const run = async () => {
    switch (message.type) {
      case "SET_ACTION_ICON_THEME": {
        const tabId = sender && sender.tab && sender.tab.id;
        const theme = message.theme === "dark" ? "dark" : "light";
        if (Number.isInteger(tabId)) await chrome.action.setIcon({ tabId, path: ACTION_ICONS[theme] });
        return { theme };
      }
      case "CREATE_ARCHIVE_JOB":
        return createJob(message, sender);
      case "GET_ARCHIVE_JOB":
        return getJob(message.jobId);
      case "UPDATE_ARCHIVE_JOB":
        return updateJob(message.jobId, message.update);
      case "DELETE_ARCHIVE_JOB":
        await storageRemove(`${JOB_PREFIX}${message.jobId}`);
        return { removed: true };
      case "DOWNLOAD_URL": {
        const downloadId = await downloadUrl(message.url, message.filename);
        return waitForDownloadTerminal(downloadId);
      }
      case "DOWNLOAD_MARKDOWN": {
        const downloadId = await downloadUrl(markdownDataUrl(message.markdown), message.filename);
        return waitForDownloadTerminal(downloadId);
      }
      default:
        return null;
    }
  };
  run().then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: api.serializeError(error) }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(null, (items) => {
    const expired = Object.entries(items || {}).filter(([key, value]) => key.startsWith(JOB_PREFIX) && (!value || value.expiresAt <= Date.now())).map(([key]) => key);
    if (expired.length) chrome.storage.local.remove(expired);
  });
});
