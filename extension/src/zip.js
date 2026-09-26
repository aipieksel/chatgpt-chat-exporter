(function initializeZip(global) {
  "use strict";

  const api = global.ChatGPTExporter = global.ChatGPTExporter || {};
  const encoder = new TextEncoder();
  const CRC_TABLE = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    CRC_TABLE[index] = value >>> 0;
  }

  function zipCrc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function writeU16(view, offset, value) { view.setUint16(offset, value, true); }
  function writeU32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

  function concat(parts, total) {
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.length; }
    return output;
  }

  function normalizeEntry(entry) {
    if (!entry || typeof entry.path !== "string" || !entry.path || entry.path.startsWith("/") || entry.path.includes("\\") || entry.path.split("/").includes("..")) {
      throw new api.ExportError(api.ERROR_CODES.UNSAFE_PATH, "ZIP entry path is unsafe.");
    }
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data || []);
    return { path: entry.path, name: encoder.encode(entry.path), data, crc: zipCrc32(data) };
  }

  function createZipBytes(rawEntries, modifiedAt = new Date()) {
    const date = new Date(modifiedAt);
    if (Number.isNaN(date.getTime())) throw new Error("Invalid ZIP modification date.");
    const year = Math.max(1980, Math.min(2107, date.getFullYear()));
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    if (!Array.isArray(rawEntries) || !rawEntries.length || rawEntries.length > api.LIMITS.maxMediaEntries + 2) {
      throw new api.ExportError(api.ERROR_CODES.ZIP_INVALID, "ZIP entry count is invalid.");
    }
    const entries = rawEntries.map(normalizeEntry);
    const paths = new Set();
    let inputBytes = 0;
    for (const entry of entries) {
      const key = entry.path.toLocaleLowerCase("en-US");
      if (paths.has(key)) throw new api.ExportError(api.ERROR_CODES.ZIP_INVALID, `Duplicate ZIP path: ${entry.path}.`);
      paths.add(key);
      inputBytes += entry.data.length;
    }
    if (inputBytes > api.LIMITS.maxArchiveInputBytes) throw new api.ExportError(api.ERROR_CODES.ARCHIVE_LIMIT_EXCEEDED, "Archive input exceeds 250 MiB.", { bytes: inputBytes });

    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    for (const entry of entries) {
      const local = new Uint8Array(30 + entry.name.length);
      const localView = new DataView(local.buffer);
      writeU32(localView, 0, 0x04034b50);
      writeU16(localView, 4, 20);
      writeU16(localView, 6, 0x0800);
      writeU16(localView, 8, 0);
      writeU16(localView, 10, dosTime);
      writeU16(localView, 12, dosDate);
      writeU32(localView, 14, entry.crc);
      writeU32(localView, 18, entry.data.length);
      writeU32(localView, 22, entry.data.length);
      writeU16(localView, 26, entry.name.length);
      local.set(entry.name, 30);
      localParts.push(local, entry.data);

      const central = new Uint8Array(46 + entry.name.length);
      const centralView = new DataView(central.buffer);
      writeU32(centralView, 0, 0x02014b50);
      writeU16(centralView, 4, 20);
      writeU16(centralView, 6, 20);
      writeU16(centralView, 8, 0x0800);
      writeU16(centralView, 10, 0);
      writeU16(centralView, 12, dosTime);
      writeU16(centralView, 14, dosDate);
      writeU32(centralView, 16, entry.crc);
      writeU32(centralView, 20, entry.data.length);
      writeU32(centralView, 24, entry.data.length);
      writeU16(centralView, 28, entry.name.length);
      writeU32(centralView, 42, localOffset);
      central.set(entry.name, 46);
      centralParts.push(central);
      localOffset += local.length + entry.data.length;
    }
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    writeU32(endView, 0, 0x06054b50);
    writeU16(endView, 8, entries.length);
    writeU16(endView, 10, entries.length);
    writeU32(endView, 12, centralSize);
    writeU32(endView, 16, localOffset);
    return concat([...localParts, ...centralParts, end], localOffset + centralSize + end.length);
  }

  function createZipBlob(entries) {
    return new Blob([createZipBytes(entries)], { type: "application/zip" });
  }

  api.createZipBlob = createZipBlob;
  api.createZipBytes = createZipBytes;
  api.zipCrc32 = zipCrc32;
})(globalThis);
