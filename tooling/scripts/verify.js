"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../../extension");
const javascript = [];
for (const folder of [root, path.join(root, "src"), path.join(root, "../tooling/tests"), path.join(root, "../tooling/scripts")]) {
  for (const name of fs.readdirSync(folder)) if (/\.c?js$/.test(name)) javascript.push(path.join(folder, name));
}
for (const file of javascript.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Manifest V3 is required.");
if (manifest.action && manifest.action.default_popup) throw new Error("Toolbar action must open the floating exporter panel, not a popup.");
const forbiddenPermissions = ["<all_urls>", "debugger", "history", "pageCapture"];
const declared = [...(manifest.permissions || []), ...(manifest.host_permissions || []), ...(manifest.optional_host_permissions || [])];
for (const permission of forbiddenPermissions) if (declared.includes(permission)) throw new Error(`Forbidden permission: ${permission}`);
for (const icon of Object.values(manifest.icons || {})) if (!fs.existsSync(path.join(root, icon))) throw new Error(`Missing manifest icon: ${icon}`);
for (const [size, icon] of Object.entries(manifest.icons || {})) {
  if (!manifest.action || !manifest.action.default_icon || manifest.action.default_icon[size] !== `icons/icon-light-${size}.png`) throw new Error(`Light toolbar icon mapping is missing at ${size}px.`);
  if (!fs.existsSync(path.join(root, `icons/icon-dark-${size}.png`))) throw new Error(`Dark toolbar icon is missing at ${size}px.`);
}
const archiveSource = fs.readFileSync(path.join(root, "media.js"), "utf8");
const emptyBranch = archiveSource.match(/if \(!protectedItems\.length\) \{([\s\S]*?)\n    \}/)?.[1] || "";
if (/\bitem\./.test(emptyBranch)) throw new Error("No-protected-files branch references an unavailable attachment item.");
if (!/for \(const item of protectedItems\)[\s\S]*row\.dataset\.attachmentId = item\.id/.test(archiveSource)) throw new Error("Protected-file rows must expose their attachment ID for state reconciliation.");
if (!archiveSource.includes('params.get("embed") === "1"') || !archiveSource.includes('notifyParent("ARCHIVE_COMPLETE"')) throw new Error("Media archive must operate inside the floating panel.");
const adapterSource = fs.readFileSync(path.join(root, "src/chatgpt-adapter.js"), "utf8");
if (!adapterSource.includes("const hardTimer = setTimeout(finish, timeoutMs);") || (adapterSource.match(/hardTimer = setTimeout/g) || []).length !== 1) {
  throw new Error("DOM settle waits must retain an independent hard deadline.");
}
if (!adapterSource.includes("const attemptedExpansions = new WeakSet();") || !adapterSource.includes("expandCondensedMessages(attemptedExpansions)")) {
  throw new Error("Condensed-message expansion must be idempotent per rendered control.");
}
const normalizerSource = fs.readFileSync(path.join(root, "src/turn-normalizer.js"), "utf8");
if (!normalizerSource.includes("reconcileTurnPositions(cache, visibleTurns)") || !normalizerSource.includes("cachedTurn(cache, turn.turnId)")) {
  throw new Error("Turn collection must reconcile mutable positions by stable rendered identity.");
}
const sidebarSource = fs.readFileSync(path.join(root, "panel.js"), "utf8");
const shellSource = fs.readFileSync(path.join(root, "src/panel-shell.js"), "utf8");
const sharedShellPath = path.join(root, "../../tooling/shared/panel-shell.js");
if (fs.existsSync(sharedShellPath) && shellSource !== fs.readFileSync(sharedShellPath, "utf8")) throw new Error("Shared panel shell is out of sync.");
if (!sidebarSource.includes("existing.dataset.extensionVersion === runtimeVersion") || !sidebarSource.includes("if (existing) existing.remove();") || !sidebarSource.includes("__spChatExporterSidebarInstalled")) {
  throw new Error("Floating panel injection must replace stale DOM left by an extension reload.");
}
for (const required of ["sp-chat-exporter-sidebar", "sp-chat-exporter-progress-cancel", "AipiekselPanel.create"]) {
  if (!sidebarSource.includes(required)) throw new Error(`Floating panel is missing ${required}.`);
}
if (!sidebarSource.includes("sp-chat-exporter-archive-frame") || !sidebarSource.includes("showArchiveView(job)")) throw new Error("Media archive must render inside the floating panel.");
const backgroundSource = fs.readFileSync(path.join(root, "src/background.js"), "utf8");
if (backgroundSource.includes("chrome.tabs.create({ url: chrome.runtime.getURL(`media.html")) throw new Error("Media archive must not open a separate tab.");
if (!backgroundSource.includes('case "SET_ACTION_ICON_THEME"') || !backgroundSource.includes("icon-dark-128.png")) throw new Error("Toolbar icon theme switching is missing.");
for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
  if (!shellSource.includes(`resizeHandle("${corner}"`)) throw new Error(`Missing panel resize corner: ${corner}`);
}
if (!shellSource.includes('"height:auto"') || shellSource.includes('"height:min(720px')) {
  throw new Error("Floating panel must default to its natural content height without fixed dead space.");
}

const test = spawnSync(process.execPath, [path.join(root, "../tooling/tests/run.js")], { cwd: root, encoding: "utf8", stdio: "inherit" });
if (test.status !== 0) process.exit(test.status || 1);
const packageTest = spawnSync(process.execPath, [path.join(root, "../tooling/scripts/verify-package.js")], { cwd: root, encoding: "utf8", stdio: "inherit" });
if (packageTest.status !== 0) process.exit(packageTest.status || 1);
if (process.argv.includes("--integration")) {
  for (const name of ["panel.cjs", "media.cjs"]) {
    const result = spawnSync(process.execPath, [path.join(root, "../tooling/tests", name)], {cwd:root,stdio:"inherit"});
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log(`PASS syntax ${javascript.length} files`);
console.log(`PASS manifest ${manifest.version} permission and asset closure`);
