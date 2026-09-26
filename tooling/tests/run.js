"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../../extension");
const sourceFiles = [
  "src/contracts.js",
  "src/filename.js",
  "src/attachments.js",
  "src/attachment-reconciler.js",
  "src/markdown.js",
  "src/turn-normalizer.js",
  "src/zip.js"
];
for (const file of sourceFiles) vm.runInThisContext(fs.readFileSync(path.join(root, file), "utf8"), { filename: file });
const api = globalThis.ChatGPTExporter;

let assertions = 0;
function check(fn) { fn(); assertions += 1; }
async function checkAsync(fn) { await fn(); assertions += 1; }

function snapshot(overrides) {
  return Object.assign({
    schemaVersion: 1,
    title: "A useful / chat",
    sourceUrl: "https://chatgpt.com/c/example",
    routeKind: "conversation",
    exportedAt: "2026-09-06T00:00:00.000Z",
    complete: true,
    completion: { turnOneStableChecks: 3, latestCovered: true, bottomObserved: true, fullScanCompleted: true, gaps: [] },
    turns: [
      { turnNumber: 1, turnId: "u1", role: "user", timestamp: null, markdown: "Hello", attachments: [] },
      { turnNumber: 2, turnId: "a1", role: "assistant", timestamp: null, markdown: "Hi there", attachments: [] }
    ],
    attachments: [],
    warnings: []
  }, overrides || {});
}

