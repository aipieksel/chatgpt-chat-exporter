(function initializeMarkdown(global) {
  "use strict";

  const api = global.ChatGPTExporter = global.ChatGPTExporter || {};
  const BLOCK_TAGS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "DIV", "FIGCAPTION", "FIGURE", "FOOTER", "HEADER", "MAIN", "NAV", "P", "SECTION"]);
  const EXCLUDED_TAGS = new Set(["BUTTON", "CANVAS", "FORM", "INPUT", "NOSCRIPT", "SCRIPT", "STYLE", "SVG", "TEMPLATE", "TEXTAREA"]);

  function normalizeMarkdownDocument(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\s+|\s+$/g, "");
  }

  function escapeInlineText(value) {
    return String(value || "")
      .replace(/\\/g, "\\\\")
      .replace(/([*_`[\]<>])/g, "\\$1");
  }

  function safeLink(raw) {
    if (!raw) return "";
    const value = String(raw).trim();
    if (/^(javascript|vbscript|data):/i.test(value)) return "";
    if (/^(https?:|mailto:|#|\/)/i.test(value)) return value.replace(/[()\s]/g, (char) => encodeURIComponent(char));
    return "";
  }

  function longestBacktickRun(value) {
    const runs = String(value || "").match(/`+/g) || [];
    return runs.reduce((max, run) => Math.max(max, run.length), 0);
  }

  function fencedCode(value, language) {
    const body = String(value || "").replace(/^\n+|\n+$/g, "");
    const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
    const safeLanguage = String(language || "").match(/^[a-z0-9_+.#-]{1,30}$/i)?.[0] || "";
    return `\n\n${fence}${safeLanguage}\n${body}\n${fence}\n\n`;
  }

  function shouldExcludeElement(element) {
    if (!element || EXCLUDED_TAGS.has(element.tagName)) return true;
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return true;
    if (element.closest && element.closest("[data-message-author-role] [data-testid*='copy'], [data-message-author-role] [data-testid*='feedback']")) return true;
    const label = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("data-testid") || ""}`;
    return /(?:copy|regenerate|feedback|good response|bad response|read aloud|share)/i.test(label);
  }

  function directListItems(list) {
    return Array.from(list.children || []).filter((child) => child.tagName === "LI");
  }

  function markdownListToText(list, depth) {
    const ordered = list.tagName === "OL";
    const start = Number.parseInt(list.getAttribute("start") || "1", 10) || 1;
    return directListItems(list).map((item, index) => {
      const parts = [];
      const nested = [];
      for (const child of Array.from(item.childNodes || [])) {
        if (child.nodeType === 1 && (child.tagName === "UL" || child.tagName === "OL")) nested.push(child);
        else parts.push(markdownNodeToText(child, { depth: depth + 1, inline: true }));
      }
      const marker = ordered ? `${start + index}.` : "-";
      const indent = "  ".repeat(depth);
      let line = `${indent}${marker} ${normalizeMarkdownDocument(parts.join(""))}`;
      for (const child of nested) line += `\n${markdownListToText(child, depth + 1)}`;
      return line;
    }).join("\n");
  }

  function cellText(cell) {
    return normalizeMarkdownDocument(markdownChildrenToText(cell, { inline: true })).replace(/\|/g, "\\|").replace(/\n/g, " ");
  }

  function markdownTableToText(table) {
    const rows = Array.from(table.querySelectorAll("tr")).map((row) => Array.from(row.children).filter((cell) => /^(TH|TD)$/.test(cell.tagName)).map(cellText)).filter((row) => row.length);
    if (!rows.length) return "";
    const columns = Math.max(...rows.map((row) => row.length));
    const normalized = rows.map((row) => Array.from({ length: columns }, (_, index) => row[index] || ""));
    const header = normalized[0];
    const body = normalized.slice(1);
    return [
      `| ${header.join(" | ")} |`,
      `| ${header.map(() => "---").join(" | ")} |`,
      ...body.map((row) => `| ${row.join(" | ")} |`)
    ].join("\n");
  }

  function markdownChildrenToText(node, context) {
    return Array.from(node.childNodes || []).map((child) => markdownNodeToText(child, context)).join("");
  }

  function markdownNodeToText(node, context) {
    const ctx = Object.assign({ depth: 0, inline: false }, context || {});
    if (!node) return "";
    if (node.nodeType === 3) return escapeInlineText(node.nodeValue || "");
    if (node.nodeType !== 1 || shouldExcludeElement(node)) return "";
    const tag = node.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      return `\n\n${"#".repeat(level)} ${normalizeMarkdownDocument(markdownChildrenToText(node, { inline: true }))}\n\n`;
    }
    if (tag === "BR") return "\n";
    if (tag === "HR") return "\n\n---\n\n";
    if (tag === "A") {
      const label = normalizeMarkdownDocument(markdownChildrenToText(node, { inline: true })) || node.getAttribute("aria-label") || "Link";
      const href = safeLink(node.getAttribute("href"));
      return href ? `[${label}](${href})` : label;
    }
    if (tag === "STRONG" || tag === "B") return `**${normalizeMarkdownDocument(markdownChildrenToText(node, { inline: true }))}**`;
    if (tag === "EM" || tag === "I") return `*${normalizeMarkdownDocument(markdownChildrenToText(node, { inline: true }))}*`;
    if (tag === "S" || tag === "DEL") return `~~${normalizeMarkdownDocument(markdownChildrenToText(node, { inline: true }))}~~`;
    if (tag === "CODE" && node.parentElement && node.parentElement.tagName === "PRE") return node.textContent || "";
    if (tag === "CODE") {
      const body = node.textContent || "";
      const fence = "`".repeat(Math.max(1, longestBacktickRun(body) + 1));
      return `${fence}${body}${fence}`;
    }
    if (tag === "PRE") {
      const code = node.querySelector("code");
      const className = (code && code.className) || node.className || "";
      const language = className.match(/(?:language-|lang-)([a-z0-9_+.#-]+)/i)?.[1] || "";
      return fencedCode((code || node).textContent || "", language);
    }
    if (tag === "UL" || tag === "OL") return `\n\n${markdownListToText(node, ctx.depth)}\n\n`;
    if (tag === "BLOCKQUOTE") {
      const value = normalizeMarkdownDocument(markdownChildrenToText(node, ctx));
      return `\n\n${value.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    }
    if (tag === "TABLE") return `\n\n${markdownTableToText(node)}\n\n`;
    if (tag === "IMG") {
      const alt = escapeInlineText(node.getAttribute("alt") || "Image");
      const src = safeLink(node.getAttribute("src"));
      return src ? `![${alt}](${src})` : "";
    }
    const children = markdownChildrenToText(node, ctx);
    if (BLOCK_TAGS.has(tag) && !ctx.inline) return `\n\n${children}\n\n`;
    return children;
  }

  function turnHeading(role) {
    if (role === "user") return "User";
    if (role === "assistant") return "ChatGPT";
    if (role === "tool") return "Tool";
    return "Unknown author";
  }

  function renderAttachmentRecord(attachment) {
    const start = `<!--sp-attachment-start:${attachment.id}-->`;
    const end = `<!--sp-attachment-end:${attachment.id}-->`;
    const label = escapeInlineText(attachment.originalFilename || "Attachment");
    const details = [attachment.mimeType, attachment.size ? `${attachment.size} bytes` : ""].filter(Boolean).join(", ");
    const source = attachment.url && attachment.sourceCategory !== "protected" ? safeLink(attachment.url) : "";
    const renderedLabel = source ? `[${label}](${source})` : label;
    return `\n\n${start}\n**Attachment:** ${renderedLabel}${details ? ` (${details})` : ""}\n${end}`;
  }

  function renderConversationMarkdown(snapshot, options) {
    api.validateSnapshot(snapshot);
    const opts = options || {};
    const lines = [
      `# ${escapeInlineText(snapshot.title || "ChatGPT conversation")}`,
      "",
      `- Source: ${snapshot.sourceUrl}`,
      `- Exported: ${snapshot.exportedAt}`,
      `- Turns: ${snapshot.turns.length}`,
      `- Completeness: ${snapshot.complete ? "Complete" : "Incomplete"}`
    ];
    if (!snapshot.complete && snapshot.completion && snapshot.completion.reason) lines.push(`- Incomplete reason: ${snapshot.completion.reason}`);
    for (const turn of snapshot.turns) {
      const timestamp = opts.includeTimestamps && turn.timestamp?.value && !Number.isNaN(Date.parse(turn.timestamp.value))
        ? ` - ${new Date(turn.timestamp.value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}`
        : opts.includeTimestamps && turn.timestamp?.source === 'adjacent-date-separator' && turn.timestamp.label
          ? ` - ${escapeInlineText(turn.timestamp.label)}` : '';
      lines.push("", `## ${turnHeading(turn.role)} - Turn ${turn.turnNumber}${timestamp}`);
      if (turn.markdown) lines.push("", normalizeMarkdownDocument(turn.markdown));
      for (const attachment of turn.attachments || []) lines.push(renderAttachmentRecord(attachment));
    }
    if (snapshot.warnings && snapshot.warnings.length) {
      lines.push("", "## Export warnings", "");
      for (const warning of snapshot.warnings) lines.push(`- ${escapeInlineText(warning)}`);
    }
    const markdown = normalizeMarkdownDocument(lines.join("\n")) + "\n";
    api.ensureTranscriptSize(markdown);
    return markdown;
  }

  function applyAttachmentResults(markdown, results) {
    let output = String(markdown || "");
    for (const result of results || []) {
      const id = String(result.id || "");
      const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const marker = new RegExp(`<!--sp-attachment-start:${escapedId}-->[\\s\\S]*?<!--sp-attachment-end:${escapedId}-->`, "g");
      const label = escapeInlineText(result.originalFilename || "Attachment");
      const source = result.url && result.sourceCategory !== "protected" ? safeLink(result.url) : "";
      const target = result.archivePath ? encodeURI(result.archivePath) : source;
      const blocks = [`**Attachment:** ${target ? `[${label}](${target})` : label}`];
      if (result.inlineText !== undefined) {
        const language = api.extensionOf ? api.extensionOf(result.originalFilename) : "text";
        blocks.push(fencedCode(result.inlineText, language));
      }
      if (result.inlineError) blocks.push(`> ${escapeInlineText(result.inlineError)}`);
      if (result.error) blocks.push(`> Media unavailable: ${escapeInlineText(result.error)}`);
      output = output.replace(marker, normalizeMarkdownDocument(blocks.join("\n\n")));
    }
    return normalizeMarkdownDocument(output) + "\n";
  }

  function renderManifest(job, results) {
    const included = (results || []).filter((item) => item.archivePath && !item.error);
    const missing = (results || []).filter((item) => item.error);
    const lines = [
      "# Media manifest",
      "",
      `- Conversation: ${escapeInlineText(job.title)}`,
      `- Exported: ${new Date().toISOString()}`,
      `- Transcript complete: ${job.snapshotComplete ? "Yes" : "No"}`,
      `- Media complete: ${missing.length === 0 ? "Yes" : "No"}`,
      `- Included files: ${included.length}`,
      `- Missing files: ${missing.length}`,
      "",
      "## Files",
      ""
    ];
    for (const item of results || []) {
      lines.push(`### ${escapeInlineText(item.originalFilename || "Attachment")}`, "");
      lines.push(`- Owner: ${item.ownerRole === "user" ? "User" : "ChatGPT"}`);
      lines.push(`- Turn: ${item.turnNumber}`);
      if (item.archivePath) lines.push(`- Archive path: ${item.archivePath}`);
      if (Number.isFinite(item.size)) lines.push(`- Bytes: ${item.size}`);
      lines.push(`- Status: ${item.error ? `Missing — ${escapeInlineText(item.error)}` : "Included"}`, "");
    }
    return normalizeMarkdownDocument(lines.join("\n")) + "\n";
  }

  api.applyAttachmentResults = applyAttachmentResults;
  api.escapeInlineText = escapeInlineText;
  api.fencedCode = fencedCode;
  api.markdownChildrenToText = markdownChildrenToText;
  api.markdownListToText = markdownListToText;
  api.markdownNodeToText = markdownNodeToText;
  api.markdownTableToText = markdownTableToText;
  api.normalizeMarkdownDocument = normalizeMarkdownDocument;
  api.renderConversationMarkdown = renderConversationMarkdown;
  api.renderManifest = renderManifest;
})(globalThis);
