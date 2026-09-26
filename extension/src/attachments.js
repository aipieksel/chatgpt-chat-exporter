(function initializeAttachments(global) {
  "use strict";

  const api = global.ChatGPTExporter = global.ChatGPTExporter || {};
  const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "json", "xml", "yaml", "yml", "html", "css", "js", "ts", "py", "log", "rtf"]);
  const OPTIONAL_ORIGIN_PATTERNS = Object.freeze({
    "oaiusercontent.com": "https://*.oaiusercontent.com/*",
    "oaistatic.com": "https://*.oaistatic.com/*",
    "openai.com": "https://*.openai.com/*"
  });

  function extensionOf(name) {
    const match = String(name || "").toLowerCase().match(/\.([a-z0-9]{1,12})$/);
    return match ? match[1] : "";
  }

  function isTextAttachment(descriptor) {
    return Boolean(descriptor && (
      /^text\//i.test(descriptor.mimeType || "") ||
      /\b(json|xml|yaml|javascript)\b/i.test(descriptor.mimeType || "") ||
      TEXT_EXTENSIONS.has(extensionOf(descriptor.originalFilename))
    ));
  }

  function classifyAttachmentUrl(rawUrl) {
    if (!rawUrl) return { kind: "protected", url: null, reason: "No downloadable URL is exposed in the rendered page." };
    if (/^(blob:|data:)/i.test(rawUrl)) return { kind: "page-local", url: rawUrl, reason: null };
    let url;
    try { url = new URL(rawUrl, global.location && global.location.href); } catch (_) {
      return { kind: "invalid", url: null, reason: "The rendered attachment URL is invalid." };
    }
    if (url.protocol !== "https:") return { kind: "invalid", url: null, reason: "Only secure media URLs are supported." };
    if (/\/backend-api\/.*(?:interpreter\/download|download)/i.test(url.pathname)) {
      return { kind: "protected", url: url.href, reason: "ChatGPT authentication is required." };
    }
    const hostname = url.hostname.toLowerCase();
    if (hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com")) {
      return { kind: "chatgpt", url: url.href, reason: null };
    }
    for (const domain of Object.keys(OPTIONAL_ORIGIN_PATTERNS)) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        return { kind: "optional-origin", url: url.href, originPattern: OPTIONAL_ORIGIN_PATTERNS[domain], reason: null };
      }
    }
    return { kind: "unsupported-origin", url: url.href, reason: `The media host ${hostname} is not allowlisted.` };
  }

  function assignArchivePaths(attachments) {
    const usedByFolder = { user: new Set(), chatgpt: new Set() };
    return attachments.map((attachment) => {
      const folder = attachment.ownerRole === "user" ? "user" : "chatgpt";
      return Object.assign({}, attachment, {
        archivePath: api.safeArchivePath(folder, attachment.originalFilename, usedByFolder[folder])
      });
    });
  }

  function optionalOriginsFor(attachments) {
    return Array.from(new Set((attachments || []).map((item) => item.originPattern).filter(Boolean)));
  }

  api.assignArchivePaths = assignArchivePaths;
  api.classifyAttachmentUrl = classifyAttachmentUrl;
  api.extensionOf = extensionOf;
  api.isTextAttachment = isTextAttachment;
  api.optionalOriginsFor = optionalOriginsFor;
})(globalThis);
