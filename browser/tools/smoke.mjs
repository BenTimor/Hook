#!/usr/bin/env node
/**
 * Check that a built Hook Browser really renders the overlay — and, with
 * `--channel`, that its dock reaches a running Hook app.
 *
 *   node browser/tools/smoke.mjs                       # out/Dev, a temp profile
 *   node browser/tools/smoke.mjs --side-panel          # also the side panel
 *   node browser/tools/smoke.mjs --signin-state out    # the gate refuses, and the
 *                                                    # page draws the shared card
 *   node browser/tools/smoke.mjs --channel             # needs Hook running
 *   node browser/tools/smoke.mjs --codecs              # H.264 and AAC decode
 *   node browser/tools/smoke.mjs --newtab              # the new tab page, and that
 *                                                    # a new tab is ours at all
 *   node browser/tools/smoke.mjs --host                # the browser starts its own
 *                                                    # Hook host when none answers
 *   node browser/tools/smoke.mjs --shot hook.png       # screenshots too
 *   node browser/tools/smoke.mjs --chrome <path to chrome.exe>
 *
 * Every run passes `--hook-no-host` unless it asks for `--host`: a check must not
 * leave a Hook process behind, and the sign-in gate's seams must not spawn one.
 *
 * It launches the binary with a throwaway profile and the DevTools protocol on a
 * loopback port, opens `chrome://hook`, and reads what the page drew: the tab
 * list from the mojom seam, the dock from the Vite bundle, the composer, one send
 * round trip, the sign-in gate, and — when asked — the side panel and the real
 * conversations of the Hook app that is running on this machine.
 *
 * Run it after a build, never during one: it maps DLLs out of `out/`, and the
 * linker cannot overwrite a file that is mapped.
 *
 * `ws` is the repository's dependency, so this runs from a checkout with
 * `pnpm install` done; nothing here is part of a release.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import { bold, fail, ok, parseArgs, srcDir, step, treeRoot, warn } from "./lib.mjs";

const PAGE = "chrome://hook/";
const PANEL = "chrome://hook-panel/";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ------------------------------------------------------------------ plumbing --

/** Poll `url` until it answers JSON, or give up. */
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

/** A CDP session with just enough of the protocol for these checks. */
function connect(socketUrl) {
  const socket = new WebSocket(socketUrl);
  const pending = new Map();
  const events = [];
  let nextId = 1;

  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
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

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 20000,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "exception");
    }
    return result.result?.value;
  };

  return { opened, send, evaluate, events, close: () => socket.close() };
}

const problemsOf = (client) =>
  client.events
    .filter(
      (event) =>
        event.method === "Runtime.exceptionThrown" ||
        event.method === "Log.entryAdded" ||
        (event.method === "Runtime.consoleAPICalled" && event.params.type === "error"),
    )
    .map((event) => JSON.stringify(event.params).slice(0, 300));

/**
 * The account file the browser's gate reads, so the check knows what to expect
 * when nothing forces the answer. Only the presence of a token matters.
 */
function sharedDir() {
  const dir =
    process.platform === "win32"
      ? process.env.APPDATA
      : process.platform === "darwin"
        ? join(process.env.HOME ?? "", "Library", "Application Support")
        : (process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "", ".local", "share"));
  return dir ? join(dir, "app.hook") : null;
}

function machineSignedIn() {
  const dir = sharedDir();
  if (!dir) return false;
  const path = join(dir, "account.json");
  if (!existsSync(path)) return false;
  try {
    const account = JSON.parse(readFileSync(path, "utf8"));
    return typeof account?.session?.token === "string" && account.session.token.length > 0;
  } catch {
    return false;
  }
}

// The descriptor a running Hook host publishes (`crates/hook-core/src/channel.rs`).
//
// One file per product, so a Hook app in the tray and the browser's own host can
// run at once: the browser's first, then the products it may fall back to, then
// the single name every build before the split wrote. The order is the browser's
// (`browser/overlay/src/hook/browser/account/hook_paths.cc`).
const DESCRIPTOR_NAMES = [
  "browser-channel.browser.json",
  "browser-channel.chat.json",
  "browser-channel.workspace.json",
  "browser-channel.json",
];

