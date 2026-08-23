"use strict";

const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const fetchDefault = require("node-fetch");
const WebSocketImpl = globalThis.WebSocket || require("ws");
const ffmpegPath = require("ffmpeg-static");

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

async function isWebmFile(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, "r");
    const header = Buffer.alloc(4);
    const result = await handle.read(header, 0, header.length, 0);
    // WebM is an EBML container and always starts with this four-byte ID.
    return result.bytesRead === header.length && header.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", chunk => { output += chunk.toString(); });
    child.stderr?.on("data", chunk => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve(output);
      else reject(new Error(`${path.basename(command)} exited with code ${code}: ${output.slice(-1000)}`));
    });
  });
}

function lastFfmpegTimeSeconds(output) {
  const matches = [...String(output || "").matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)];
  const match = matches.at(-1);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function requestedClipDuration(url, clip) {
  const fromClip = Number(clip?.clipEnd) - Number(clip?.clipStart);
  if (fromClip > 0) return fromClip;
  try {
    const query = new URL(url).searchParams;
    const fromUrl = Number(query.get("clipEnd")) - Number(query.get("clipStart"));
    return fromUrl > 0 ? fromUrl : 0;
  } catch {
    return 0;
  }
}

async function normalizeWebmDuration(inputPath, outputPath, targetDurationSeconds) {
  if (!ffmpegPath || !(targetDurationSeconds > 0)) {
    await fsp.rename(inputPath, outputPath);
    return outputPath;
  }

  const probeOutput = await runProcess(ffmpegPath, [
    "-hide_banner",
    "-i", inputPath,
    "-f", "null",
    "-",
  ]);
  const sourceDuration = lastFfmpegTimeSeconds(probeOutput);
  if (!(sourceDuration > 0)) throw new Error("Could not determine rendered WebM duration");

  const speed = targetDurationSeconds / sourceDuration;
  const temporaryPath = `${outputPath}.normalizing-${process.pid}-${Date.now()}.webm`;
  try {
    await runProcess(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", inputPath,
      "-vf", `setpts=${speed.toFixed(9)}*PTS,format=yuv420p`,
      "-an",
      "-c:v", "libvpx-vp9",
      "-crf", "30",
      "-b:v", "0",
      "-row-mt", "1",
      "-deadline", "good",
      "-cpu-used", "4",
      "-r", "60",
      "-fps_mode", "cfr",
      temporaryPath,
    ]);
    await fsp.rename(temporaryPath, outputPath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    await fsp.rm(inputPath, { force: true }).catch(() => {});
  }
  return outputPath;
}

async function renderReplayClip({
  url,
  outputPath,
  browserPath = resolveBrowserExecutable(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetchDefault,
  spawnImpl = spawn,
  clip = null,
} = {}) {
  if (!url || !outputPath) throw new Error("Replay render requires a URL and output path");
  if (!browserPath) {
    throw new Error("No Chromium executable found; set PICKUP_REPLAY_BROWSER_PATH");
  }

  const outputDir = path.dirname(outputPath);
  const renderStartedAt = Date.now();
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
        // Chromium can leave auxiliary pages such as downloads.html in the
        // directory. Only the named media artifact is eligible here.
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".webm")) continue;
        const candidate = path.join(outputDir, entry.name);
        let stat;
        try {
          stat = await fsp.stat(candidate);
        } catch {
          // The file may disappear between readdir and stat.
          continue;
        }
        if (stat.mtimeMs < renderStartedAt) continue;
        if (stat.size > 0) {
          if (await isWebmFile(candidate)) return candidate;
          throw new Error(`Downloaded clip is not a WebM (invalid EBML header): ${entry.name}`);
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
    const targetDuration = requestedClipDuration(url, clip);
    if (targetDuration > 0) {
      return normalizeWebmDuration(downloadedPath, outputPath, targetDuration);
    }
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
  isWebmFile,
  renderReplayClip,
  resolveBrowserExecutable,
};
