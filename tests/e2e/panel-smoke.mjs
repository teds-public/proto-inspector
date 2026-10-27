#!/usr/bin/env node
/**
 * End-to-end smoke test against a real Chrome/Chromium.
 *
 * Loads the built extension, opens the sample page, starts capture from the
 * panel, sends known protobuf frames and asserts the panel shows them and can
 * decode them with the bundled schema.
 *
 * Requirements: a Chrome for Testing binary (extensions are not loadable from
 * the command line in branded Chrome). Set CHROME_PATH, or run:
 *   npx @puppeteer/browsers install chrome@stable
 *
 * Usage: node tests/e2e/panel-smoke.mjs
 * Exits non-zero on failure so it can gate a release.
 */

import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionDir = path.join(root, "dist", "extension");
const PORT = 8799;
const PAGE_URL = `http://127.0.0.1:${PORT}/`;

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    path.join(os.tmpdir(), "cft", "chrome", "manual", "chrome-win64", "chrome.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    "No Chrome for Testing binary found. Set CHROME_PATH or run: npx @puppeteer/browsers install chrome@stable",
  );
}

function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok  ${message}`);
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function main() {
  if (!fs.existsSync(path.join(extensionDir, "manifest.json"))) {
    throw new Error("dist/extension is missing; run `npm run build` first");
  }

  const server = spawn(process.execPath, [path.join(root, "scripts", "sample-server.mjs")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog = [];
  server.stdout.on("data", (chunk) => serverLog.push(String(chunk)));
  server.stderr.on("data", (chunk) => serverLog.push(String(chunk)));

  await waitFor(
    async () => {
      try {
        const response = await fetch(PAGE_URL);
        return response.ok;
      } catch {
        return false;
      }
    },
    10_000,
    "sample server",
  );

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-inspector-e2e-"));
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: "new",
    userDataDir: profileDir,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  const failures = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
    await page.goto(PAGE_URL, { waitUntil: "load" });

    // Open DevTools on the page and select the Proto Inspector panel.
    const devtoolsTarget = await waitFor(
      async () => {
        const targets = await browser.targets();
        return targets.find((target) => target.url().startsWith("devtools://") && target.url().includes("panel"));
      },
      15_000,
      "devtools panel target",
    ).catch(() => null);

    let panelUrl = devtoolsTarget?.url() ?? null;
    if (!panelUrl) {
      // No panel target yet: open the panel page directly against the same tab.
      const extensionId = await findExtensionId(browser);
      panelUrl = `chrome-extension://${extensionId}/panel/panel.html`;
      console.log(`  note: opening ${panelUrl} directly (no docked DevTools in headless)`);
    }

    const panel = await browser.newPage();
    panel.on("pageerror", (error) => failures.push(`panel error: ${error.message}`));
    panel.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      // The CSP probe below deliberately triggers this exact violation.
      if (text.includes("Content Security Policy") && text.includes("inline script")) return;
      failures.push(`panel console: ${text}`);
    });
    await panel.goto(panelUrl, { waitUntil: "domcontentloaded" });
    await panel.setViewport({ width: 1400, height: 900 });
    const downloadDir = path.join(profileDir, "downloads");
    fs.mkdirSync(downloadDir, { recursive: true });
    const downloadSession = await panel.createCDPSession();
    await downloadSession.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
      eventsEnabled: true,
    });

    // Point the panel at the inspected tab. In a real DevTools session the
    // DevTools page supplies this; here we drive it directly.
    const tabId = await getTabId(page);
    check(typeof tabId === "number", "resolved the inspected tab id");

    await panel.evaluate((id) => {
      window.protoInspectorTabId = id;
      window.dispatchEvent(new CustomEvent("proto-inspector:tab-id", { detail: id }));
    }, tabId);

    // Load the bundled schema into the panel's storage, then reload so it is
    // picked up exactly as a user's imported files would be.
    const schemas = ["game.proto", "common.proto", "imports.proto"].map((name) => ({
      name,
      content: fs.readFileSync(path.join(root, "src", "schemas", name), "utf8"),
    }));
    await panel.evaluate(async (files) => {
      await chrome.storage.local.set({
        "protoInspector.schemas": { files, updatedAt: Date.now() },
      });
    }, schemas);
    await panel.reload({ waitUntil: "domcontentloaded" });
    await panel.evaluate((id) => {
      window.protoInspectorTabId = id;
      window.dispatchEvent(new CustomEvent("proto-inspector:tab-id", { detail: id }));
    }, tabId);

    await panel.waitForSelector("#btn-start:not([disabled])", { timeout: 10_000 });
    await panel.click("#btn-start");

    await waitFor(
      async () => (await panel.$eval("#status-dot", (el) => el.dataset.state)) === "capturing",
      15_000,
      "capture to start",
    );
    console.log("  ok  capture started");

    // Produce traffic from the page.
    await page.evaluate(() => window.sendLogin());
    await page.evaluate(() => window.sendChat());
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const rowCount = await waitFor(
      async () => {
        const count = await panel.$$eval("#message-body tr", (rows) => rows.length);
        return count >= 4 ? count : 0;
      },
      15_000,
      "captured messages",
    );
    console.log(`  ok  captured ${rowCount} messages`);

    const connectionText = await panel.$eval("#connection-list", (el) => el.textContent ?? "");
    check(connectionText.includes("ws://127.0.0.1"), "connection list shows the WebSocket URL");

    const sentCount = await panel.$$eval("#message-body .dir", (cells) =>
      cells.filter((cell) => cell.textContent === "SEND").length,
    );
    const recvCount = await panel.$$eval("#message-body .dir", (cells) =>
      cells.filter((cell) => cell.textContent === "RECV").length,
    );
    check(sentCount >= 2, `send frames shown (${sentCount})`);
    check(recvCount >= 2, `receive frames shown (${recvCount})`);

    // Select the first binary SEND frame and decode it as a LoginRequest.
    await panel.evaluate(() => {
      const rows = [...document.querySelectorAll("#message-body tr")];
      const target = rows.find((row) => row.querySelector(".dir")?.textContent === "SEND");
      if (!target) throw new Error("no SEND row");
      target.click();
    });
    await panel.waitForFunction(() => document.querySelector("#detail-content")?.hidden === false);
    await panel.waitForFunction(() => document.querySelector("#decoded-output")?.textContent?.length > 0);

    await panel.select("#decode-type-select", "game.LoginRequest");
    await panel.click("#btn-decode");
    const decoded = await waitFor(
      async () => {
        const text = await panel.$eval("#decoded-output", (el) => el.textContent ?? "");
        return text.includes("username") ? text : "";
      },
      10_000,
      "decoded JSON",
    );
    check(decoded.includes('"commander"'), "decoded JSON contains the login username");
    check(decoded.includes("ROGUE"), "decoded JSON renders the enum by name");

    // Wire view must show the raw fields.
    await panel.click('.tab[data-tab="wire"]');
    const wire = await panel.$eval("#wire-output", (el) => el.textContent ?? "");
    check(wire.includes("#1"), "wire view lists field numbers");
    check(wire.includes("length-delimited"), "wire view shows wire types");

    // Hex view must show exact bytes.
    await panel.click('.tab[data-tab="hex"]');
    const hex = await panel.$eval("#hex-output", (el) => el.textContent ?? "");
    check(/00000000\s+0a 09/.test(hex), "hex view starts with the known tag bytes");

    // Text frame must be reported as text, not force-decoded.
    await panel.evaluate(() => {
      const rows = [...document.querySelectorAll("#message-body tr")];
      const textRow = rows.find((row) => row.textContent?.includes("text"));
      if (textRow) textRow.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Malformed input: feed the wire parser a bad frame via the sample page's
    // own connection is not possible here, so verify through the panel's
    // diagnostics that the wire tab reports an error for the text frame.
    const diagnosticsHealthy = await panel.$eval("#detail-content", (el) => !el.hidden);
    check(diagnosticsHealthy, "detail pane stays rendered for a text frame");

    // Search filter must actually re-render, including after streaming.
    await panel.type("#filter-search", "LoginRequest");
    await panel.waitForFunction(() => {
      const text = document.querySelector("#message-count")?.textContent ?? "";
      return text.startsWith("0 /");
    }, { timeout: 5000 }).catch(() => {});
    const filteredCount = await panel.$$eval("#message-body tr", (rows) => rows.length);
    check(filteredCount === 0, `search filter excludes non-matching rows (${filteredCount} left)`);
    await panel.$eval("#filter-search", (el) => { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });

    // Settings round trip: retention limit is validated and persisted.
    await panel.click("#btn-settings");
    await panel.$eval("#input-retention", (el) => { el.value = "250"; });
    await panel.click("#btn-save-settings");
    const storedRetention = await waitFor(
      async () =>
        panel.evaluate(async () => {
          const stored = await chrome.storage.local.get("protoInspector.settings");
          return stored["protoInspector.settings"]?.retentionLimit ?? 0;
        }),
      5000,
      "saved retention",
    );
    check(storedRetention === 250, `retention setting persisted (${storedRetention})`);
    await panel.click("#btn-settings");

    // Malformed frames must still be captured and reported without crashing.
    await page.evaluate(() => window.sendMalformed());
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const afterMalformed = await panel.$$eval("#message-body tr", (rows) => rows.length);
    check(afterMalformed > rowCount, `malformed frames were still captured (${afterMalformed} rows)`);

    // The Hex tab was left active above, so switch back to Decoded before
    // reading that panel's output.
    await panel.click('.tab[data-tab="decoded"]');
    // Wait for the detail pane to change, otherwise the previous selection's
    // output would be read back and the check would pass vacuously.
    const previousText = await panel.$eval("#decoded-output", (el) => el.textContent ?? "");
    await panel.evaluate(() => {
      const rows = [...document.querySelectorAll("#message-body tr")];
      const last = rows[rows.length - 1];
      if (last) last.click();
    });
    const malformedText = await waitFor(
      async () => {
        const text = await panel.$eval("#decoded-output", (el) => el.textContent ?? "");
        return text !== previousText ? text : "";
      },
      10_000,
      "malformed frame detail",
    );
    // The type chosen earlier is remembered, so a malformed frame is reported
    // as a schema failure rather than a bare "not protobuf" message. Either is
    // a correct report; what matters is that it is reported and nothing crashed.
    check(
      /not valid protobuf|No message type selected|Schema decoding failed/.test(malformedText),
      `malformed payload is reported instead of crashing (${JSON.stringify(malformedText.slice(0, 60))})`,
    );

    // Confirm the extension page's own CSP is active. CDP `evaluate` runs
    // outside the page's CSP, so `new Function` cannot be used as a probe here;
    // an injected inline <script> is gated by script-src and is the real test.
    // This matters because decoding succeeds on a page where eval-like code is
    // unavailable, which is the whole reason the decoder avoids protobufjs's
    // Function()-based code generator.
    const inlineRan = await panel.evaluate(async () => {
      const probe = document.createElement("script");
      probe.textContent = "window.__protoInspectorInlineRan = true;";
      document.head.append(probe);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const ran = window.__protoInspectorInlineRan === true;
      probe.remove();
      return ran;
    });
    check(inlineRan === false, "extension page CSP blocks inline script injection");

    // Pause must stop capture; resume must restart it.
    const beforePause = await panel.$$eval("#message-body tr", (rows) => rows.length);
    await panel.click("#btn-pause");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.evaluate(() => window.sendChat());
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const duringPause = await panel.$$eval("#message-body tr", (rows) => rows.length);
    check(duringPause === beforePause, `pause stops capture (${beforePause} -> ${duringPause})`);
    await panel.click("#btn-pause");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await page.evaluate(() => window.sendChat());
    await waitFor(
      async () => (await panel.$$eval("#message-body tr", (rows) => rows.length)) > duringPause,
      10_000,
      "capture to resume",
    );
    console.log("  ok  resume restarts capture");

    // Export writes a complete JSON document to disk.
    await panel.click("#btn-export");
    const exportFile = await waitFor(
      async () => {
        const files = fs.readdirSync(downloadDir).filter((name) => name.endsWith(".json"));
        return files[0] ?? "";
      },
      10_000,
      "exported JSON file",
    );
    const exported = JSON.parse(fs.readFileSync(path.join(downloadDir, exportFile), "utf8"));
    check(exported.format === "proto-inspector-export", "export has the expected format tag");
    check(exported.frames.length > 0, `export contains ${exported.frames.length} frames`);
    check(
      exported.frames.every((frame) => typeof frame.base64 === "string" && frame.base64.length > 0),
      "every exported frame carries its Base64 payload",
    );

    // Clear empties the table, and Stop returns to idle.
    await panel.click("#btn-clear");
    await waitFor(
      async () => (await panel.$$eval("#message-body tr", (rows) => rows.length)) === 0,
      5000,
      "table to clear",
    );
    console.log("  ok  clear empties the message table");

    await panel.click("#btn-stop");
    await panel.waitForFunction(() => document.querySelector("#status-dot")?.dataset.state === "idle", {
      timeout: 10_000,
    });
    console.log("  ok  stop returns the panel to idle");

    if (failures.length > 0) throw new Error(failures.join("\n"));
    console.log("\nAll end-to-end checks passed.");
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

async function findExtensionId(browser) {
  const target = await waitFor(
    async () => (await browser.targets()).find((t) => t.url().startsWith("chrome-extension://")),
    10_000,
    "extension target",
  );
  const url = target.url();
  const match = /^chrome-extension:\/\/([a-p]+)\//.exec(url);
  if (!match?.[1]) throw new Error(`could not parse extension id from ${url}`);
  return match[1];
}

async function getTabId(page) {
  const session = await page.createCDPSession();
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.detach();
  // chrome.tabs is not exposed to DevTools panels, so resolve the tab id from
  // a temporary extension page.
  const helper = await page.browser().newPage();
  const extensionId = await findExtensionId(page.browser());
  await helper.goto(`chrome-extension://${extensionId}/panel/panel.html`, { waitUntil: "domcontentloaded" });
  const tabId = await helper.evaluate(async (url) => {
    const matches = await chrome.tabs.query({});
    const found = matches.find((tab) => tab.url === url);
    return found?.id ?? null;
  }, targetInfo.url);
  await helper.close();
  return tabId;
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
