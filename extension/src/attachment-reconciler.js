(function initializeAttachmentReconciler(global) {
  "use strict";

  const api = global.ChatGPTExporter = global.ChatGPTExporter || {};

  function normalizedName(value) {
    return api.sanitizeFilenamePart(value, "attachment").normalize("NFKC").toLocaleLowerCase("en-US");
  }

  function candidateScore(descriptor, file) {
    if (normalizedName(descriptor.originalFilename) !== normalizedName(file.name)) return -1;
    let score = 10;
    if (descriptor.size && descriptor.size === file.size) score += 4;
    if (descriptor.mimeType && file.type && descriptor.mimeType === file.type) score += 2;
    return score;
  }

  function reconcileSelectedFiles(descriptors, files, explicitAssignments) {
    const selected = Array.from(files || []);
    const assignments = explicitAssignments || {};
    const claimed = new Set();
    const matches = [];
    for (const descriptor of descriptors || []) {
      if (!descriptor.requiresSelection) continue;
      const explicit = assignments[descriptor.id];
      if (Number.isInteger(explicit) && selected[explicit] && !claimed.has(explicit)) {
        claimed.add(explicit);
        matches.push({ descriptor, status: "matched", fileIndex: explicit, score: candidateScore(descriptor, selected[explicit]), explicit: true });
        continue;
      }
      const candidates = selected.map((file, index) => ({ index, score: candidateScore(descriptor, file) })).filter((item) => item.score >= 0 && !claimed.has(item.index)).sort((a, b) => b.score - a.score || a.index - b.index);
      if (candidates.length === 1 || (candidates.length > 1 && candidates[0].score > candidates[1].score)) {
        claimed.add(candidates[0].index);
        matches.push({ descriptor, status: "matched", fileIndex: candidates[0].index, score: candidates[0].score, explicit: false });
      } else if (candidates.length > 1) {
        matches.push({ descriptor, status: "ambiguous", candidates });
      } else {
        matches.push({ descriptor, status: "missing", candidates: [] });
      }
    }
    return { matches, unusedFileIndexes: selected.map((_, index) => index).filter((index) => !claimed.has(index)) };
  }

  function validateSelectedFile(file) {
    if (!file || typeof file.name !== "string" || !Number.isFinite(file.size)) {
      throw new api.ExportError(api.ERROR_CODES.INVALID_INPUT, "The selected file is invalid.");
    }
    if (file.size > api.LIMITS.maxMediaBytes) {
      throw new api.ExportError(api.ERROR_CODES.MEDIA_LIMIT_EXCEEDED, `${file.name} exceeds the 50 MiB media limit.`, { bytes: file.size });
    }
    return file;
  }

  api.candidateScore = candidateScore;
  api.reconcileSelectedFiles = reconcileSelectedFiles;
  api.validateSelectedFile = validateSelectedFile;
})(globalThis);
