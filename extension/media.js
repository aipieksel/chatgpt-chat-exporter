(function initializeArchivePage() {
  "use strict";

  const api = globalThis.ChatGPTExporter;
  const params = new URLSearchParams(location.search);
  const jobId = params.get("job");
  const embedded = params.get("embed") === "1" && window.top !== window;
  document.documentElement.classList.toggle("embed", embedded);
  document.body.classList.toggle("embed", embedded);
  const elements = {
    subtitle: document.getElementById("sp-archive-subtitle"),
    badge: document.getElementById("sp-archive-badge"),
    expected: document.getElementById("sp-archive-expected"),
    files: document.getElementById("sp-archive-files"),
    dropzone: document.getElementById("sp-archive-dropzone"),
    matches: document.getElementById("sp-archive-matches"),
    status: document.getElementById("sp-archive-status"),
    build: document.getElementById("sp-archive-build"),
    back: document.getElementById("sp-archive-back")
  };
  let job = null;
  let building = false;
  let selectedFiles = [];
  let explicitAssignments = {};
  let reconciliation = { matches: [], unusedFileIndexes: [] };

  function notifyParent(type, detail) {
    if (embedded) window.parent.postMessage({ source: "sp-chat-exporter-archive", type, detail: detail || null }, "https://chatgpt.com");
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else if (!response || !response.ok) reject(Object.assign(new Error(response?.error?.message || "Extension operation failed."), response?.error || {}));
        else resolve(response.result);
      });
    });
  }

  function setStatus(text, kind) {
    elements.status.textContent = text;
    elements.badge.textContent = kind || "Ready";
  }

  function renderExpected() {
    const protectedItems = job.attachments.filter((item) => item.requiresSelection);
    elements.expected.replaceChildren();
    if (!protectedItems.length) {
      const row = document.createElement("div");
      row.className = "file-row";
      row.textContent = "No protected files need manual selection.";
      elements.expected.append(row);
      return;
    }
    for (const item of protectedItems) {
      const row = document.createElement("div");
      row.className = "file-row";
      row.dataset.attachmentId = item.id;
      const info = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = item.originalFilename;
      const meta = document.createElement("small");
      meta.textContent = `${item.ownerRole === "user" ? "User" : "ChatGPT"} · turn ${item.turnNumber}`;
      info.append(strong, meta);
      const state = document.createElement("span");
      state.className = "state";
      state.textContent = "Selection needed";
      row.append(info, state);
      elements.expected.append(row);
    }
  }

  function renderMatches() {
    reconciliation = api.reconcileSelectedFiles(job.attachments, selectedFiles, explicitAssignments);
    elements.matches.replaceChildren();
    for (const match of reconciliation.matches) {
      const row = document.createElement("div");
      row.className = "file-row";
      const info = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = match.descriptor.originalFilename;
      info.append(strong);
      if (match.status === "ambiguous") {
        const select = document.createElement("select");
        select.setAttribute("aria-label", `Choose the file for ${match.descriptor.originalFilename}`);
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Confirm a matching file…";
        select.append(placeholder);
        for (const candidate of match.candidates) {
          const option = document.createElement("option");
          option.value = String(candidate.index);
          option.textContent = `${selectedFiles[candidate.index].name} (${selectedFiles[candidate.index].size} bytes)`;
          select.append(option);
        }
        select.addEventListener("change", () => {
          if (select.value !== "") explicitAssignments[match.descriptor.id] = Number(select.value);
          renderMatches();
        });
        info.append(select);
      }
      const state = document.createElement("span");
      state.className = `state ${match.status}`;
      state.textContent = match.status;
      row.append(info, state);
      elements.matches.append(row);
    }
    const ambiguous = reconciliation.matches.filter((item) => item.status === "ambiguous").length;
    const matched = reconciliation.matches.filter((item) => item.status === "matched").length;
    const protectedCount = reconciliation.matches.length;
    for (const row of elements.expected.querySelectorAll("[data-attachment-id]")) {
      const match = reconciliation.matches.find((item) => item.descriptor.id === row.dataset.attachmentId);
      const state = row.querySelector(".state");
      if (!match || !state) continue;
      state.textContent = match.status === "matched" ? "Matched" : match.status === "ambiguous" ? "Needs confirmation" : "Selection needed";
      state.className = `state ${match.status}`;
    }
    elements.build.disabled = ambiguous > 0;
    setStatus(ambiguous ? `${ambiguous} ambiguous match${ambiguous === 1 ? "" : "es"} need confirmation.` : `${matched} of ${protectedCount} protected files matched. Unmatched files will be reported missing.`, ambiguous ? "Needs review" : "Ready");
  }

  function permissionRequest(origins) {
    if (!origins.length) return Promise.resolve(true);
    return new Promise((resolve) => chrome.permissions.request({ origins }, resolve));
  }

  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  async function readSelectedFile(file) {
    api.validateSelectedFile(file);
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async function fetchOnce(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), api.LIMITS.mediaFetchTimeoutMs);
    try {
      const response = await fetch(url, { credentials: "include", signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const announced = Number(response.headers.get("content-length"));
      if (announced > api.LIMITS.maxMediaBytes) throw new api.ExportError(api.ERROR_CODES.MEDIA_LIMIT_EXCEEDED, "Media exceeds 50 MiB.", { bytes: announced });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > api.LIMITS.maxMediaBytes) throw new api.ExportError(api.ERROR_CODES.MEDIA_LIMIT_EXCEEDED, "Media exceeds 50 MiB.", { bytes: bytes.length });
      return { bytes, mimeType: response.headers.get("content-type") || "" };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchAccessible(descriptor) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { return await fetchOnce(descriptor.url); }
      catch (error) {
        lastError = error;
        if (error.code === api.ERROR_CODES.MEDIA_LIMIT_EXCEEDED || /HTTP 4\d\d/.test(error.message || "")) break;
      }
    }
    throw lastError || new Error("Media fetch failed.");
  }

  async function mapConcurrent(items, limit, worker) {
    const output = new Array(items.length);
    let next = 0;
    async function run() {
      while (next < items.length) {
        const index = next;
        next += 1;
        output[index] = await worker(items[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return output;
  }

  async function resolveAttachment(descriptor) {
    const match = reconciliation.matches.find((item) => item.descriptor.id === descriptor.id && item.status === "matched");
    let bytes;
    let mimeType = descriptor.mimeType;
    try {
      if (match) {
        const file = selectedFiles[match.fileIndex];
        bytes = await readSelectedFile(file);
        mimeType = file.type || mimeType;
      } else if (!descriptor.requiresSelection && descriptor.url) {
        const fetched = await fetchAccessible(descriptor);
        bytes = fetched.bytes;
        mimeType = fetched.mimeType || mimeType;
      } else {
        return Object.assign({}, descriptor, { archivePath: null, error: descriptor.reason || "The protected file was not selected." });
      }
      const result = Object.assign({}, descriptor, { size: bytes.length, mimeType, bytes, sha256: await sha256Hex(bytes), error: null });
      if (api.isTextAttachment(result) && bytes.length <= api.LIMITS.maxInlineTextBytes) result.inlineText = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      else if (api.isTextAttachment(result) && bytes.length > api.LIMITS.maxInlineTextBytes) result.inlineError = "Text was not inlined because it exceeds 10 MiB.";
      return result;
    } catch (error) {
      return Object.assign({}, descriptor, { archivePath: null, error: error.message || "The media file could not be read." });
    }
  }

  async function buildArchive() {
    if (building) return;
    building = true;
    elements.build.disabled = true;
    elements.back.disabled = true;
    notifyParent("ARCHIVE_BUSY", {busy:true});
    setStatus("Checking media permissions…", "Building");
    try {
      await runtimeMessage({ type: "UPDATE_ARCHIVE_JOB", jobId, update: { phase: "building" } });
      const origins = api.optionalOriginsFor(job.attachments.filter((item) => !item.requiresSelection));
      const granted = await permissionRequest(origins);
      if (!granted && origins.length) setStatus("Optional media access was denied. Those files will be marked missing.", "Building");
      const denied = granted ? new Set() : new Set(origins);
      const descriptors = job.attachments.map((item) => denied.has(item.originPattern) ? Object.assign({}, item, { requiresSelection: true, reason: "Optional media-host permission was denied." }) : item);
      const results = await mapConcurrent(descriptors, api.LIMITS.mediaConcurrency, resolveAttachment);
      const bytesTotal = results.reduce((sum, item) => sum + (item.bytes ? item.bytes.length : 0), 0);
      if (bytesTotal > api.LIMITS.maxArchiveInputBytes) throw new api.ExportError(api.ERROR_CODES.ARCHIVE_LIMIT_EXCEEDED, "Archive input exceeds 250 MiB.");
      const publicResults = results.map(({ bytes, ...item }) => item);
      const conversation = api.applyAttachmentResults(job.transcript, publicResults);
      const manifest = api.renderManifest(job, publicResults);
      const entries = [
        { path: "conversation.md", data: conversation },
        { path: "manifest.md", data: manifest },
        ...results.filter((item) => item.bytes && item.archivePath).map((item) => ({ path: item.archivePath, data: item.bytes }))
      ];
      const blob = api.createZipBlob(entries);
      const url = URL.createObjectURL(blob);
      const filename = api.artifactFilename(job.title, "zip", !job.snapshotComplete);
      try {
        await runtimeMessage({ type: "UPDATE_ARCHIVE_JOB", jobId, update: { phase: "downloading" } });
        const terminal = await runtimeMessage({ type: "DOWNLOAD_URL", url, filename });
        await runtimeMessage({ type: "UPDATE_ARCHIVE_JOB", jobId, update: { phase: "complete", result: {
          filename: terminal.filename,
          downloadId: terminal.downloadId,
          mediaComplete: publicResults.every((item) => !item.error),
          included: publicResults.filter((item) => !item.error).length,
          missing: publicResults.filter((item) => item.error).length
        } } });
        try { await runtimeMessage({ type: "DELETE_ARCHIVE_JOB", jobId }); } catch (_) {}
        setStatus(`Downloaded ${terminal.filename.split(/[\\/]/).pop()}.`, "Complete");
        elements.badge.className = "badge";
        notifyParent("ARCHIVE_COMPLETE", { filename: terminal.filename.split(/[\\/]/).pop() });
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      setStatus(error.message || "The ZIP could not be built.", "Failed");
      try { await runtimeMessage({ type: "UPDATE_ARCHIVE_JOB", jobId, update: { phase: "failed", result: { error: error.message } } }); } catch (_) {}
      elements.build.disabled = false;
    } finally {
      building = false;
      elements.back.disabled = false;
      notifyParent("ARCHIVE_BUSY", {busy:false});
    }
  }

  function setFiles(fileList) {
    selectedFiles = Array.from(fileList || []);
    explicitAssignments = {};
    renderMatches();
  }

  elements.files.addEventListener("change", () => setFiles(elements.files.files));
  elements.dropzone.addEventListener("dragover", (event) => { event.preventDefault(); elements.dropzone.classList.add("drag"); });
  elements.dropzone.addEventListener("dragleave", () => elements.dropzone.classList.remove("drag"));
  elements.dropzone.addEventListener("drop", (event) => { event.preventDefault(); elements.dropzone.classList.remove("drag"); setFiles(event.dataTransfer.files); });
  elements.build.addEventListener("click", buildArchive);
  elements.back.addEventListener("click", () => notifyParent("ARCHIVE_BACK"));

  (async () => {
    try {
      if (!embedded) throw new api.ExportError(api.ERROR_CODES.INVALID_INPUT, "Open the media bundle from the floating exporter panel on ChatGPT.");
      if (!jobId) throw new api.ExportError(api.ERROR_CODES.JOB_NOT_FOUND, "No export job was specified.");
      job = await runtimeMessage({ type: "GET_ARCHIVE_JOB", jobId });
      elements.subtitle.textContent = job.title;
      renderExpected();
      renderMatches();
      const protectedItems = job.attachments.filter((item) => item.requiresSelection);
      if (!protectedItems.length) {
        const origins = api.optionalOriginsFor(job.attachments);
        const granted = !origins.length || await new Promise((resolve) => chrome.permissions.contains({origins}, resolve));
        if (granted) await buildArchive();
        else {
          elements.build.textContent = "Allow media and download";
          setStatus("Media-host permission is required before downloading.", "Permission needed");
          notifyParent("ARCHIVE_BUSY", {busy:false});
        }
      } else notifyParent("ARCHIVE_BUSY", {busy:false});
    } catch (error) {
      setStatus(error.message || "The export job could not be loaded.", "Failed");
      elements.build.disabled = true;
      notifyParent("ARCHIVE_BUSY", {busy:false});
    }
  })();
})();
