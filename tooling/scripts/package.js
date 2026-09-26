"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../../extension");
const RUNTIME_FILES = Object.freeze([
  "manifest.json",
  "media.html",
  "media.css",
  "media.js",
  "src/contracts.js",
  "src/filename.js",
  "src/markdown.js",
  "src/attachments.js",
  "src/attachment-reconciler.js",
  "src/zip.js",
  "src/turn-normalizer.js",
  "src/chatgpt-adapter.js",
  "src/content-entry.js",
  "src/panel-shell.js",
  "panel.js",
  "src/background.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
  "icons/icon-light-16.png",
  "icons/icon-light-32.png",
  "icons/icon-light-48.png",
  "icons/icon-light-128.png",
  "icons/icon-dark-16.png",
  "icons/icon-dark-32.png",
  "icons/icon-dark-48.png",
  "icons/icon-dark-128.png"
]);
const PROHIBITED_PARTS = new Set([
  ".git", ".github", ".codex", ".agents", "__MACOSX", "node_modules", "docs",
  "documents", "tests", "scripts", "dist", "downloads", "exports", "evidence",
  "profiles", "tmp", "backups"
]);

class PackageError extends Error {}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function normalizeReference(owner, reference) {
  const clean = String(reference || "").split(/[?#]/, 1)[0].trim();
  if (!clean || clean.startsWith("#") || /^[a-z]+:/i.test(clean) || clean.startsWith("//")) return null;
  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(owner), clean));
  validateArchiveName(normalized);
  return normalized;
}

function addManifestValue(target, value) {
  if (typeof value === "string") target.add(value);
  else if (Array.isArray(value)) for (const item of value) addManifestValue(target, item);
  else if (value && typeof value === "object") for (const item of Object.values(value)) addManifestValue(target, item);
}

function manifestReferences(manifest) {
  const refs = new Set();
  addManifestValue(refs, manifest.background && manifest.background.service_worker);
  addManifestValue(refs, manifest.icons);
  if (manifest.action) {
    addManifestValue(refs, manifest.action.default_icon);
    addManifestValue(refs, manifest.action.default_popup);
  }
  for (const content of manifest.content_scripts || []) {
    addManifestValue(refs, content.js);
    addManifestValue(refs, content.css);
  }
  return new Set([...refs].map((ref) => normalizeReference("manifest.json", ref)).filter(Boolean));
}

function directReferences(owner, data, manifest) {
  if (owner === "manifest.json") return manifestReferences(manifest);
  const text = data.toString("utf8");
  const refs = new Set();
  if (/\.html$/i.test(owner)) {
    for (const match of text.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/gi)) {
      const ref = normalizeReference(owner, match[1]);
      if (ref) refs.add(ref);
    }
  }
  if (/\.js$/i.test(owner)) {
    for (const call of text.matchAll(/\bimportScripts\s*\(([^)]*)\)/g)) {
      for (const match of call[1].matchAll(/["']([^"']+)["']/g)) {
        const ref = normalizeReference(owner, match[1]);
        if (ref) refs.add(ref);
      }
    }
    for (const match of text.matchAll(/chrome\.runtime\.getURL\s*\(\s*[`"']([^`"']+)/g)) {
      const ref = normalizeReference("manifest.json", match[1]);
      if (ref) refs.add(ref);
    }
  }
  return refs;
}

function validateArchiveName(name) {
  if (typeof name !== "string" || !name || name.startsWith("/") || name.includes("\\") || name.includes("\0")) {
    throw new PackageError(`Unsafe archive entry: ${JSON.stringify(name)}`);
  }
  const parts = name.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new PackageError(`Unsafe archive entry: ${name}`);
  }
  if (parts.some((part) => PROHIBITED_PARTS.has(part))) throw new PackageError(`Prohibited archive entry: ${name}`);
  if (/\.(?:bak|old|orig|tmp)$/i.test(name)) throw new PackageError(`Prohibited backup entry: ${name}`);
}

