#!/usr/bin/env node
/**
 * Check that a built Hook Browser really renders the overlay.
 *
 *   node browser/tools/smoke.mjs                       # out/Dev, a temp profile
 *   node browser/tools/smoke.mjs --shot hook.png       # also save a screenshot
 *   node browser/tools/smoke.mjs --chrome <path to chrome.exe>
 *
 * It launches the binary with a throwaway profile and the DevTools protocol on a
 * loopback port, opens `chrome://hook`, and reads what the page drew: the tab
 * list from the mojom seam, the dock from the Vite panel, the composer, and one
 * send round trip. A pass means the overlay's C++, its mojom, its pak and the
 * shared `packages/chat` bundle all reached a real window.
 *
 * Run it after a build, never during one: it loads DLLs out of `out/`, and the
 * linker cannot overwrite a DLL that is mapped.
 *
 * `ws` is the repository's dependency, so this runs from a checkout with
 * `pnpm install` done; nothing here is part of a release.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import { bold, fail, ok, parseArgs, srcDir, step, treeRoot, warn } from "./lib.mjs";

const PAGE = "chrome://hook/";

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  return null;
}

/** A CDP session with just enough of the protocol for this check. */
function connect(socketUrl) {
  const socket = new WebSocket(socketUrl);
  const pending = new Map();
  const events = [];
  let nextId = 1;

  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id && pending.has(message.id)) {
      const { resolve: done, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else done(message.result);
      return;
    }
    events.push(message);
  });

  const opened = new Promise((done, bad) => {
    socket.on("open", done);
    socket.on("error", bad);
  });

  const send = (method, params = {}) =>
    new Promise((done, bad) => {
      const id = nextId++;
      pending.set(id, { resolve: done, reject: bad });
      socket.send(JSON.stringify({ id, method, params }));
    });

  return { opened, send, events, close: () => socket.close() };
}

export async function main(argv) {
  const { flags } = parseArgs(argv);
  const root = treeRoot(flags);
  const out = flags.get("out") ?? "out/Dev";
  const port = Number(flags.get("port") ?? 9333);
  const shot = typeof flags.get("shot") === "string" ? resolve(flags.get("shot")) : null;

  const binary =
    typeof flags.get("chrome") === "string"
      ? resolve(flags.get("chrome"))
      : join(srcDir(root), out, process.platform === "win32" ? "chrome.exe" : "chrome");
  if (!existsSync(binary)) {
    console.error(fail(`no browser at ${binary}; run node browser/tools/build.mjs first.`));
    return 1;
  }

  const profile = mkdtempSync(join(tmpdir(), "hook-smoke-"));
  step(`launching ${bold(binary)}`);
  const child = spawn(binary, [
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-breakpad",
    // The check runs unattended: a window nobody is looking at is occluded by
    // definition, and an occluded window stops producing frames — which makes
    // a screenshot fail rather than the page being wrong.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
    "--remote-debugging-port=" + port,
    PAGE,
  ], { stdio: "ignore", windowsHide: false });

  const stop = () => {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      // already gone
    }
  };

  let failures = [];
  try {
    const version = await waitFor(`http://127.0.0.1:${port}/json/version`, 60000);
    if (!version) {
      console.error(fail("the browser never answered on its debugging port."));
      return 1;
    }
    console.log(`    ${version.Browser}`);

    // The URL argument sometimes opens beside the new tab page; ask for it.
    const targets = await waitFor(`http://127.0.0.1:${port}/json/list`, 5000);
    if (!targets?.some((target) => target.url === PAGE)) {
      await fetch(`http://127.0.0.1:${port}/json/new?${PAGE}`, { method: "PUT" });
      await sleep(1000);
    }
    const pages = await waitFor(`http://127.0.0.1:${port}/json/list`, 5000) ?? [];
    const page = pages.find((target) => target.type === "page" && target.url === PAGE);
    if (!page) {
      console.error(fail("chrome://hook did not open."));
      return 1;
    }

    const client = connect(page.webSocketDebuggerUrl);
    await client.opened;
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    await client.send("Page.enable");
    await sleep(1500);

    const evaluate = async (expression) => {
      const result = await client.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: 15000,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? "exception");
      }
      return result.result?.value;
    };

    const report = await evaluate(`(() => {
      const dock = document.querySelector('#dock > .dock');
      return {
        title: document.title,
        status: document.querySelector('#status')?.textContent ?? '',
        tabs: [...document.querySelectorAll('#tabs .tab')].map((row) => ({
          title: row.querySelector('.tab-title')?.textContent ?? '',
          domain: row.querySelector('.tab-domain')?.textContent ?? '',
          active: row.classList.contains('tab-active'),
        })),
        dock: dock ? {
          width: Math.round(dock.getBoundingClientRect().width),
          composer: !!dock.querySelector('textarea'),
          text: dock.textContent?.slice(0, 160) ?? '',
        } : null,
      };
    })()`);
    console.log(JSON.stringify(report, null, 2));

    if (!report.title) failures.push("the page has no title");
    if (report.tabs.length < 1) failures.push("the tab list is empty: the mojom read failed");
    if (!report.tabs.some((tab) => tab.active)) failures.push("no tab is marked active");
    if (!report.dock) failures.push("no dock: the panel bundle did not mount");
    else {
      if (report.dock.width < 300) failures.push(`the dock is ${report.dock.width}px, narrower than 380`);
      if (!report.dock.composer) failures.push("the dock has no composer");
    }

    // One send, so the transport and the dock are exercised rather than painted.
    const roundTrip = await evaluate(`(async () => {
      const box = document.querySelector('#dock textarea');
      if (!box) return { error: 'no textarea' };
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(box, 'ping from the smoke check');
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 120));
      const form = box.closest('form');
      if (form) form.requestSubmit();
      await new Promise((done) => setTimeout(done, 3000));
      return { text: document.querySelector('#dock')?.textContent?.slice(-240) ?? '' };
    })()`);
    console.log("round trip:", JSON.stringify(roundTrip, null, 2));
    if (!roundTrip?.text?.includes("smoke check")) {
      failures.push("a sent message never reached the thread");
    }

    const problems = client.events
      .filter((event) => event.method === "Runtime.exceptionThrown" ||
        event.method === "Log.entryAdded" ||
        (event.method === "Runtime.consoleAPICalled" && event.params.type === "error"))
      .map((event) => JSON.stringify(event.params).slice(0, 300));

    if (shot) {
      // A screenshot of an occluded page is refused, so raise the tab first.
      try {
        await client.send("Page.bringToFront");
        await sleep(300);
        let image;
        try {
          image = await client.send("Page.captureScreenshot", { format: "png" });
        } catch {
          image = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
        }
        writeFileSync(shot, Buffer.from(image.data, "base64"));
        console.log(`    screenshot: ${shot}`);
      } catch (failure) {
        console.error(warn(`screenshot skipped: ${String(failure).slice(0, 120)}`));
      }
    }
    client.close();

    if (problems.length) {
      console.error(warn("console problems:"));
      for (const problem of problems) console.error("  " + problem);
      failures.push(`${problems.length} console error(s)`);
    }
  } finally {
    stop();
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // a locked profile file is not worth failing the check
    }
  }

  if (failures.length) {
    console.error(fail("Smoke check failed:"));
    for (const failure of failures) console.error(`  - ${failure}`);
    return 1;
  }
  console.log(ok("Smoke check passed."));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