(async () => {
  check(() => assert.equal(api.LIMITS.maxTurns, 5000));
  check(() => assert.equal(api.LIMITS.maxLoadCycles, 300));
  check(() => assert.equal(api.LIMITS.stableBeginningChecks, 3));
  check(() => assert.equal(api.LIMITS.historySettleMs, 2200));
  check(() => assert.equal(api.LIMITS.maxTranscriptBytes, 25 * 1024 * 1024));
  check(() => assert.throws(() => api.validateOptions({ unexpected: true }), /unknown field/));
  check(() => assert.equal(api.validateOptions({ includeMedia: true }).protectedFilePolicy, "assisted-selection"));
  check(() => {
    const first = api.validateOptions({ includeMedia: true, includeTimestamps: true, allowPartial: false, jobId: "roundtrip-job" });
    assert.equal(api.validateOptions(first).protectedFilePolicy, "assisted-selection");
  });
  check(() => assert.throws(() => api.validateSnapshot(snapshot({ turns: [snapshot().turns[1], snapshot().turns[0]] })), /out of order/));
  check(() => assert.throws(() => api.validateSnapshot(snapshot({ complete: true, completion: { turnOneStableChecks: 2, latestCovered: true, bottomObserved: true, fullScanCompleted: true, gaps: [] } })), /required proof/));
  check(() => assert.throws(() => api.validateSnapshot(snapshot({ complete: true, completion: { turnOneStableChecks: 3, latestCovered: true, bottomObserved: false, fullScanCompleted: false, gaps: [] } })), /required proof/));

  check(() => assert.equal(api.sanitizeFilenamePart("A / useful: chat?"), "A - useful- chat-"));
  check(() => assert.equal(api.sanitizeFilenamePart("CON"), "_CON"));
  check(() => assert.equal(api.artifactFilename("My chat", "md", false), "My chat.md"));
  check(() => assert.equal(api.artifactFilename("My chat", "md", true), "My chat-partial.md"));
  check(() => {
    const used = new Set();
    assert.equal(api.uniqueFilename("image.png", used), "image.png");
    assert.equal(api.uniqueFilename("image.png", used), "image-2.png");
  });
  check(() => assert.throws(() => api.safeArchivePath("user", "../bad.txt", new Set(["-bad.txt"])), /unsafe|archive/i));

  check(() => assert.equal(api.classifyAttachmentUrl("https://chatgpt.com/backend-api/conversation/a/interpreter/download").kind, "protected"));
  check(() => assert.equal(api.classifyAttachmentUrl("https://files.oaiusercontent.com/file.png").kind, "optional-origin"));
  check(() => assert.equal(api.classifyAttachmentUrl("javascript:alert(1)").kind, "invalid"));
  check(() => assert.equal(api.isTextAttachment({ originalFilename: "Pasted text.txt", mimeType: "" }), true));
  check(() => assert.equal(api.isTextAttachment({ originalFilename: "photo.png", mimeType: "image/png" }), false));
  check(() => {
    const cache = new Map([["stable-a", { turnNumber: 1, turnId: "stable-a", role: "user", timestamp: null, markdown: "Same content", attachments: [] }]]);
    assert.equal(api.mergeTurn(cache, { turnNumber: 1, turnId: "rerendered-a", role: "user", timestamp: null, markdown: "Same content", attachments: [] }), true);
    assert.deepEqual(Array.from(cache.values()).map((turn) => turn.turnId), ["rerendered-a"]);
  });
  check(() => {
    const cache = new Map([["stable-a", { turnNumber: 1, turnId: "stable-a", role: "user", timestamp: null, markdown: "Partial", attachments: [] }]]);
    assert.equal(api.mergeTurn(cache, { turnNumber: 1, turnId: "rerendered-a", role: "user", timestamp: null, markdown: "Partial plus richer content", attachments: [] }), true);
    assert.equal(cache.get("rerendered-a").markdown, "Partial plus richer content");
  });
  check(() => {
    const cache = new Map([["stable-a", { turnNumber: 1, turnId: "stable-a", role: "user", timestamp: null, markdown: "Same content", attachments: [] }]]);
    assert.throws(() => api.mergeTurn(cache, { turnNumber: 1, turnId: "rerendered-a", role: "assistant", timestamp: null, markdown: "Same content", attachments: [] }), /changed role/);
  });
  check(() => {
    const cache = new Map([["stable-a", { turnNumber: 1, turnId: "stable-a", role: "user", timestamp: null, markdown: "Alpha", attachments: [] }]]);
    assert.throws(() => api.mergeTurn(cache, { turnNumber: 1, turnId: "stable-a", role: "user", timestamp: null, markdown: "Bravo", attachments: [] }), /conflicting stable content/);
  });
  check(() => {
    const cache = new Map([
      ["later-user", { turnNumber: 1, turnId: "later-user", role: "user", timestamp: null, markdown: "Later", attachments: [] }],
      ["later-assistant", { turnNumber: 2, turnId: "later-assistant", role: "assistant", timestamp: null, markdown: "Reply", attachments: [] }]
    ]);
    const visible = [
      { turnNumber: 3, turnId: "later-user", role: "user", timestamp: null, markdown: "Later", attachments: [] },
      { turnNumber: 4, turnId: "later-assistant", role: "assistant", timestamp: null, markdown: "Reply", attachments: [] }
    ];
    assert.equal(api.reconcileTurnPositions(cache, visible), true);
    assert.deepEqual(api.orderedTurns(cache).map((turn) => turn.turnNumber), [3, 4]);
  });
  check(() => {
    const make = (turnNumber, turnId) => ({ turnNumber, turnId, role: turnNumber % 2 ? "user" : "assistant", timestamp: null, markdown: `Message ${turnId}`, attachments: [] });
    const cache = new Map();
    const initialTailWindow = Array.from({ length: 10 }, (_, index) => make(index + 1, `stable-${index + 29}`));
    for (const turn of initialTailWindow) api.mergeTurn(cache, turn);
    const shiftedTailWindow = initialTailWindow.map((turn) => Object.assign({}, turn, { turnNumber: turn.turnNumber + 28 }));
    assert.equal(api.reconcileTurnPositions(cache, shiftedTailWindow), true);
    for (const turn of shiftedTailWindow) api.mergeTurn(cache, turn);
    for (let value = 1; value <= 28; value += 1) api.mergeTurn(cache, make(value, `stable-${value}`));
    const coverage = api.coverageState(cache, "stable-38");
    assert.equal(coverage.latestNumber, 38);
    assert.equal(coverage.tailIsLatest, true);
    assert.equal(coverage.duplicatePositions, false);
    assert.deepEqual(coverage.gaps, []);
  });
  check(() => {
    const make = (turnNumber, turnId) => ({ turnNumber, turnId, role: turnNumber % 2 ? "user" : "assistant", timestamp: null, markdown: `Message ${turnId}`, attachments: [] });
    const cache = new Map();
    const tail = Array.from({ length: 5 }, (_, index) => make(index + 16, `tail-${index + 1}`));
    for (const turn of tail) api.mergeTurn(cache, turn);
    const firstPrepend = tail.map((turn) => Object.assign({}, turn, { turnNumber: turn.turnNumber + 10 }));
    api.reconcileTurnPositions(cache, firstPrepend);
    for (const turn of firstPrepend) api.mergeTurn(cache, turn);
    const secondPrepend = tail.map((turn, index) => Object.assign({}, turn, { turnNumber: index + 34 }));
    api.reconcileTurnPositions(cache, secondPrepend);
    for (const turn of secondPrepend) api.mergeTurn(cache, turn);
    assert.deepEqual(api.orderedTurns(cache).map((turn) => turn.turnNumber), [34, 35, 36, 37, 38]);
  });
  check(() => {
    const make = (turnNumber) => ({ turnNumber, turnId: `gap-${turnNumber}`, role: turnNumber % 2 ? "user" : "assistant", timestamp: null, markdown: `Message ${turnNumber}`, attachments: [] });
    const cache = new Map([1, 2, 3, 8].map((value) => [`gap-${value}`, make(value)]));
    assert.deepEqual(api.coverageState(cache, "gap-8").gaps, [4, 5, 6, 7]);
  });
  check(() => {
    const assigned = api.assignArchivePaths([
      { ownerRole: "user", originalFilename: "same.txt" },
      { ownerRole: "user", originalFilename: "same.txt" },
      { ownerRole: "assistant", originalFilename: "same.txt" }
    ]);
    assert.deepEqual(assigned.map((item) => item.archivePath), ["media/user/same.txt", "media/user/same-2.txt", "media/chatgpt/same.txt"]);
  });

  check(() => {
    const descriptors = [{ id: "a", originalFilename: "Pasted text.txt", requiresSelection: true }];
    const result = api.reconcileSelectedFiles(descriptors, [{ name: "Pasted text.txt", size: 12, type: "text/plain" }], {});
    assert.equal(result.matches[0].status, "matched");
  });
  check(() => {
    const descriptors = [{ id: "a", originalFilename: "same.txt", requiresSelection: true }];
    const files = [{ name: "same.txt", size: 12, type: "text/plain" }, { name: "same.txt", size: 12, type: "text/plain" }];
    assert.equal(api.reconcileSelectedFiles(descriptors, files, {}).matches[0].status, "ambiguous");
  });
  check(() => assert.throws(() => api.validateSelectedFile({ name: "huge.bin", size: api.LIMITS.maxMediaBytes + 1 }), /50 MiB/));

  check(() => {
    const markdown = api.renderConversationMarkdown(snapshot(), { includeTimestamps: true });
    assert.match(markdown, /^# A useful \/ chat/m);
    assert.match(markdown, /## User[\s\S]*Hello[\s\S]*## ChatGPT[\s\S]*Hi there/);
    assert.doesNotMatch(markdown, /\[object Object\]/);
  });
  check(() => {
    const value = api.fencedCode("```inside```", "js");
    assert.match(value, /````js/);
  });
  check(() => {
    const data = snapshot();
    data.turns[0].timestamp = {value:'2026-09-10T18:12:34Z'};
    const output = api.renderConversationMarkdown(data, {includeTimestamps:true});
    assert.match(output, /^## User - Turn 1 - 2026-09-10 18:12:34 UTC\n\nHello/m);
    assert.match(output, /^## ChatGPT - Turn 2\n\nHi there/m);
    assert.doesNotMatch(output, /<!-- turn/);
    const without = api.renderConversationMarkdown(data, {includeTimestamps:false});
    assert.doesNotMatch(without, /18:12:34/);
  });
  check(() => {
    const withMarker = "<!--sp-attachment-start:x-->\n**Attachment:** note.txt\n<!--sp-attachment-end:x-->";
    const applied = api.applyAttachmentResults(withMarker, [{ id: "x", originalFilename: "note.txt", archivePath: "media/user/note.txt", inlineText: "hello" }]);
    assert.match(applied, /\[note\.txt\]\(media\/user\/note\.txt\)/);
    assert.match(applied, /```txt\nhello/);
  });
  check(() => {
    const manifest = api.renderManifest({ title: "Chat", snapshotComplete: true }, [{ originalFilename: "a.txt", ownerRole: "user", turnNumber: 1, archivePath: "media/user/a.txt", size: 4, error: null }]);
    assert.match(manifest, /Media complete: Yes/);
    assert.match(manifest, /media\/user\/a.txt/);
  });

  check(() => assert.equal(api.zipCrc32(new TextEncoder().encode("123456789")), 0xcbf43926));
  check(() => {
    const bytes = api.createZipBytes([{ path: "conversation.md", data: "hello" }, { path: "media/user/a.txt", data: "a" }]);
    assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50);
    assert.equal(new DataView(bytes.buffer).getUint32(bytes.length - 22, true), 0x06054b50);
  });
  check(() => assert.throws(() => api.createZipBytes([{ path: "../bad", data: "x" }]), /unsafe/));
  check(() => assert.throws(() => api.createZipBytes([{ path: "a", data: "1" }, { path: "A", data: "2" }]), /Duplicate ZIP path/));
  await checkAsync(async () => {
    const blob = api.createZipBlob([{ path: "conversation.md", data: "hello" }]);
    assert.equal(blob.type, "application/zip");
    assert.ok(blob.size > 22);
  });

  const fixture = JSON.parse(fs.readFileSync(path.join(root, "../tooling/tests/fixtures/conversation-variants.json"), "utf8"));
  check(() => assert.deepEqual(fixture.variants.map((item) => item.name), ["standard", "project", "temporary", "custom-gpt", "work-branch", "public-share"]));
  check(() => assert.equal(fixture.beginning.stableChecks, api.LIMITS.stableBeginningChecks));

  console.log(`PASS ${assertions} deterministic assertions`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