function loadSourceFiles(projectRoot = ROOT, runtimeFiles = RUNTIME_FILES) {
  if (new Set(runtimeFiles).size !== runtimeFiles.length) throw new PackageError("Runtime allowlist contains duplicate paths.");
  const sourceFiles = new Map();
  for (const relative of runtimeFiles) {
    validateArchiveName(relative);
    const absolute = path.join(projectRoot, relative);
    if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isFile()) throw new PackageError(`Missing allowlisted runtime file: ${relative}`);
    sourceFiles.set(relative, fs.readFileSync(absolute));
  }
  let manifest;
  try { manifest = JSON.parse(sourceFiles.get("manifest.json").toString("utf8")); }
  catch (error) { throw new PackageError(`Invalid manifest.json: ${error.message}`); }
  if (manifest.manifest_version !== 3 || typeof manifest.version !== "string" || !manifest.version) {
    throw new PackageError("Manifest V3 with a non-empty version is required.");
  }
  return { sourceFiles, manifest };
}

function validateRuntimeClosure(sourceFiles, manifest) {
  const reachable = new Set(["manifest.json"]);
  const pending = ["manifest.json"];
  while (pending.length) {
    const owner = pending.shift();
    const data = sourceFiles.get(owner);
    if (!data) throw new PackageError(`Runtime dependency is not allowlisted: ${owner}`);
    for (const dependency of directReferences(owner, data, manifest)) {
      if (!sourceFiles.has(dependency)) throw new PackageError(`Runtime dependency is not allowlisted: ${owner} -> ${dependency}`);
      if (!reachable.has(dependency)) {
        reachable.add(dependency);
        pending.push(dependency);
      }
    }
  }
  const unreachable = [...sourceFiles.keys()].filter((name) => !reachable.has(name));
  if (unreachable.length) throw new PackageError(`Allowlisted files are not reachable from manifest.json: ${unreachable.join(", ")}`);
}

function pngDimensions(data) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 24 || !data.subarray(0, 8).equals(signature) || data.toString("ascii", 12, 16) !== "IHDR") {
    throw new PackageError("Icon is not a valid PNG with an IHDR chunk.");
  }
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function validateIcons(sourceFiles, manifest) {
  const expected = { 16: 16, 32: 32, 48: 48, 128: 128 };
  for (const [key, size] of Object.entries(expected)) {
    const manifestPath = manifest.icons && manifest.icons[key];
    const actionPath = manifest.action && manifest.action.default_icon && manifest.action.default_icon[key];
    const darkPath = `icons/icon-dark-${key}.png`;
    if (!manifestPath || actionPath !== `icons/icon-light-${key}.png`) throw new PackageError(`Manifest/action theme icon mapping is incomplete at ${key}px.`);
    for (const iconPath of [manifestPath, actionPath, darkPath]) {
      const dimensions = pngDimensions(sourceFiles.get(iconPath) || Buffer.alloc(0));
      if (dimensions.width !== size || dimensions.height !== size) throw new PackageError(`Icon ${iconPath} is not ${size}x${size}.`);
    }
  }
}

function createArchiveBytes(sourceFiles) {
  const prior = global.ChatGPTExporter;
  delete global.ChatGPTExporter;
  delete require.cache[require.resolve(path.join(ROOT, "src/contracts.js"))];
  delete require.cache[require.resolve(path.join(ROOT, "src/zip.js"))];
  require(path.join(ROOT, "src/contracts.js"));
  require(path.join(ROOT, "src/zip.js"));
  const bytes = Buffer.from(global.ChatGPTExporter.createZipBytes([...sourceFiles].map(([entryPath, data]) => ({ path: entryPath, data })), new Date(2020, 0, 1, 0, 0, 0)));
  if (prior === undefined) delete global.ChatGPTExporter;
  else global.ChatGPTExporter = prior;
  return bytes;
}

