#!/usr/bin/env node
/**
 * Reproducible build: bundles the entry points with esbuild and copies static
 * assets into `dist/proto-inspector-<version>`, which is the directory to load unpacked.
 */

import * as esbuild from "esbuild";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const outdir = path.join(root, "dist", `proto-inspector-${version}`);
const watch = process.argv.includes("--watch");

const ENTRIES = {
  "background/worker": "src/background/worker.ts",
  "devtools/devtools": "src/devtools/devtools.ts",
  "panel/panel": "src/panel/panel.ts",
};

const STATIC_FILES = [
  ["src/manifest.json", "manifest.json"],
  ["src/devtools/devtools.html", "devtools/devtools.html"],
  ["src/panel/panel.html", "panel/panel.html"],
  ["src/panel/panel.css", "panel/panel.css"],
];

const ICON_SIZES = [16, 48, 128];

async function copyStatic() {
  for (const [from, to] of STATIC_FILES) {
    const src = path.join(root, from);
    if (!existsSync(src)) throw new Error(`Missing static file: ${from}`);
    const dest = path.join(outdir, to);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }
  await mkdir(path.join(outdir, "icons"), { recursive: true });
  for (const size of ICON_SIZES) {
    await writeFile(path.join(outdir, "icons", `icon-${size}.png`), renderIcon(size));
  }
}

/* Minimal PNG writer so the build has no image tooling dependency. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}

function renderIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const scale = size / 16;
  const bg = [24, 26, 33, 255];
  const fg = [108, 222, 176, 255];
  const accent = [88, 148, 255, 255];
  const rect = (x, y, w, h, color) => {
    const x0 = Math.round(x * scale);
    const y0 = Math.round(y * scale);
    const x1 = Math.round((x + w) * scale);
    const y1 = Math.round((y + h) * scale);
    for (let yy = y0; yy < Math.min(y1, size); yy++) {
      for (let xx = x0; xx < Math.min(x1, size); xx++) {
        const i = (yy * size + xx) * 4;
        px[i] = color[0];
        px[i + 1] = color[1];
        px[i + 2] = color[2];
        px[i + 3] = color[3];
      }
    }
  };
  rect(0, 0, 16, 16, bg);
  rect(2, 5, 1, 6, accent);
  rect(3, 4, 1, 1, accent);
  rect(3, 11, 1, 1, accent);
  rect(13, 5, 1, 6, accent);
  rect(12, 4, 1, 1, accent);
  rect(12, 11, 1, 1, accent);
  rect(5, 5, 6, 1, fg);
  rect(5, 7.5, 5, 1, fg);
  rect(5, 10, 6, 1, fg);

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function checkManifest() {
  const manifest = JSON.parse(await readFile(path.join(root, "src/manifest.json"), "utf8"));
  const referenced = [
    manifest.devtools_page,
    manifest.background?.service_worker,
    ...Object.values(manifest.icons ?? {}),
  ].filter((value) => typeof value === "string");
  for (const file of referenced) {
    if (!existsSync(path.join(outdir, file))) {
      throw new Error(`manifest.json references a missing file: ${file}`);
    }
  }
}

async function run() {
  await rm(path.join(root, "dist"), { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await copyStatic();

  const options = {
    entryPoints: Object.fromEntries(
      Object.entries(ENTRIES).map(([out, src]) => [out, path.join(root, src)]),
    ),
    outdir,
    bundle: true,
    // IIFE keeps the panel and DevTools page valid as classic <script> bundles
    // and is equally valid for the module-type service worker.
    format: "iife",
    target: "chrome116",
    platform: "browser",
    sourcemap: true,
    minify: false,
    legalComments: "none",
    logLevel: "info",
    define: { "process.env.NODE_ENV": '"production"' },
  };

  if (watch) {
    const context = await esbuild.context(options);
    await context.watch();
    console.log("Watching for changes...");
    return;
  }

  await esbuild.build(options);
  await checkManifest();
  console.log(`Built extension into ${path.relative(process.cwd(), outdir)}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
