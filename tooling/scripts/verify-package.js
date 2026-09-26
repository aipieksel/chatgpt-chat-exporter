"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const packageApi = require("./package.js");

let checks = 0;
function pass(fn) {
  fn();
  checks += 1;
}
function fails(fn, pattern) {
  assert.throws(fn, pattern);
  checks += 1;
}

const { sourceFiles, manifest } = packageApi.loadSourceFiles();
pass(() => packageApi.validateRuntimeClosure(sourceFiles, manifest));
pass(() => packageApi.validateIcons(sourceFiles, manifest));
pass(() => packageApi.validateArchiveListing([...sourceFiles.keys()]));

const missingDependency = new Map(sourceFiles);
missingDependency.delete("media.css");
fails(() => packageApi.validateRuntimeClosure(missingDependency, manifest), /media\.html -> media\.css/);

const unreachable = new Map(sourceFiles);
unreachable.set("unused.js", Buffer.from("void 0;"));
fails(() => packageApi.validateRuntimeClosure(unreachable, manifest), /not reachable.*unused\.js/);
fails(() => packageApi.validateArchiveListing([...sourceFiles.keys(), "manifest.json"]), /Duplicate ZIP entries/);
fails(() => packageApi.validateArchiveListing([...sourceFiles.keys(), "docs/private.txt"]), /Prohibited archive entry/);
fails(() => packageApi.validateArchiveName("../private.txt"), /Unsafe archive entry/);
fails(() => packageApi.validateArchiveName("icons/icon-128.png.bak"), /Prohibited backup entry/);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-exporter-package-"));
try {
  const validPath = path.join(tempRoot, "valid.zip");
  fs.writeFileSync(validPath, packageApi.createArchiveBytes(sourceFiles));
  pass(() => packageApi.verifyPackage(validPath, sourceFiles, manifest));

  const wrongVersion = new Map(sourceFiles);
  const changedManifest = { ...manifest, version: "9.9.9" };
  wrongVersion.set("manifest.json", Buffer.from(`${JSON.stringify(changedManifest)}\n`));
  const wrongVersionPath = path.join(tempRoot, "wrong-version.zip");
  fs.writeFileSync(wrongVersionPath, packageApi.createArchiveBytes(wrongVersion));
  fails(() => packageApi.verifyPackage(wrongVersionPath, sourceFiles, manifest), /Packaged bytes differ.*manifest/);

  const tampered = new Map(sourceFiles);
  tampered.set("media.css", Buffer.concat([tampered.get("media.css"), Buffer.from("\n\/* tampered *\/\n")]));
  const tamperedPath = path.join(tempRoot, "tampered.zip");
  fs.writeFileSync(tamperedPath, packageApi.createArchiveBytes(tampered));
  fails(() => packageApi.verifyPackage(tamperedPath, sourceFiles, manifest), /Packaged bytes differ.*media\.css/);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`PASS package contract ${checks} cases`);
