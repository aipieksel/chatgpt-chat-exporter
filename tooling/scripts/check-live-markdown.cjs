"use strict";

const assert = require('node:assert/strict');
const fs = require('node:fs');

const [snapshotPath, markdownPath] = process.argv.slice(2);
assert.ok(snapshotPath && markdownPath, 'Usage: node check-live-markdown.cjs captured-result.json downloaded.md');
const expected = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
const actual = fs.readFileSync(markdownPath, 'utf8');

function stableFileLinks(text) {
  return text.replace(/https:\/\/chatgpt\.com\/backend-api\/estuary\/content\?[^\s)]+/g, (raw) => {
    const url = new URL(raw);
    // Signed file links rotate; retain the file identity and all content metadata.
    url.searchParams.delete('sig');
    url.searchParams.delete('ts');
    return url.href;
  });
}

function turns(markdown) {
  const entries = [...markdown.matchAll(/^## (User|ChatGPT|Unknown author) - Turn (\d+)[^\n]*\n([\s\S]*?)(?=^## (?:User|ChatGPT|Unknown author) - Turn \d+|$(?![\s\S]))/gm)];
  const result = new Map();
  for (const match of entries) {
    const number = Number(match[2]);
    assert.ok(!result.has(number), `Duplicate turn ${number}`);
    result.set(number, { role: match[1], body: stableFileLinks(match[3].trim()) });
  }
  return result;
}

const source = turns(expected.markdown);
const exported = turns(actual);
assert.equal(Number(actual.match(/^- Turns: (\d+)$/m)?.[1]), exported.size, 'Declared turn count');
assert.match(actual, /^- Completeness: Complete$/m);
assert.ok(exported.size >= source.size, 'Original turns must not be missing');
for (const turn of expected.snapshot.turns) {
  const role = turn.role === 'user' ? 'User' : turn.role === 'assistant' ? 'ChatGPT' : 'Unknown author';
  assert.deepEqual(exported.get(turn.turnNumber), { ...source.get(turn.turnNumber), role }, `Original turn ${turn.turnNumber}`);
}
assert.deepEqual([...exported.keys()], Array.from({ length: exported.size }, (_, index) => index + 1));
console.log(`PASS actual Markdown: all ${source.size} original turn bodies and authors match; ${exported.size} total contiguous turns. Only expiring file-link signature/time parameters normalized.`);
