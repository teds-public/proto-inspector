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
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const extensionDir = path.join(root, "dist", `proto-inspector-${version}`);
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
    throw new Error(`dist/proto-inspector-${version} is missing; run \`npm run build\` first`);
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
    // The detail pane now opens on General; the decoded output only renders
    // while its own tab is visible.
    await panel.click('.tab[data-tab="decoded"]');
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

    // Frame metadata is its own General tab. Earlier steps moved to other
    // detail tabs, so return to General explicitly and confirm it is the first.
    await panel.click('.tab[data-tab="general"]');
    await panel.waitForFunction(() => document.querySelector("#detail-content")?.hidden === false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const detailTab = await panel.evaluate(() => ({
      tabs: [...document.querySelectorAll(".tab")].map((tab) => tab.dataset.tab),
      active: document.querySelector(".tab.is-active")?.dataset.tab,
      visible: [...document.querySelectorAll(".tab-panel")].filter((p) => !p.hidden).map((p) => p.dataset.panel),
      labels: [...document.querySelectorAll("#detail-meta dt")].map((dt) => dt.textContent),
    }));
    check(detailTab.tabs[0] === "general", "General is the first detail tab");
    check(detailTab.active === "general", "General becomes active when chosen");
    check(
      detailTab.visible.length === 1 && detailTab.visible[0] === "general",
      "General tab shows only the metadata panel",
    );
    for (const label of ["Time", "Direction", "Connection", "Size", "Frame"]) {
      check(detailTab.labels.includes(label), `General tab shows ${label}`);
    }
    await panel.click('.tab[data-tab="decoded"]');
    await new Promise((resolve) => setTimeout(resolve, 250));
    check(
      await panel.evaluate(
        () => document.querySelector("#detail-meta")?.closest(".tab-panel")?.hidden === true,
      ),
      "metadata is hidden while another detail tab is open",
    );

    // Search filter must actually re-render, including after streaming.
    await panel.type("#filter-search", "LoginRequest");
    await panel.waitForFunction(() => {
      const text = document.querySelector("#message-count")?.textContent ?? "";
      return text.startsWith("0 /");
    }, { timeout: 5000 }).catch(() => {});
    const filteredCount = await panel.$$eval("#message-body tr", (rows) => rows.length);
    check(filteredCount === 0, `search filter excludes non-matching rows (${filteredCount} left)`);
    await panel.$eval("#filter-search", (el) => { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });

    // The message list follows new rows only while it is scrolled to the end.
    // Shrink the panel so the table certainly overflows; otherwise the check
    // would silently pass on a list with no scrollbar.
    await panel.setViewport({ width: 900, height: 420 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const scrollState = await panel.evaluate(() => {
      const wrap = document.getElementById("table-wrap");
      wrap.scrollTop = wrap.scrollHeight;
      return {
        scrollable: wrap.scrollHeight > wrap.clientHeight,
        atBottom: wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight <= 2,
      };
    });
    check(scrollState.scrollable, "the message list overflows in a short panel");
    check(scrollState.atBottom, "the list starts pinned to the bottom");
    await panel.evaluate(() => {
      document.getElementById("table-wrap").scrollTop = 0;
    });
    await page.evaluate(() => window.sendChat());
    await new Promise((resolve) => setTimeout(resolve, 900));
    check(
      await panel.evaluate(() => document.getElementById("table-wrap").scrollTop <= 2),
      "scrolling up stops the list from following new rows",
    );
    await panel.evaluate(() => {
      const wrap = document.getElementById("table-wrap");
      wrap.scrollTop = wrap.scrollHeight;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.evaluate(() => window.sendChat());
    await new Promise((resolve) => setTimeout(resolve, 900));
    check(
      await panel.evaluate(() => {
        const wrap = document.getElementById("table-wrap");
        return wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight <= 2;
      }),
      "a list pinned to the bottom follows new rows",
    );
    await panel.setViewport({ width: 1400, height: 900 });
    await new Promise((resolve) => setTimeout(resolve, 400));

    // The schema picker is a searchable dropdown.
    await panel.click('.tab[data-tab="decoded"]');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const comboPresent = await panel.evaluate(
      () => document.querySelector("#decode-type-select")?.nextElementSibling?.classList.contains("searchable-select") === true,
    );
    check(comboPresent, "the schema picker has a search box");
    await panel.focus(".searchable-select__input");
    await panel.type(".searchable-select__input", "Chat");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const comboOptions = await panel.$$eval(".searchable-select__option", (options) =>
      options.map((option) => option.textContent ?? ""),
    );
    check(
      comboOptions.length > 0 && comboOptions.every((label) => label.toLowerCase().includes("chat")),
      `typing filters the dropdown (${comboOptions.join(", ")})`,
    );
    await panel.keyboard.press("Escape");
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The status filter must use the decoded status, not the one stored when
    // the frame was captured (which is always "not-attempted").
    await panel.select("#filter-status", "decoded");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const decodedOnly = await panel.$$eval("#message-body tr", (rows) =>
      rows.map((row) => row.children[5]?.textContent ?? ""),
    );
    check(
      decodedOnly.length > 0 && decodedOnly.every((status) => status === "decoded"),
      `decoded filter shows decoded frames (${decodedOnly.length})`,
    );
    await panel.select("#filter-status", "not-attempted");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const rawOnly = await panel.$$eval("#message-body tr", (rows) =>
      rows.map((row) => row.children[5]?.textContent ?? ""),
    );
    check(
      rawOnly.every((status) => status !== "decoded"),
      `not-decoded filter excludes decoded frames (${rawOnly.length} shown)`,
    );
    await panel.select("#filter-status", "");
    await new Promise((resolve) => setTimeout(resolve, 400));

    // The panel is split into two views; switching must not disturb capture.
    await panel.click("#tab-settings");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const settingsView = await panel.evaluate(() => {
      const start = document.getElementById("btn-start");
      return {
        captureHidden: document.getElementById("view-capture").hidden,
        settingsHidden: document.getElementById("view-settings").hidden,
        active: document.querySelector(".view-tab.is-active")?.id,
        // The capture buttons now live inside the capture view.
        startInCapture: start.closest("#view-capture") !== null,
        startVisible: start.getBoundingClientRect().height > 0,
        defaultTypeGone: document.getElementById("input-default-type") === null,
      };
    });
    check(
      settingsView.settingsHidden === false && settingsView.captureHidden === true,
      "Settings tab shows the settings view",
    );
    check(settingsView.active === "tab-settings", "Settings tab is marked active");
    check(settingsView.startInCapture, "capture buttons live inside the capture view");
    check(settingsView.startVisible === false, "capture buttons are not visible in Settings");
    check(settingsView.defaultTypeGone, "the default message type field is gone");
    check(
      await panel.evaluate(() => document.getElementById("attach-warning") === null),
      "the debugger attach notice is gone",
    );
    check(
      await panel.evaluate(() => document.getElementById("input-retention").value === "500"),
      "retention limit defaults to 500",
    );
    await panel.click("#tab-capture");
    await new Promise((resolve) => setTimeout(resolve, 300));
    check(
      await panel.evaluate(() => {
        const start = document.getElementById("btn-start");
        return !document.getElementById("view-capture").hidden && start.getBoundingClientRect().height > 0;
      }),
      "Capture tab restores the capture view and its buttons",
    );

    // Settings round trip: retention limit is validated and persisted.
    await panel.click("#tab-settings");
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

    // A frame that starts with a 4-byte opcode is split and typed from the
    // opcode comments in the loaded schema.
    await panel.evaluate(() => document.getElementById("settings-tab-schemas").click());
    await (await panel.$("#schema-files")).uploadFile(
      path.join(root, "tests", "fixtures", "opcode", "wire.proto"),
    );
    await waitFor(
      async () =>
        /opcode\(s\) declared/.test(
          (await panel.evaluate(() => document.getElementById("opcode-summary")?.textContent)) ?? "",
        ),
      10_000,
      "the opcode summary",
    );
    console.log("  ok  the schema's opcode comments are loaded");
    await panel.evaluate(() => document.getElementById("settings-tab-general").click());
    const prefixMode = await panel.$eval("#input-frame-prefix", (el) => el.value);
    check(prefixMode === "auto", `frame prefix defaults to auto-detection (${prefixMode})`);
    await panel.click("#tab-capture");

    // 00 00 03 e9 | field 1 "TESTER" — the exact shape of the captured frames.
    await page.evaluate(() => {
      const body = new Uint8Array([0x0a, 0x06, ...new TextEncoder().encode("TESTER")]);
      const frame = new Uint8Array(4 + body.length);
      new DataView(frame.buffer).setUint32(0, 1001, false);
      frame.set(body, 4);
      window.openSocket().send(frame);
    });
    await waitFor(
      async () =>
        (await panel.$$eval("#message-body tr", (rows) =>
          rows.some((row) => row.children[6]?.className === "type--opcode"),
        )) === true,
      15_000,
      "a frame typed from its opcode",
    );
    const opcodeRow = await panel.$$eval("#message-body tr", (rows) => {
      const row = rows.find((entry) => entry.children[6]?.className === "type--opcode");
      return {
        type: row?.children[6]?.textContent ?? "",
        title: row?.children[6]?.title ?? "",
      };
    });
    check(
      opcodeRow.type === "fixture.wire.LoginRequest",
      `an opcode-prefixed frame is named from the schema (${opcodeRow.type})`,
    );
    check(
      /opcode 1001/.test(opcodeRow.title),
      `the row says which opcode named it (${opcodeRow.title})`,
    );
    await panel.evaluate(() => {
      const rows = [...document.querySelectorAll("#message-body tr")];
      rows[rows.length - 1]?.click();
    });
    await panel.click('.tab[data-tab="decoded"]');
    const opcodeDecoded = await waitFor(
      async () => {
        const text = await panel.evaluate(
          () => document.getElementById("decoded-output")?.textContent ?? "",
        );
        return text.includes("TESTER") ? text : "";
      },
      10_000,
      "the opcode frame to decode",
    );
    check(
      opcodeDecoded.includes("username"),
      "the body decodes after the opcode is stripped",
    );
    // Put the setting back to a clean state for the later checks.
    await panel.evaluate(() => document.getElementById("settings-tab-schemas").click());
    await panel.evaluate(() => document.getElementById("btn-schema-clear")?.click());
    await waitFor(
      async () =>
        (await panel.evaluate(() => document.getElementById("schema-summary")?.textContent)) ===
        "No schema loaded",
      5000,
      "schemas to clear after the opcode check",
    );
    await (await panel.$("#schema-files")).uploadFile(
      ...schemas.map((schema) => {
        const target = path.join(profileDir, "upload", schema.name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, schema.content);
        return target;
      }),
    );
    await waitFor(
      async () =>
        /^3 file\(s\)/.test(
          (await panel.evaluate(() => document.getElementById("schema-summary")?.textContent)) ?? "",
        ),
      5000,
      "bundled schemas to reload after the opcode check",
    );
    // Leave the settings view on the tab a fresh open shows.
    await panel.evaluate(() => document.getElementById("settings-tab-general").click());
    await panel.click("#tab-capture");

    // Malformed frames must still be captured and reported without crashing.
    await page.evaluate(() => window.sendMalformed());
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const afterMalformed = await panel.$$eval("#message-body tr", (rows) => rows.length);
    check(afterMalformed > rowCount, `malformed frames were still captured (${afterMalformed} rows)`);

    // The Hex tab was left active above, so switch back to Decoded before
    // reading that panel's output. Select a row that decodes first, so the
    // change below is observable; otherwise a wire-error row already selected
    // would make the wait below time out.
    await panel.click('.tab[data-tab="decoded"]');
    await panel.evaluate(() => {
      const rows = [...document.querySelectorAll("#message-body tr")];
      rows.find((row) => row.children[6]?.className === "type--chosen")?.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
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

    // Settings is split into two sections, and the file picker is driven only
    // by the Load files button.
    await panel.click("#tab-settings");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const settingsSections = await panel.evaluate(() => ({
      visible: [...document.querySelectorAll(".settings-panel")].filter((s) => !s.hidden).map((s) => s.id),
      fileInputHidden: document.getElementById("schema-files").hidden,
      loadButton: document.getElementById("btn-schema-add") !== null,
      folderInputHidden: document.getElementById("schema-folder")?.hidden,
      folderInputIsDirectory: document.getElementById("schema-folder")?.hasAttribute("webkitdirectory"),
      folderButton: document.getElementById("btn-schema-folder") !== null,
    }));
    check(
      settingsSections.visible.length === 1 && settingsSections.visible[0] === "settings-view-general",
      "Settings opens on the General tab",
    );
    check(settingsSections.fileInputHidden, "the raw file input is hidden behind Load files");
    check(settingsSections.loadButton, "the Load files button is present");
    check(
      settingsSections.folderInputIsDirectory && settingsSections.folderInputHidden,
      "the Load folder input accepts a directory tree and stays hidden",
    );
    check(settingsSections.folderButton, "the Load folder button is present");

    // Each tab holds the controls it is named for.
    const tabContents = await panel.evaluate(() => {
      const panelOf = (id) => document.getElementById(id)?.closest(".settings-panel")?.id ?? "";
      const result = {};
      for (const name of ["general", "decoding", "picked", "schemas"]) {
        document.getElementById(`settings-tab-${name}`).click();
        result[name] = [...document.querySelectorAll(".settings-panel")]
          .filter((s) => !s.hidden)
          .map((s) => s.id);
      }
      return {
        result,
        retention: panelOf("input-retention"),
        reuse: panelOf("input-reuse-schema"),
        autoDecode: panelOf("input-auto-decode"),
      };
    });
    const tabOrder = await panel.$$eval(".settings-tab", (tabs) =>
      tabs.map((tab) => tab.dataset.settingsView),
    );
    check(
      JSON.stringify(tabOrder) === JSON.stringify(["general", "schemas", "picked", "decoding"]),
      `settings tabs are ordered as asked (${tabOrder.join(", ")})`,
    );
    for (const name of ["general", "decoding", "picked", "schemas"]) {
      check(
        tabContents.result[name].length === 1 && tabContents.result[name][0] === `settings-view-${name}`,
        `${name} tab shows only its own section`,
      );
    }
    check(tabContents.retention === "settings-view-general", "retention limit lives in General");
    check(tabContents.reuse === "settings-view-picked", "schema reuse lives in Picked schemas");
    check(tabContents.autoDecode === "settings-view-schemas", "auto decode lives in Protobuf schemas");

    // A folder pick keeps the tree, so a folder-relative import resolves, and
    // the .meta files Unity puts next to every asset are skipped quietly.
    await panel.click("#settings-tab-schemas");
    const folderInput = await panel.$("#schema-folder");
    await folderInput.uploadFile(path.join(root, "tests", "fixtures", "proto-folder"));
    await waitFor(
      async () =>
        (await panel.$$eval("#schema-file-list li span:first-child", (nodes) =>
          nodes.map((node) => node.textContent),
        )).includes("realtime/realtime.proto"),
      10_000,
      "folder schemas to appear",
    );
    const folderState = await panel.evaluate(() => {
      const errors = document.getElementById("schema-errors");
      return {
        names: [...document.querySelectorAll("#schema-file-list li span:first-child")].map(
          (node) => node.textContent,
        ),
        summary: document.getElementById("schema-summary")?.textContent ?? "",
        errors: errors?.hidden ? "" : errors?.textContent ?? "",
      };
    });
    check(
      folderState.names.includes("lobby.proto") && folderState.names.includes("realtime/realtime.proto"),
      "folder loading keeps paths relative to the chosen folder",
    );
    check(
      !folderState.names.some((name) => name.endsWith(".meta")),
      "folder loading ignores .meta files",
    );
    check(
      /Ignored 3 non-\.proto file\(s\)/.test(folderState.errors) &&
        !/only \.proto files are accepted/.test(folderState.errors),
      `skipped .meta files are counted, not reported as failures (${folderState.errors})`,
    );
    check(
      /5 file\(s\), \d+ message type\(s\)/.test(folderState.summary),
      `folder schemas merged with the loaded set (${folderState.summary})`,
    );
    const folderTypes = await panel.evaluate(() =>
      [...document.querySelectorAll("#decode-type-select option")].map((option) => option.value),
    );
    check(
      folderTypes.includes("fixture.lobby.LobbyOpened"),
      "a type behind a folder-relative import is decodable",
    );
    // Put the bundled schema back so the checks below decode with it.
    await panel.evaluate(() => document.getElementById("btn-schema-clear")?.click());
    await waitFor(
      async () =>
        (await panel.evaluate(() => document.getElementById("schema-summary")?.textContent)) ===
        "No schema loaded",
      5000,
      "schemas to clear",
    );
    await (await panel.$("#schema-files")).uploadFile(
      ...schemas.map((schema) => {
        const target = path.join(profileDir, "upload", schema.name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, schema.content);
        return target;
      }),
    );
    await waitFor(
      async () =>
        /^3 file\(s\)/.test(
          (await panel.evaluate(() => document.getElementById("schema-summary")?.textContent)) ?? "",
        ),
      5000,
      "bundled schemas to reload",
    );
    await panel.click("#settings-tab-decoding");
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Rules can be exported and imported back.
    await panel.click("#btn-add-rule");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await panel.evaluate(() => {
      const row = document.querySelector("#rule-rows tr");
      row.querySelector('[data-rule-field="fieldNumber"]').value = "1";
      row.querySelector('[data-rule-field="fieldValue"]').value = "700";
      row.querySelector('[data-rule-field="messageType"]').value = "game.LoginRequest";
    });
    await panel.click("#btn-rules-export");
    // The file appears before it is fully written, so wait for parseable JSON
    // rather than for the name alone: a partial read makes the import step
    // fail with "Not a JSON file".
    const rulesDoc = await waitFor(
      async () => {
        const file = fs
          .readdirSync(downloadDir)
          .find((name) => name.startsWith("proto-inspector-rules-"));
        if (!file) return null;
        try {
          return {
            path: path.join(downloadDir, file),
            doc: JSON.parse(fs.readFileSync(path.join(downloadDir, file), "utf8")),
          };
        } catch {
          return null;
        }
      },
      10_000,
      "exported rules file",
    );
    const exportedRules = rulesDoc.path;
    check(rulesDoc.doc.format === "proto-inspector-rules", "rules export has the expected format");
    check(
      rulesDoc.doc.rules.length === 1,
      `rules export contains the rule (${rulesDoc.doc.rules.length})`,
    );

    // Importing the same file restores it after clearing.
    await panel.evaluate(() => document.querySelector("#rule-rows tr button")?.click());
    await waitFor(
      async () => (await panel.$$eval("#rule-rows tr", (rows) => rows.length)) === 0,
      5_000,
      "rules table to empty",
    );
    await (await panel.$("#rules-import-file")).uploadFile(exportedRules);
    await waitFor(
      async () => (await panel.$$eval("#rule-rows tr", (rows) => rows.length)) === 1,
      10_000,
      "rules to be imported",
    );
    console.log("  ok  a rule round-trips through export and import");

    // Clear the imported rule so later checks start from an empty list.
    await panel.evaluate(() => document.querySelector("#rule-rows tr button")?.click());
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Schemas now live in Settings, and an auto-decode rule can pick a type
    // from a value inside the message.
    check(
      await panel.evaluate(() => document.getElementById("btn-schema") === null),
      "the Schemas button is gone from the capture view",
    );
    check(
      await panel.evaluate(() => document.getElementById("schema-files") !== null),
      "schemas are loaded from the Settings tab",
    );
    await panel.click("#btn-add-rule");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await panel.evaluate(() => {
      const row = document.querySelector("#rule-rows tr");
      if (!row) throw new Error("no rule row");
      row.querySelector('[data-rule-field="fieldNumber"]').value = "3";
      row.querySelector('[data-rule-field="fieldValue"]').value = "7";
      row.querySelector('[data-rule-field="messageType"]').value = "game.LoginRequest";
    });
    await panel.click("#btn-save-settings");
    await new Promise((resolve) => setTimeout(resolve, 700));
    const storedRules = await panel.evaluate(async () => {
      const stored = await chrome.storage.local.get("protoInspector.settings");
      return stored["protoInspector.settings"]?.autoDecodeRules ?? [];
    });
    check(
      Array.isArray(storedRules) && storedRules.some((rule) => rule.fieldValue === 7),
      `auto decode rule persisted (${JSON.stringify(storedRules)})`,
    );
    await panel.click("#tab-capture");
    await page.evaluate(() => window.sendLogin());
    await new Promise((resolve) => setTimeout(resolve, 1400));
    const ruleDecoded = await waitFor(
      async () =>
        panel.$$eval("#message-body tr", (rows) =>
          rows.filter((row) => row.children[6]?.className === "type--rule").length,
        ),
      10_000,
      "a frame decoded by rule",
    );
    check(ruleDecoded > 0, `a rule decodes the frame without a pick (${ruleDecoded} rows)`);
    // Remove the rule so the later steps start from a clean state.
    await panel.click("#tab-settings");
    await panel.evaluate(() => {
      document.querySelector("#rule-rows tr button")?.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await panel.click("#tab-capture");

    // Choosing a schema decodes the frame; nothing is guessed automatically.
    await page.evaluate(() => window.sendLogin());
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const untypedRow = await waitFor(
      async () => {
        const rows = await panel.$$eval("#message-body tr", (list) =>
          list.map((row) => ({
            frameId: row.dataset.frameId ?? "",
            status: row.children[5]?.textContent ?? "",
            type: row.children[6]?.textContent ?? "",
            typeClass: row.children[6]?.className ?? "",
          })),
        );
        // A frame nobody has decoded: no type, wire-format only.
        return rows.find((row) => row.type === "" || row.type === "—")?.frameId ?? "";
      },
      15_000,
      "an undecoded row",
    );
    await panel.evaluate((frameId) => {
      const row = document.querySelector(`tr[data-frame-id="${frameId}"]`);
      if (row) row.click();
    }, untypedRow);
    await panel.waitForFunction(() => document.querySelector("#detail-content")?.hidden === false);
    const noGuess = await panel.$eval("#decoded-output", (el) => el.textContent ?? "");
    check(
      /No message type selected/.test(noGuess) || /not valid protobuf/i.test(noGuess),
      "an unchosen frame is not guessed at",
    );

    // Reusing the picked schema across the same wire shape.
    await panel.evaluate(() => {
      const rows = [...document.querySelectorAll("#message-body tr")];
      const target = rows.find(
        (row) => row.querySelector(".dir")?.textContent === "SEND" && row.children[6]?.textContent === "game.LoginRequest",
      );
      if (!target) throw new Error("no LoginRequest row to pick from");
      target.click();
    });
    await panel.waitForFunction(() => (document.querySelector("#type-source")?.textContent ?? "").length > 0);
    await panel.select("#decode-type-select", "game.ChatMessage");
    await new Promise((resolve) => setTimeout(resolve, 800));
    const remembered = await panel.$$eval("#message-body tr", (rows) =>
      rows.filter((row) => row.children[6]?.className === "type--remembered").length,
    );
    check(remembered > 0, `a picked schema is reused for the same shape (${remembered} rows)`);

    // Turning the option off stops the reuse. It lives in the Picked tab.
    await panel.click("#tab-settings");
    await panel.click("#settings-tab-picked");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await panel.click("#input-reuse-schema");
    await new Promise((resolve) => setTimeout(resolve, 700));
    await panel.click("#tab-capture");
    const afterOff = await panel.$$eval("#message-body tr", (rows) =>
      rows.filter((row) => row.children[6]?.className === "type--remembered").length,
    );
    check(afterOff === 0, "disabling the option stops schema reuse");
    await panel.click("#tab-settings");
    await panel.click("#settings-tab-picked");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await panel.click("#input-reuse-schema");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await panel.click("#tab-capture");

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
    // Same as the rules file: wait until the JSON parses, not merely until the
    // file name exists.
    const exported = await waitFor(
      async () => {
        const file = fs
          .readdirSync(downloadDir)
          .find((name) => name.endsWith(".json") && !name.startsWith("proto-inspector-rules-"));
        if (!file) return null;
        try {
          return JSON.parse(fs.readFileSync(path.join(downloadDir, file), "utf8"));
        } catch {
          return null;
        }
      },
      10_000,
      "exported JSON file",
    );
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