function readDescriptor() {
  const dir = sharedDir();
  if (!dir) return null;
  for (const name of DESCRIPTOR_NAMES) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      const descriptor = JSON.parse(readFileSync(path, "utf8"));
      if (typeof descriptor?.port === "number" && descriptor.port > 0) {
        return { ...descriptor, file: name };
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

// A descriptor outlives a killed host, so "published" is not "running": the
// health route is, exactly as the browser decides it.
async function descriptorAlive(descriptor) {
  if (!descriptor) return null;
  try {
    const health = await (await fetch(`http://127.0.0.1:${descriptor.port}/health`)).json();
    return health?.ok ? health : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (failure) {
    // EPERM is a process that exists and is not ours to signal.
    return failure?.code === "EPERM";
  }
}

/** A local page the gate can either reach or refuse; no network involved. */
function probeServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!DOCTYPE html><title>gate probe</title><p>reached");
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => done(server));
  });
}

async function screenshot(client, path, target) {
  if (!path || !client) return;
  try {
    await client.send("Page.bringToFront").catch(() => {});
    await sleep(300);
    let image;
    try {
      image = await client.send("Page.captureScreenshot", { format: "png", ...target });
    } catch {
      image = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        ...target,
      });
    }
    writeFileSync(path, Buffer.from(image.data, "base64"));
    console.log(`    screenshot: ${path}`);
  } catch (failure) {
    console.error(warn(`screenshot skipped: ${String(failure).slice(0, 120)}`));
  }
}

// ---------------------------------------------------------------------- main --

