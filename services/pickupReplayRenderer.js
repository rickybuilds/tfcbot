"use strict";

const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const fetchDefault = require("node-fetch");
const WebSocketImpl = globalThis.WebSocket || require("ws");

const DEFAULT_TIMEOUT_MS = 180_000;

function browserCandidates() {
  return [
    process.env.PICKUP_REPLAY_BROWSER_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
}

function resolveBrowserExecutable() {
  return browserCandidates().find(candidate => {
    if (path.isAbsolute(candidate)) return fs.existsSync(candidate);
    return true;
  }) || null;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs, intervalMs = 250, label = "condition" }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await wait(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

class CdpSession {
  constructor(url) {
    this.socket = new WebSocketImpl(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.ready = new Promise((resolve, reject) => {
      addSocketListener(this.socket, "open", resolve, true);
      addSocketListener(this.socket, "error", reject, true);
    });
    addSocketListener(this.socket, "message", event => {
      const payload = event?.data === undefined ? event : event.data;
      const message = JSON.parse(String(payload));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || "CDP command failed"));
        else pending.resolve(message.result);
        return;
      }
      const listeners = this.events.get(message.method) || [];
      for (const listener of listeners) listener(message.params || {});
    });
  }

  async command(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(method, predicate = () => true, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const listeners = this.events.get(method) || [];
      const listener = value => {
        if (!predicate(value)) return;
        clearTimeout(timer);
        this.events.set(method, listeners.filter(item => item !== listener));
        resolve(value);
      };
      const timer = setTimeout(() => {
        this.events.set(method, listeners.filter(item => item !== listener));
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      listeners.push(listener);
      this.events.set(method, listeners);
    });
  }

  close() {
    try { this.socket.close(); } catch {}
  }
}

function addSocketListener(socket, event, listener, once = false) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(event, listener, once ? { once: true } : undefined);
  } else if (once && typeof socket.once === "function") {
    socket.once(event, listener);
  } else {
    socket.on(event, listener);
  }
}

async function waitForDevTools(port, fetchImpl, timeoutMs) {
  return waitFor(async () => {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`);
      if (!response.ok) return null;
      const targets = await response.json();
      return targets.find(target => target.type === "page" && target.webSocketDebuggerUrl) || null;
    } catch {
      return null;
    }
  }, { timeoutMs, label: "Chromium DevTools" });
}

async function renderReplayClip({
  url,
  outputPath,
  browserPath = resolveBrowserExecutable(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetchDefault,
  spawnImpl = spawn,
} = {}) {
  if (!url || !outputPath) throw new Error("Replay render requires a URL and output path");
  if (!browserPath) {
    throw new Error("No Chromium executable found; set PICKUP_REPLAY_BROWSER_PATH");
  }

  const outputDir = path.dirname(outputPath);
  await fsp.mkdir(outputDir, { recursive: true });
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tfc-replay-browser-"));
  const port = await reservePort();
  const browser = spawnImpl(browserPath, [
    "--headless=new",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"] });

  let cdp = null;
  try {
    const target = await waitForDevTools(port, fetchImpl, timeoutMs);
    cdp = new CdpSession(target.webSocketDebuggerUrl);
    await cdp.command("Page.enable");
    await cdp.command("Runtime.enable");
    // Chrome versions differ on whether downloads are exposed through the
    // Page or Browser CDP domain. The filesystem is the common source of
    // truth, so configure whichever command the browser supports and poll
    // the isolated output directory below.
    try {
      await cdp.command("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: outputDir,
        eventsEnabled: true,
      });
    } catch {
      await cdp.command("Page.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: outputDir,
      });
    }
    await cdp.command("Page.navigate", { url });

    await waitFor(async () => {
      const result = await cdp.command("Runtime.evaluate", {
        expression: `(() => {
          const button = document.querySelector("#replay-clip-download");
          const editor = document.querySelector("#replay-clip-editor");
          return Boolean(button && !button.disabled && editor && !editor.hidden);
        })()`,
        returnByValue: true,
      });
      return result.result?.value === true;
    }, { timeoutMs, label: "replay clip editor" });

    await cdp.command("Runtime.evaluate", {
      expression: "document.querySelector('#replay-clip-download').click()",
    });

    // Do not depend on Page.downloadWillBegin/Page.downloadProgress: those
    // events are absent or inconsistent in some headless Chrome builds.
    const downloadedPath = await waitFor(async () => {
      const entries = await fsp.readdir(outputDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.endsWith(".crdownload")) continue;
        const candidate = path.join(outputDir, entry.name);
        try {
          const stat = await fsp.stat(candidate);
          if (stat.size > 0) return candidate;
        } catch {
          // The file may disappear between readdir and stat.
        }
      }
      return null;
    }, { timeoutMs, label: "downloaded WebM" });
    await waitFor(async () => {
      try {
        const stat = await fsp.stat(downloadedPath);
        return stat.size > 0;
      } catch {
        return false;
      }
    }, { timeoutMs, label: "downloaded WebM" });
    if (downloadedPath !== outputPath) await fsp.rename(downloadedPath, outputPath);
    return outputPath;
  } finally {
    try { await cdp?.command("Browser.close"); } catch {}
    cdp?.close();
    browser.kill?.();
    await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function reservePort() {
  const net = require("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

module.exports = {
  CdpSession,
  renderReplayClip,
  resolveBrowserExecutable,
};
