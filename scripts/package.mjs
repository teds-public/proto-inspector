#!/usr/bin/env node
/**
 * Zips dist/extension into dist/proto-inspector-<version>.zip using a small,
 * dependency-free ZIP writer (deflate via node:zlib).
 */

import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync, crc32 as zlibCrc32 } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "dist", "extension");
const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
const target = path.join(root, "dist", `proto-inspector-${manifest.version}.zip`);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  if (typeof zlibCrc32 === "function") return zlibCrc32(buffer) >>> 0;
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

async function collect(dir, prefix = "") {
  const entries = [];
  for (const name of (await readdir(dir)).sort()) {
    const full = path.join(dir, name);
    const info = await stat(full);
    const archivePath = prefix ? `${prefix}/${name}` : name;
    if (info.isDirectory()) entries.push(...(await collect(full, archivePath)));
    else entries.push({ path: archivePath, full, mtime: info.mtime });
  }
  return entries;
}

/** Fixed timestamp keeps the archive byte-reproducible across builds. */
const FIXED_DATE = new Date(2020, 0, 1, 0, 0, 0);
const { time: dosTime, date: dosDate } = dosDateTime(FIXED_DATE);

const entries = await collect(source);
const locals = [];
const centrals = [];
let offset = 0;

for (const entry of entries) {
  const content = await readFile(entry.full);
  const compressed = deflateRawSync(content, { level: 9 });
  const useDeflate = compressed.length < content.length;
  const data = useDeflate ? compressed : content;
  const nameBytes = Buffer.from(entry.path.split(path.sep).join("/"), "utf8");
  const checksum = crc32(content);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x0800, 6);
  localHeader.writeUInt16LE(useDeflate ? 8 : 0, 8);
  localHeader.writeUInt16LE(dosTime, 10);
  localHeader.writeUInt16LE(dosDate, 12);
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(data.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(useDeflate ? 8 : 0, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);

  locals.push(localHeader, nameBytes, data);
  centrals.push(central, nameBytes);
  offset += localHeader.length + nameBytes.length + data.length;
}

const centralSize = centrals.reduce((total, buffer) => total + buffer.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, Buffer.concat([...locals, ...centrals, end]));
console.log(`Packaged ${entries.length} files into ${path.relative(root, target)}`);
