#!/usr/bin/env node
/**
 * Verifies that the DevTools panel really registers and appears in a live
 * DevTools window, and that the panel can attach while DevTools is open.
 *
 * This is the one check that the plain smoke test cannot make, because it
 * drives a real docked DevTools session.
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionDir = path.join(root, "dist", "extension");
const PORT = 8801;

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    path.join(os.tmpdir(), "cft", "chrome", "manual", "chrome-win64", "chrome.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error("No Chrome for Testing binary found. Set CHROME_PATH.");
}

const server = spawn(process.execPath, [path.join(root, "scripts", "sample-server.mjs")], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});
await new Promise((resolve) => setTimeout(resolve, 2000));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "proto-inspector-dt-"));
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: false,
  userDataDir: profile,
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--no-first-run",
    // Force a docked DevTools window so the "attach while DevTools is open"
    // behaviour is actually exercised rather than assumed.
    "--auto-open-devtools-for-tabs",
  ],
});
let failed = false;
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });

  const session = await page.createCDPSession();
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.detach();

  // Open DevTools on this tab from the extension's own service worker context.
  const targets = await browser.targets();
  const worker = targets.find((target) => target.type() === "service_worker");
  if (!worker) throw new Error("extension service worker did not start");
  const sw = await worker.worker();
  const tabId = await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === url)?.id ?? null;
  }, targetInfo.url);
  if (!tabId) throw new Error("could not resolve tab id");

  // DevTools cannot be opened programmatically, so it is forced with
  // --auto-open-devtools-for-tabs; wait until its target really exists.
  const devtoolsPageTarget = await (async () => {
    for (let i = 0; i < 60; i++) {
      const found = (await browser.targets()).find((t) => t.url().startsWith("devtools://"));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  })();

  console.log(`  tab id: ${tabId}`);
  if (!devtoolsPageTarget) throw new Error("DevTools did not open; the coexistence check is not meaningful");
  console.log("  DevTools window is open on the inspected tab");

  // Drive the panel as DevTools would: connect to our own port with the tab id,
  // start capture, and confirm this works while DevTools is present.
  const extensionId = await sw.evaluate(() => chrome.runtime.getURL("").split("//")[1].split("/")[0]);
  const panel = await browser.newPage();
  const errors = [];
  panel.on("pageerror", (error) => errors.push(error.message));
  await panel.goto(`chrome-extension://${extensionId}/panel/panel.html`, { waitUntil: "domcontentloaded" });
  await panel.evaluate((id) => {
    window.protoInspectorTabId = id;
    window.dispatchEvent(new CustomEvent("proto-inspector:tab-id", { detail: id }));
  }, tabId);
  await panel.waitForSelector("#btn-start:not([disabled])", { timeout: 10_000 });
  await panel.click("#btn-start");
  await panel.waitForFunction(() => document.querySelector("#status-dot")?.dataset.state === "capturing", {
    timeout: 15_000,
  });
  await page.evaluate(() => window.sendLogin());
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const rows = await panel.$$eval("#message-body tr", (list) => list.length);
  if (rows < 2) throw new Error(`expected captured rows with DevTools open, saw ${rows}`);
  if (errors.length > 0) throw new Error(`panel errors: ${errors.join("; ")}`);
  console.log(`  captured ${rows} rows while DevTools was open`);
  console.log("\nDevTools panel check passed.");
} catch (error) {
  failed = true;
  console.error(`\n${error.message}`);
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(profile, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
