(function initializeExporterSidebar(global) {
  "use strict";

  const api = global.ChatGPTExporter;
  const PANEL_ID = "sp-chat-exporter-sidebar";
  if (!api) return;
  const runtimeVersion = chrome.runtime.getManifest().version;
  const existing = document.getElementById(PANEL_ID);
  if (existing && existing.dataset.extensionVersion === runtimeVersion && global.__spChatExporterSidebarInstalled) return;
  if (existing) existing.remove();
  global.__spChatExporterSidebarInstalled = true;

  let activeJobId = null;
  let pendingPartial = null;
  let retainedResult = null;
  let shownProgress = 0;

  function applyStyles(element, declarations) {
    element.style.cssText = declarations.join(";");
    return element;
  }

  const shell = global.AipiekselPanel.create({
    id: PANEL_ID, prefix: "sp-chat-exporter", name: "ChatGPT Chat Exporter",
    label: "ChatGPT Chat Exporter – Complete Markdown & File Bundle", version: runtimeVersion
  });
  const {panel, header, body, button, setHidden} = shell;

  const mainView = applyStyles(document.createElement("div"), [
    "display:flex", "flex-direction:column", "min-height:0", "position:relative"
  ]);
  mainView.id = "sp-chat-exporter-main-view";

  const archiveView = applyStyles(document.createElement("div"), [
    "display:none", "height:min(620px,calc(100vh - 58px))", "min-height:360px", "background:#0d0d0d"
  ]);
  archiveView.id = "sp-chat-exporter-archive-view";
  const archiveFrame = document.createElement("iframe");
  archiveFrame.id = "sp-chat-exporter-archive-frame";
  archiveFrame.title = "Add files to your export";
  archiveFrame.style.cssText = "display:block;width:100%;height:100%;border:0;background:#0d0d0d;";
  archiveView.appendChild(archiveFrame);

  const toolbar = applyStyles(document.createElement("div"), [
    "display:flex", "align-items:center", "gap:3px", "padding:8px",
    "border-bottom:1px solid #1a1a1a", "flex-wrap:nowrap", "overflow:hidden"
  ]);
  toolbar.id = "sp-chat-exporter-toolbar";
  const exportButton = button("sp-chat-exporter-export", "Export Markdown", true);
  const partialButton = button("sp-chat-exporter-partial", "Download partial", false);
  partialButton.hidden = true;
  const cancelButton = button("sp-chat-exporter-cancel", "Cancel", false);
  cancelButton.hidden = true;
  const closeButton = button("sp-chat-exporter-close", "Close", false);
  toolbar.append(exportButton, partialButton, cancelButton, closeButton);

  const sectionTitle = document.createElement("div");
  sectionTitle.id = "sp-chat-exporter-section-title";
  sectionTitle.textContent = "CURRENT CONVERSATION";
  sectionTitle.style.cssText = "font-size:10px;font-weight:600;letter-spacing:.08em;color:#888;padding:8px 10px 6px;border-bottom:1px solid #181818;";
  const hint = document.createElement("div");
  hint.id = "sp-chat-exporter-hint";
  hint.textContent = "Loads the complete chat, expands long messages, and verifies the beginning before download.";
  hint.style.cssText = "font-size:10px;color:#6f6f6f;padding:8px 10px;border-bottom:1px solid #151515;line-height:1.45;background:#101010;";

  const options = applyStyles(document.createElement("div"), [
    "overflow-y:auto", "overflow-x:hidden", "flex:0 1 auto", "min-height:0", "padding:8px", "background:#0b0b0b"
  ]);
  options.id = "sp-chat-exporter-options";

  function optionRow(id, label, description, checked) {
    const row = applyStyles(document.createElement("label"), [
      "display:flex", "align-items:center", "justify-content:space-between", "gap:12px",
      "padding:10px", "border:1px solid #242424", "background:#111", "border-radius:8px",
      "margin-bottom:7px", "cursor:pointer", "box-sizing:border-box"
    ]);
    row.id = `${id}-row`;
    const copy = document.createElement("span");
    copy.style.cssText = "display:flex;flex-direction:column;gap:3px;min-width:0;";
    const name = document.createElement("span");
    name.textContent = label;
    name.style.cssText = "font-size:12px;font-weight:600;color:#eee;line-height:1.2;";
    const detail = document.createElement("span");
    detail.textContent = description;
    detail.style.cssText = "font-size:10px;color:#888;line-height:1.4;";
    const input = document.createElement("input");
    input.id = id;
    input.type = "checkbox";
    input.checked = checked;
    input.style.cssText = "width:16px;height:16px;accent-color:#fff;flex:0 0 auto;";
    copy.append(name, detail);
    row.append(copy, input);
    options.appendChild(row);
    return input;
  }

  const timestamps = optionRow("sp-chat-exporter-timestamps", "Truthful timestamps", "Include only timestamps that ChatGPT exposes unambiguously.", true);
  const media = optionRow("sp-chat-exporter-media", "Include media", "Create one organized ZIP; protected files may need selection.", false);

  const privacy = document.createElement("div");
  privacy.id = "sp-chat-exporter-privacy";
  privacy.textContent = "Local-only processing · No account API · No telemetry";
  privacy.style.cssText = "font-size:10px;color:#666;line-height:1.45;padding:8px 2px;text-align:center;";
  options.appendChild(privacy);

  const status = document.createElement("div");
  status.id = "sp-chat-exporter-status";
  status.setAttribute("role", "status");
  status.textContent = "Ready on a rendered ChatGPT conversation.";
  status.style.cssText = "font-size:10px;color:#777;padding:6px 10px;border-top:1px solid #1a1a1a;min-height:20px;line-height:1.4;box-sizing:border-box;";

  const progressOverlay = applyStyles(document.createElement("div"), [
    "display:none", "position:absolute", "inset:0", "z-index:20", "align-items:center", "justify-content:center",
    "background:rgba(5,5,5,.76)", "backdrop-filter:blur(3px)", "pointer-events:auto"
  ]);
  progressOverlay.id = "sp-chat-exporter-progress-overlay";
  const progressCard = applyStyles(document.createElement("div"), [
    "width:min(250px,calc(100% - 44px))", "padding:22px 20px", "border:1px solid #303030",
    "border-radius:16px", "background:rgba(18,18,18,.96)", "box-shadow:0 18px 48px rgba(0,0,0,.42)",
    "display:flex", "flex-direction:column", "align-items:center", "gap:10px", "text-align:center", "box-sizing:border-box"
  ]);
  const progressPercent = document.createElement("div");
  progressPercent.id = "sp-chat-exporter-progress-percent";
  progressPercent.textContent = "";
  progressPercent.style.cssText = "font-size:28px;font-weight:600;color:#fff;line-height:1;letter-spacing:0;";
  const progressLabel = document.createElement("div");
  progressLabel.id = "sp-chat-exporter-progress-label";
  progressLabel.textContent = "Inspecting the conversation…";
  progressLabel.style.cssText = "font-size:12px;color:#b8b8b8;line-height:1.35;min-height:18px;";
  const progressTrack = applyStyles(document.createElement("div"), ["width:100%", "height:6px", "border-radius:999px", "background:#2a2a2a", "overflow:hidden"]);
  const progressBar = document.createElement("div");
  progressBar.id = "sp-chat-exporter-progress-bar";
  progressBar.style.cssText = "width:0;height:100%;border-radius:999px;background:#60a5fa;transition:width .18s ease;";
  progressTrack.appendChild(progressBar);
  const progressCancelButton = button("sp-chat-exporter-progress-cancel", "Cancel export", false);
  progressCancelButton.style.marginTop = "2px";
  progressCard.append(progressPercent, progressLabel, progressTrack, progressCancelButton);
  progressOverlay.appendChild(progressCard);

  mainView.append(toolbar, sectionTitle, hint, options, status, progressOverlay);
  body.append(mainView, archiveView);

  function showMainView(message) {
    archiveView.style.display = "none";
    mainView.style.display = "flex";
    archiveFrame.removeAttribute("src");
    shell.setLocked(false);
    if (message) setStatus(message);
  }

  function showArchiveView(job) {
    mainView.style.display = "none";
    archiveView.style.display = "block";
    archiveFrame.src = chrome.runtime.getURL(`media.html?embed=1&job=${encodeURIComponent(job.id)}`);
    shell.setLocked(true);
  }

  function setBusy(value) {
    shell.setLocked(value || archiveView.style.display === "block");
    closeButton.disabled = value;
    exportButton.disabled = value;
    timestamps.disabled = value;
    media.disabled = value;
    cancelButton.hidden = !value;
    progressOverlay.style.display = value ? "flex" : "none";
  }

  function setStatus(message, error) {
    status.textContent = message;
    status.style.color = error ? "#fca5a5" : "#777";
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

  async function exportCollected(result, partial) {
    const snapshot = result.snapshot;
    if (media.checked) {
      const job = await runtimeMessage({
        type: "CREATE_ARCHIVE_JOB", title: snapshot.title, sourceUrl: snapshot.sourceUrl,
        markdown: result.markdown, snapshotComplete: snapshot.complete, attachments: snapshot.attachments,
        options: Object.assign({}, result.options, { allowPartial: Boolean(partial) })
      });
      showArchiveView(job);
      return;
    }
    const filename = api.artifactFilename(snapshot.title, "md", partial);
    const terminal = await runtimeMessage({ type: "DOWNLOAD_MARKDOWN", markdown: result.markdown, filename });
    setStatus(`Downloaded ${(terminal.filename || filename).split(/[\\/]/).pop()}.`);
  }

  async function startExport() {
    if (exportButton.disabled) return;
    if (retainedResult) {
      setBusy(true);
      try { await exportCollected(retainedResult, !retainedResult.snapshot.complete); }
      catch (error) { setStatus(error.message || "Download failed. Try Download again.", true); }
      finally { setBusy(false); }
      return;
    }
    pendingPartial = null;
    partialButton.hidden = true;
    activeJobId = api.createJobId();
    shownProgress = 0;
    progressPercent.textContent = "";
    progressTrack.hidden = true;
    setBusy(true);
    setStatus("Inspecting the rendered conversation…");
    try {
      const result = await api.collectConversation({
        includeMedia: media.checked, includeTimestamps: timestamps.checked, allowPartial: false, jobId: activeJobId
      });
      retainedResult = result;
      exportButton.textContent = "Download";
      if (!result.snapshot.complete) {
        pendingPartial = result;
        partialButton.hidden = true;
        setStatus(`Complete transcript not proven: ${result.snapshot.completion.reason}`, true);
        return;
      }
      await exportCollected(result, false);
    } catch (error) {
      setStatus(error.message || "The export failed.", true);
    } finally {
      setBusy(false);
    }
  }

  exportButton.addEventListener("click", startExport);
  partialButton.addEventListener("click", async () => {
    if (!pendingPartial) return;
    setBusy(true);
    try { await exportCollected(pendingPartial, true); }
    catch (error) { setStatus(error.message || "The partial export failed.", true); }
    finally { setBusy(false); }
  });
  function requestCancellation() {
    api.cancelCollection();
    setStatus("Cancelling…");
  }

  cancelButton.addEventListener("click", requestCancellation);
  progressCancelButton.addEventListener("click", requestCancellation);
  closeButton.addEventListener("click", () => setHidden(true));

  global.addEventListener("message", (event) => {
    if (event.source !== archiveFrame.contentWindow || event.origin !== chrome.runtime.getURL("").slice(0, -1)) return;
    if (!event.data || event.data.source !== "sp-chat-exporter-archive") return;
    if (event.data.type === "ARCHIVE_BUSY") shell.setLocked(event.data.detail?.busy === true);
    if (event.data.type === "ARCHIVE_BACK") showMainView("Media bundle closed. Your transcript remains unchanged.");
    if (event.data.type === "ARCHIVE_COMPLETE") showMainView(`Downloaded ${event.data.detail?.filename || "media bundle"}.`);
  });

  document.addEventListener("sp-chat-exporter-progress", (event) => {
    const detail = event.detail || {};
    if (detail.jobId !== activeJobId) return;
    const determinate = typeof detail.percent === "number" && Number.isFinite(detail.percent);
    if (determinate) shownProgress = Math.max(shownProgress, Math.min(100, Math.max(0, detail.percent)));
    progressPercent.textContent = determinate ? `${Math.round(shownProgress)}%` : "";
    progressTrack.hidden = !determinate;
    progressLabel.textContent = `${detail.phase || "Working…"}${Number.isFinite(detail.turns) ? ` · ${detail.turns} turns` : ""}`;
    progressBar.style.width = `${shownProgress}%`;
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !["TOGGLE_EXPORTER_PANEL", "SHOW_EXPORTER_PANEL"].includes(message.type)) return false;
    if (!panel.isConnected) return false;
    setHidden(message.type === "SHOW_EXPORTER_PANEL" ? false : !shell.hidden);
    sendResponse({ ok: true, hidden: shell.hidden });
    return false;
  });

})(globalThis);
