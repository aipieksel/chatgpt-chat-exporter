(function initializeContracts(global) {
  "use strict";

  const MiB = 1024 * 1024;
  const LIMITS = Object.freeze({
    maxTurns: 5000,
    maxLoadCycles: 300,
    maxLoadMs: 8 * 60 * 1000,
    stableBeginningChecks: 3,
    settleMs: 650,
    historySettleMs: 2200,
    maxIdleCycles: 12,
    maxTranscriptBytes: 25 * MiB,
    maxInlineTextBytes: 10 * MiB,
    maxMediaBytes: 50 * MiB,
    maxMediaEntries: 500,
    maxArchiveInputBytes: 250 * MiB,
    mediaFetchTimeoutMs: 30 * 1000,
    downloadWaitMs: 2 * 60 * 1000,
    mediaConcurrency: 3,
    jobExpiryMs: 24 * 60 * 60 * 1000
  });

  const ERROR_CODES = Object.freeze({
    ACTIVE_GENERATION: "ACTIVE_GENERATION",
    AMBIGUOUS_SCROLL_ROOT: "AMBIGUOUS_SCROLL_ROOT",
    ARCHIVE_LIMIT_EXCEEDED: "ARCHIVE_LIMIT_EXCEEDED",
    BEGINNING_NOT_FOUND: "BEGINNING_NOT_FOUND",
    CANCELLED: "CANCELLED",
    CONFLICTING_TURN: "CONFLICTING_TURN",
    DOWNLOAD_FAILED: "DOWNLOAD_FAILED",
    DOWNLOAD_TIMEOUT: "DOWNLOAD_TIMEOUT",
    INVALID_INPUT: "INVALID_INPUT",
    JOB_EXPIRED: "JOB_EXPIRED",
    JOB_NOT_FOUND: "JOB_NOT_FOUND",
    MEDIA_FETCH_FAILED: "MEDIA_FETCH_FAILED",
    MEDIA_LIMIT_EXCEEDED: "MEDIA_LIMIT_EXCEEDED",
    NO_CONVERSATION: "NO_CONVERSATION",
    PERMISSION_DENIED: "PERMISSION_DENIED",
    TRANSCRIPT_LIMIT_EXCEEDED: "TRANSCRIPT_LIMIT_EXCEEDED",
    TURN_LIMIT_EXCEEDED: "TURN_LIMIT_EXCEEDED",
    UNSAFE_PATH: "UNSAFE_PATH",
    UNSUPPORTED_PAGE: "UNSUPPORTED_PAGE",
    ZIP_INVALID: "ZIP_INVALID"
  });

  const JOB_PHASES = Object.freeze([
    "created",
    "collecting",
    "awaiting-files",
    "building",
    "downloading",
    "complete",
    "failed",
    "cancelled"
  ]);

  class ExportError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = "ExportError";
      this.code = code || ERROR_CODES.INVALID_INPUT;
      this.details = sanitizeDetails(details);
    }
  }

  function sanitizeDetails(details) {
    if (!details || typeof details !== "object") return undefined;
    const safe = {};
    for (const [key, value] of Object.entries(details)) {
      if (/token|authorization|cookie|secret|header/i.test(key)) continue;
      if (["string", "number", "boolean"].includes(typeof value)) safe[key] = value;
    }
    return safe;
  }

  function assertPlainObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ExportError(ERROR_CODES.INVALID_INPUT, `${label} must be an object.`);
    }
  }

  function rejectUnknownKeys(value, allowed, label) {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        throw new ExportError(ERROR_CODES.INVALID_INPUT, `${label} contains an unknown field: ${key}.`);
      }
    }
  }

  function validateOptions(value) {
    assertPlainObject(value, "Export options");
    rejectUnknownKeys(value, ["includeMedia", "includeTimestamps", "allowPartial", "jobId", "protectedFilePolicy"], "Export options");
    for (const key of ["includeMedia", "includeTimestamps", "allowPartial"]) {
      if (value[key] !== undefined && typeof value[key] !== "boolean") {
        throw new ExportError(ERROR_CODES.INVALID_INPUT, `${key} must be boolean.`);
      }
    }
    if (value.jobId !== undefined && !/^[a-z0-9-]{8,80}$/i.test(value.jobId)) {
      throw new ExportError(ERROR_CODES.INVALID_INPUT, "Invalid job identifier.");
    }
    if (value.protectedFilePolicy !== undefined && value.protectedFilePolicy !== "assisted-selection") {
      throw new ExportError(ERROR_CODES.INVALID_INPUT, "Unsupported protected-file policy.");
    }
    return Object.freeze({
      includeMedia: Boolean(value.includeMedia),
      includeTimestamps: value.includeTimestamps !== false,
      allowPartial: Boolean(value.allowPartial),
      jobId: value.jobId || createJobId(),
      protectedFilePolicy: "assisted-selection"
    });
  }

  function validateTurn(turn) {
    assertPlainObject(turn, "Turn");
    rejectUnknownKeys(turn, ["turnNumber", "turnId", "role", "timestamp", "markdown", "attachments"], "Turn");
    if (!Number.isInteger(turn.turnNumber) || turn.turnNumber < 1 || turn.turnNumber > LIMITS.maxTurns) {
      throw new ExportError(ERROR_CODES.INVALID_INPUT, "Turn number is outside the supported range.");
    }
    if (typeof turn.turnId !== "string" || !turn.turnId.trim()) {
      throw new ExportError(ERROR_CODES.INVALID_INPUT, "Turn ID is required.");
    }
    if (!['user', 'assistant', 'system', 'tool', 'unknown'].includes(turn.role)) {
      throw new ExportError(ERROR_CODES.INVALID_INPUT, "Turn role is invalid.");
    }
    if (typeof turn.markdown !== "string") {
      throw new ExportError(ERROR_CODES.INVALID_INPUT, "Turn Markdown must be text.");
    }
    if (!Array.isArray(turn.attachments)) {
      throw new ExportError(ERROR_CODES.INVALID_INPUT, "Turn attachments must be an array.");
    }
    return turn;
  }

  function validateSnapshot(snapshot) {
    assertPlainObject(snapshot, "Conversation snapshot");
    const allowed = ["schemaVersion", "title", "sourceUrl", "routeKind", "exportedAt", "complete", "completion", "turns", "attachments", "warnings"];
    rejectUnknownKeys(snapshot, allowed, "Conversation snapshot");
    if (snapshot.schemaVersion !== 1 || typeof snapshot.title !== "string" || typeof snapshot.sourceUrl !== "string") {
      throw new ExportError(ERROR_CODES.INVALID_INPUT, "Snapshot identity is invalid.");
    }
    if (!Array.isArray(snapshot.turns) || snapshot.turns.length === 0) {
      throw new ExportError(ERROR_CODES.NO_CONVERSATION, "No conversation turns were collected.");
    }
    if (snapshot.turns.length > LIMITS.maxTurns) {
      throw new ExportError(ERROR_CODES.TURN_LIMIT_EXCEEDED, "The conversation exceeds the turn limit.");
    }
    let previous = 0;
    const ids = new Set();
    for (const turn of snapshot.turns) {
      validateTurn(turn);
      if (turn.turnNumber <= previous || ids.has(turn.turnId)) {
        throw new ExportError(ERROR_CODES.CONFLICTING_TURN, "Turns are duplicated or out of order.");
      }
      previous = turn.turnNumber;
      ids.add(turn.turnId);
    }
    if (snapshot.complete && (!snapshot.completion
      || snapshot.completion.turnOneStableChecks < LIMITS.stableBeginningChecks
      || !snapshot.completion.latestCovered
      || !snapshot.completion.bottomObserved
      || !snapshot.completion.fullScanCompleted
      || (snapshot.completion.gaps || []).length)) {
      throw new ExportError(ERROR_CODES.INVALID_INPUT, "Complete snapshot lacks its required proof.");
    }
    return snapshot;
  }

  function utf8Size(value) {
    return new TextEncoder().encode(String(value || "")).byteLength;
  }

  function ensureTranscriptSize(markdown) {
    const bytes = utf8Size(markdown);
    if (bytes > LIMITS.maxTranscriptBytes) {
      throw new ExportError(ERROR_CODES.TRANSCRIPT_LIMIT_EXCEEDED, "The Markdown transcript exceeds 25 MiB.", { bytes });
    }
    return bytes;
  }

  function createJobId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") return global.crypto.randomUUID();
    return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function serializeError(error) {
    return {
      code: error && error.code ? error.code : ERROR_CODES.INVALID_INPUT,
      message: error && error.message ? error.message : "The export could not be completed.",
      details: sanitizeDetails(error && error.details)
    };
  }

  global.ChatGPTExporter = Object.assign(global.ChatGPTExporter || {}, {
    LIMITS,
    ERROR_CODES,
    JOB_PHASES,
    ExportError,
    createJobId,
    ensureTranscriptSize,
    serializeError,
    utf8Size,
    validateOptions,
    validateSnapshot,
    validateTurn
  });
})(globalThis);