function validateArchiveListing(entries, expected = RUNTIME_FILES) {
  for (const entry of entries) validateArchiveName(entry);
  const duplicates = entries.filter((entry, index) => entries.indexOf(entry) !== index);
  if (duplicates.length) throw new PackageError(`Duplicate ZIP entries: ${[...new Set(duplicates)].join(", ")}`);
  if (entries[0] !== "manifest.json" || entries.filter((entry) => entry === "manifest.json").length !== 1) {
    throw new PackageError("manifest.json must appear exactly once at the ZIP root and be the first entry.");
  }
  const missing = expected.filter((name) => !entries.includes(name));
  const extra = entries.filter((name) => !expected.includes(name));
  if (missing.length || extra.length || entries.some((name, index) => name !== expected[index])) {
    throw new PackageError(`ZIP entries differ from runtime allowlist (missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}).`);
  }
}

function unzipEntry(zipPath, name) {
  const result = spawnSync("unzip", ["-p", zipPath, name], { encoding: null, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new PackageError((result.stderr || result.stdout || "unzip failed").toString().trim());
  return result.stdout;
}

function verifyPackage(zipPath, sourceFiles, manifest) {
  const test = spawnSync("unzip", ["-tqq", zipPath], { encoding: "utf8" });
  if (test.status !== 0) throw new PackageError(test.stderr || test.stdout || "ZIP integrity check failed.");
  const listing = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
  if (listing.status !== 0) throw new PackageError(listing.stderr || "ZIP listing failed.");
  const entries = listing.stdout.trim().split("\n").filter(Boolean);
  validateArchiveListing(entries, [...sourceFiles.keys()]);
  for (const name of entries) {
    const packaged = unzipEntry(zipPath, name);
    if (!Buffer.from(packaged).equals(sourceFiles.get(name))) throw new PackageError(`Packaged bytes differ from source: ${name}`);
  }
  const packagedManifest = JSON.parse(Buffer.from(unzipEntry(zipPath, "manifest.json")).toString("utf8"));
  if (packagedManifest.version !== manifest.version) throw new PackageError("Packaged manifest version differs from source manifest version.");
  return entries;
}

function build(projectRoot = ROOT) {
  const { sourceFiles, manifest } = loadSourceFiles(projectRoot);
  validateRuntimeClosure(sourceFiles, manifest);
  validateIcons(sourceFiles, manifest);
  const licensePath = path.resolve(projectRoot, "../LICENSE");
  if (!fs.statSync(licensePath, { throwIfNoEntry: false })?.isFile()) {
    throw new PackageError("Missing repository LICENSE file.");
  }
  const packageFiles = new Map(sourceFiles);
  packageFiles.set("LICENSE", fs.readFileSync(licensePath));
  const output = path.join(projectRoot, "../dist", `chatgpt-chat-exporter-${manifest.version}.zip`);
  const partial = `${output}.partial`;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const archiveBytes = createArchiveBytes(packageFiles);
  if (archiveBytes.length >= 2 * 1024 ** 3) throw new PackageError("Package must be smaller than 2 GB.");
  fs.writeFileSync(partial, archiveBytes);
  verifyPackage(partial, packageFiles, manifest);
  fs.renameSync(partial, output);
  const data = fs.readFileSync(output);
  console.log(`PASS package ${output}`);
  console.log(`PASS runtime-only closure ${sourceFiles.size} entries`);
  console.log("PASS repository MIT license notice included");
  console.log(`PASS size ${data.length} bytes`);
  console.log(`PASS sha256 ${sha256(data)}`);
  return { output, entries: [...sourceFiles.keys()], size: data.length, sha256: sha256(data), manifest };
}

if (require.main === module) {
  try { build(); }
  catch (error) {
    process.stderr.write(`package.js: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  PackageError,
  PROHIBITED_PARTS,
  ROOT,
  RUNTIME_FILES,
  build,
  createArchiveBytes,
  directReferences,
  loadSourceFiles,
  manifestReferences,
  pngDimensions,
  sha256,
  validateArchiveListing,
  validateArchiveName,
  validateIcons,
  validateRuntimeClosure,
  verifyPackage
};