export async function main(argv) {
  const { flags } = parseArgs(argv);
  const root = treeRoot(flags);
  const out = flags.get("out") ?? "out/Dev";
  const port = Number(flags.get("port") ?? 9333);
  const shot = typeof flags.get("shot") === "string" ? resolve(flags.get("shot")) : null;
  const sidePanel = flags.get("side-panel") === true;
  const channelCheck = flags.get("channel") === true;
  const codecCheck = flags.get("codecs") === true;
  const newTabCheck = flags.get("newtab") === true;
  const hostCheck = flags.get("host") === true;
  const signin = flags.get("signin-state");
  if (signin !== undefined && signin !== "in" && signin !== "out") {
    console.error(fail("--signin-state takes in or out"));
    return 1;
  }

  const binary =
    typeof flags.get("chrome") === "string"
      ? resolve(flags.get("chrome"))
      : join(srcDir(root), out, process.platform === "win32" ? "chrome.exe" : "chrome");
  if (!existsSync(binary)) {
    console.error(fail(`no browser at ${binary}; run node browser/tools/build.mjs first.`));
    return 1;
  }

  const profile = mkdtempSync(join(tmpdir(), "hook-smoke-"));
  // A host that is already answering is not the one this run means to prove, so
  // the launch check needs an empty channel: it says so instead of pretending.
  const existing = hostCheck ? await descriptorAlive(readDescriptor()) : null;
  let hostPid = 0;
  step(`launching ${bold(binary)}`);
  const child = spawn(
    binary,
    [
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-breakpad",
      // The check runs unattended: a window nobody is looking at is occluded by
      // definition, and an occluded window stops producing frames — which makes a
      // screenshot fail rather than the page being wrong.
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion",
      `--remote-debugging-port=${port}`,
      ...(hostCheck ? [] : ["--hook-no-host"]),
      ...(signin ? [`--hook-signin-state=${signin}`] : []),
      ...(sidePanel ? ["--hook-side-panel"] : []),
      PAGE,
    ],
    { stdio: "ignore", windowsHide: false },
  );

  const stop = () => {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      // already gone
    }
  };

  const failures = [];

  try {
    const version = await waitFor(`http://127.0.0.1:${port}/json/version`, 60000);
    if (!version) {
      console.error(fail("the browser never answered on its debugging port."));
      return 1;
    }
    console.log(`    ${version.Browser}`);

    // The URL argument sometimes opens beside the new tab page; ask for it.
    let targets = await waitFor(`http://127.0.0.1:${port}/json/list`, 5000);
    if (!targets?.some((target) => target.url === PAGE)) {
      await fetch(`http://127.0.0.1:${port}/json/new?${PAGE}`, { method: "PUT" });
      await sleep(1500);
      targets = await waitFor(`http://127.0.0.1:${port}/json/list`, 5000) ?? [];
    }
    const page = targets.find((target) => target.type === "page" && target.url === PAGE);
    if (!page) {
      const seen = (targets ?? []).map((target) => target.url).join(" | ");
      console.error(fail(`chrome://hook did not open. Targets: ${seen}`));
      return 1;
    }

    const client = connect(page.webSocketDebuggerUrl);
    await client.opened;
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    await client.send("Page.enable");
    await sleep(1500);

    // ---- the dock, on the seam page -----------------------------------------
    const report = await client.evaluate(`(() => {
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
        gate: (() => {
          const host = document.querySelector('#gate');
          const card = host?.querySelector('.signin-card');
          if (!host || !card) return null;
          return {
            visible: !host.hidden,
            kicker: card.querySelector('.signin-kicker')?.textContent ?? '',
            title: card.querySelector('.signin-title')?.textContent ?? '',
            button: card.querySelector('.signin-primary')?.textContent ?? '',
            copy: card.querySelector('.signin-copy')?.textContent ?? '',
            code: card.querySelector('.signin-code')?.textContent ?? '',
          };
        })(),
        seamHidden: document.querySelector('#seam')?.hidden ?? null,
      };
    })()`);
    console.log(JSON.stringify(report, null, 2));

    if (!report.title) failures.push("the page has no title");

    // A signed-out page has one job: the card, and no conversation surface. A
    // signed-in page has the tab list and the dock. The switch is the only thing
    // that decides which, and the page must follow it exactly.
    if (signin === "out") {
      if (!report.gate) {
        failures.push("no sign-in card on a signed-out page");
      } else {
        if (!report.gate.visible) failures.push("the sign-in card is hidden");
        if (!/sign in/i.test(report.gate.title)) {
          failures.push(`the card's title is "${report.gate.title}"`);
        }
        if (!/sign in/i.test(report.gate.button)) {
          failures.push(`the card's button is "${report.gate.button}"`);
        }
        if (!report.gate.copy) failures.push("the card has no explanation");
      }
      if (!report.seamHidden) failures.push("the signed-out page still shows the browser");
      if (report.dock) failures.push("a signed-out page mounted the dock");
    } else {
      if (report.tabs.length < 1) failures.push("the tab list is empty: the mojom read failed");
      if (!report.tabs.some((tab) => tab.active)) failures.push("no tab is marked active");
      if (!report.dock) failures.push("no dock: the panel bundle did not mount");
      else {
        if (report.dock.width < 300) failures.push(`the dock is ${report.dock.width}px, narrower than 380`);
        if (!report.dock.composer) failures.push("the dock has no composer");
      }
    }

    // ---- one send, so the transport is exercised rather than painted --------
    const roundTrip = signin === "out" ? null : await client.evaluate(`(async () => {
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
    if (signin !== "out" && !roundTrip?.text?.includes("smoke check")) {
      failures.push("a sent message never reached the thread");
    }

    const problems = problemsOf(client);
    if (problems.length) {
      console.error(warn("console problems:"));
      for (const problem of problems) console.error(`  ${problem}`);
      failures.push(`${problems.length} console error(s)`);
    }

    // ---- the side panel ------------------------------------------------------
    let panelShotTarget = null;
    if (sidePanel) {
      const panelTarget = (await waitFor(`http://127.0.0.1:${port}/json/list`, 5000) ?? []).find(
        (target) => target.url.startsWith("chrome://hook-panel"),
      );
      if (!panelTarget) {
        failures.push("--side-panel was set, but no chrome://hook-panel target exists");
      } else {
        const panel = connect(panelTarget.webSocketDebuggerUrl);
        await panel.opened;
        await panel.send("Runtime.enable");
        await sleep(2000);
        const panelDock = await panel.evaluate(`(() => {
          const dock = document.querySelector('#dock > .dock');
          return dock ? {
            width: Math.round(dock.getBoundingClientRect().width),
            composer: !!dock.querySelector('textarea'),
          } : null;
        })()`);
        console.log(`    side panel: ${JSON.stringify(panelDock)}`);
        if (!panelDock?.composer) failures.push("the side panel did not draw the dock");
        else if (panelDock.width < 300) failures.push(`the side panel's dock is ${panelDock.width}px wide`);
        const panelProblems = problemsOf(panel);
        if (panelProblems.length) {
          console.error(warn(`side panel console problems: ${panelProblems.length}`));
          failures.push(`${panelProblems.length} console error(s) in the side panel`);
        }
        if (shot) {
          panelShotTarget = panel;
        } else {
          panel.close();
        }
      }
    }

    // ---- the browser starting its own host -----------------------------------
    //
    // `docs/browser-host.md`, steps 1 and 3. The page asks for the channel as it
    // loads; nothing answered, so the browser process launches `hook-host.exe`
    // (`host/hook_host.cc`) and only accepts the descriptor that names its child.
    // The pid is the assertion: a descriptor that was already there is not this
    // run's, and one that survives the browser is not "kill on exit". The product
    // is the other half of step 3: the host is the browser's own, not a chat app
    // borrowed for the occasion.
    if (hostCheck) {
      if (existing) {
        console.error(warn(
          `a Hook host is already running (pid ${existing.pid}): --host proves a launch, ` +
            `so close it and run again to check this`,
        ));
      } else {
        const deadline = Date.now() + 30000;
        let started = null;
        let health = null;
        while (Date.now() < deadline) {
          const descriptor = readDescriptor();
          if (descriptor?.pid) {
            health = await descriptorAlive(descriptor);
            if (health) {
              started = descriptor;
              break;
            }
          }
          await sleep(500);
        }
        if (!started) {
          failures.push(
            "--host was set, but the browser started no host: no descriptor answered /health",
          );
        } else {
          hostPid = started.pid;
          console.log(`    host: pid ${hostPid}, ${health.product} ${health.version}`);
          if (processAlive(child.pid) && hostPid === child.pid) {
            failures.push("the descriptor names the browser itself, not a host");
          }
          if (health.product !== "browser") {
            failures.push(
              `the host serves the "${health.product}" product, not "browser" ` +
                `(hook-host, not a chat app)`,
            );
          }
          if (started.file !== "browser-channel.browser.json") {
            failures.push(
              `the host published ${started.file}: the browser's own host writes ` +
                `browser-channel.browser.json, so this one is another product's`,
            );
          }
        }
      }
    }

    // ---- the codecs the build has to carry -----------------------------------
    //
    // `args.gn` turns on `proprietary_codecs` and `ffmpeg_branding = "Chrome"`.
    // Both are easy to lose in a merge and invisible until a page shows a black
    // box, so the build says so out loud here: with them off, every MP4 on the
    // web is undecodable and only VP9/AV1 content plays.
    if (codecCheck) {
      const codecs = await client.evaluate(`(() => {
        const video = document.createElement("video");
        const audio = document.createElement("audio");
        return {
          h264: video.canPlayType('video/mp4; codecs="avc1.42E01E"'),
          aac: audio.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
          vp9: video.canPlayType('video/webm; codecs="vp9"'),
        };
      })()`);
      console.log(`    codecs: ${JSON.stringify(codecs)}`);
      if (!codecs?.h264) failures.push('H.264 does not decode: the dev build gets it from args.gn (proprietary_codecs), a shipped build from Media Foundation');
      if (!codecs?.aac) failures.push('AAC does not decode: the dev build gets it from args.gn (ffmpeg_branding = "Chrome"), a shipped build from Media Foundation');
      if (!codecs?.vp9) failures.push("VP9 does not decode, which is wider than the codec flags");
    }

    // ---- the real backend, when a Hook app is running ------------------------
    if (channelCheck) {
      const state = await client.evaluate(`(async () => {
        const module = await import("./hook.mojom-webui.js");
        const handler = module.PageHandler.getRemote();
        const status = await handler.getChannel();
        const list = await handler.listChats();
        const first = list.chats[0];
        let view = null;
        let refused = null;
        if (first) {
          const got = await handler.getChat(first.id);
          view = got.chat
            ? { title: got.chat.chat.title, messages: got.chat.messages.length, busy: got.chat.chat.busy }
            : null;
          // A whitespace-only message is refused by hook-core before any turn:
          // this proves the write path without spending a model call.
          refused = await handler.sendMessage(first.id, "   ", "");
        }
        return {
          available: status.available,
          reason: status.reason,
          chats: list.chats.length,
          listError: list.error,
          view,
          refused,
        };
      })()`);
      console.log(`    channel: ${JSON.stringify(state)}`);
      if (!state?.available) {
        failures.push(`the browser sees no channel: ${state?.reason ?? "no answer"}`);
      } else if (!(state.chats > 0)) {
        failures.push(`the channel returned no chats (${state.listError})`);
      } else {
        if (!state.view || state.view.messages < 1) failures.push("the first conversation came back empty");
        if (!state.refused || state.refused.ok) failures.push("an empty message was accepted");
      }
    }

    // ---- the pictures, before the gate sends the tab away --------------------
    if (shot) {
      await screenshot(client, shot);
      if (panelShotTarget) {
        await screenshot(panelShotTarget, shot.replace(/\.png$/, "-panel.png"), { fromSurface: false });
        panelShotTarget.close();
      }
    }

    // ---- the new tab page ----------------------------------------------------
    //
    // Two things are worth asserting, and the second is the one a patch can
    // break silently: that `chrome://hook-newtab` draws, and that the browser's
    // own "open a new tab" lands there. The first window is the cheapest proof
    // of the second — it asks the same constant Ctrl+T does
    // (`ChromeUINewTabURLAsGURL`), and the profile is fresh, so it has no
    // restored tabs to confuse the answer.
    if (newTabCheck) {
      const firstTab = (await waitFor(`http://127.0.0.1:${port}/json/list`, 5000) ?? []).find(
        (target) => target.type === "page",
      );
      await client.send("Page.navigate", { url: "chrome://hook-newtab/" });
      await sleep(1500);
      const newTab = await client.evaluate(`(() => ({
        url: location.href,
        title: document.title,
        greeting: document.querySelector("#greeting")?.textContent ?? "",
        chips: [...document.querySelectorAll(".ntp-chip-title")].map((chip) => chip.textContent),
      }))()`);
      console.log(`    new tab: ${JSON.stringify(newTab)}`);
      if (!/^chrome:\/\/hook-newtab\//.test(newTab?.url ?? "")) {
        failures.push(`chrome://hook-newtab did not load, got ${newTab?.url}`);
      }
      if (!newTab?.greeting) failures.push("the new tab page has no greeting");
      if ((newTab?.chips?.length ?? 0) !== 3) {
        failures.push(`the new tab page has ${newTab?.chips?.length ?? 0} chips, not 3`);
      }
      if (!firstTab) failures.push("no first tab to prove the new tab URL on");
    }

    // ---- the sign-in gate, last: it navigates the tab -----------------------
    const server = await probeServer();
    try {
      const probePort = server.address().port;
      const probe = `http://127.0.0.1:${probePort}/gate`;
      const gated = signin === "out" || (signin === undefined && !machineSignedIn());
      await client
        .send("Page.navigate", { url: probe })
        .catch(() => {
          // the navigation is cancelled when the gate fires; that is the point
        });
      await sleep(2500);
      const landed = String(await client.evaluate("location.href"));
      console.log(`    gate: ${gated ? "signed out" : "signed in"} → ${landed}`);
      if (gated) {
        if (!landed.startsWith("chrome://hook")) {
          failures.push(`signed out, but ${probe} loaded (landed on ${landed})`);
        }
      } else if (!landed.startsWith(probe)) {
        failures.push(`signed in, but ${probe} did not load (landed on ${landed})`);
      }
    } catch (failure) {
      failures.push(`the sign-in gate check failed: ${String(failure).slice(0, 120)}`);
    } finally {
      server.close();
    }
    client.close();
  } finally {
    stop();
    await sleep(500);
    if (hostPid) {
      await sleep(1500);
      if (processAlive(hostPid)) {
        failures.push(`the host (pid ${hostPid}) outlived the browser`);
      } else {
        console.log(`    host: pid ${hostPid} went with the browser`);
      }
    }
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
