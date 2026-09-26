(function initializeContentEntry(global) {
  "use strict";

  const api = global.ChatGPTExporter;
  if (!api || global.__spChatExporterListenerInstalled) return;
  global.__spChatExporterListenerInstalled = true;

  const colorScheme = global.matchMedia("(prefers-color-scheme: dark)");
  function syncActionIcon() {
    chrome.runtime.sendMessage({ type: "SET_ACTION_ICON_THEME", theme: colorScheme.matches ? "dark" : "light" }, () => void chrome.runtime.lastError);
  }
  syncActionIcon();
  colorScheme.addEventListener("change", syncActionIcon);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;
    if (message.type === "CANCEL_COLLECTION") {
      api.cancelCollection();
      sendResponse({ ok: true });
      return false;
    }
    if (message.type !== "COLLECT_CONVERSATION") return false;
    api.collectConversation(message.options || {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: api.serializeError(error) }));
    return true;
  });
})(globalThis);
