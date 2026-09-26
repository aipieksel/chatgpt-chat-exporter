(function initializeFilename(global) {
  "use strict";

  const api = global.ChatGPTExporter = global.ChatGPTExporter || {};
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  function sanitizeFilenamePart(value, fallback) {
    let name = String(value || "").normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim();
    if (!name || name === "." || name === "..") name = fallback || "chatgpt-conversation";
    if (RESERVED.test(name)) name = `_${name}`;
    const points = Array.from(name);
    if (points.length > 120) name = points.slice(0, 120).join("").replace(/[. ]+$/g, "");
    return name || fallback || "chatgpt-conversation";
  }

  function splitExtension(name) {
    const safe = sanitizeFilenamePart(name, "attachment");
    const index = safe.lastIndexOf(".");
    if (index <= 0 || index === safe.length - 1) return { stem: safe, extension: "" };
    return { stem: safe.slice(0, index), extension: safe.slice(index) };
  }

  function uniqueFilename(name, used) {
    const names = used || new Set();
    const { stem, extension } = splitExtension(name);
    let candidate = `${stem}${extension}`;
    let number = 2;
    while (names.has(candidate.toLocaleLowerCase("en-US"))) {
      candidate = `${stem}-${number}${extension}`;
      number += 1;
    }
    names.add(candidate.toLocaleLowerCase("en-US"));
    return candidate;
  }

  function artifactFilename(title, extension, partial) {
    const suffix = partial ? "-partial" : "";
    return `${sanitizeFilenamePart(title, "chatgpt-conversation")}${suffix}.${extension}`;
  }

  function safeArchivePath(role, name, usedPaths) {
    const folder = role === "user" ? "user" : "chatgpt";
    const safe = uniqueFilename(name || "attachment", usedPaths || new Set());
    const path = `media/${folder}/${safe}`;
    if (path.includes("..") || path.startsWith("/") || path.includes("\\")) {
      throw new api.ExportError(api.ERROR_CODES.UNSAFE_PATH, "Unsafe archive path.");
    }
    return path;
  }

  api.artifactFilename = artifactFilename;
  api.safeArchivePath = safeArchivePath;
  api.sanitizeFilenamePart = sanitizeFilenamePart;
  api.splitExtension = splitExtension;
  api.uniqueFilename = uniqueFilename;
})(globalThis);
