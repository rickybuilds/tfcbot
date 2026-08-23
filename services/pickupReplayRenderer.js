"use strict";

const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fetchDefault = require("node-fetch");
const WebSocketPackage = require("ws");
const WebSocketImpl = globalThis.WebSocket || WebSocketPackage;
const { WebSocketServer } = WebSocketPackage;
const ffmpegPath = require("ffmpeg-static");

const DEFAULT_TIMEOUT_MS = 180_000;

function envEnabled(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || ""));
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function getRenderProfile() {
  const fast = envEnabled(process.env.PICKUP_REPLAY_RENDER_FAST);
  return {
    fast,
    width: Math.round(boundedNumber(
      process.env.PICKUP_REPLAY_RENDER_WIDTH,
      fast ? 854 : 1280,
      320,
      1920,
    )),
    height: Math.round(boundedNumber(
      process.env.PICKUP_REPLAY_RENDER_HEIGHT,
      fast ? 480 : 720,
      240,
      1080,
    )),
    exportWidth: Math.round(boundedNumber(
      process.env.PICKUP_REPLAY_EXPORT_WIDTH,
      1280,
      320,
      1920,
    )),
    exportHeight: Math.round(boundedNumber(
      process.env.PICKUP_REPLAY_EXPORT_HEIGHT,
      720,
      240,
      1080,
    )),
    exportFps: Math.round(boundedNumber(
      process.env.PICKUP_REPLAY_EXPORT_FPS,
      30,
      5,
      30,
    )),
    fps: Math.round(boundedNumber(
      process.env.PICKUP_REPLAY_RENDER_FPS,
      fast ? 30 : 60,
      15,
      60,
    )),
    crf: Math.round(boundedNumber(
      process.env.PICKUP_REPLAY_RENDER_CRF,
      fast ? 30 : 22,
      0,
      63,
    )),
    cpuUsed: Math.round(boundedNumber(
      process.env.PICKUP_REPLAY_RENDER_CPU_USED,
      fast ? 6 : 2,
      0,
      8,
    )),
    deadline: String(
      process.env.PICKUP_REPLAY_RENDER_DEADLINE || (fast ? "realtime" : "good")
    ),
    // Avoid a second full VP9 encode when the replay page already produced
    // essentially the requested duration.
    durationTolerance: boundedNumber(
      process.env.PICKUP_REPLAY_RENDER_DURATION_TOLERANCE,
      fast ? 0.20 : 0.05,
      0,
      2,
    ),
  };
}

function createTimingLogger() {
  const enabled = envEnabled(process.env.PICKUP_REPLAY_RENDER_TIMINGS);
  const started = process.hrtime.bigint();
  let previous = started;
  return label => {
    if (!enabled) return;
    const now = process.hrtime.bigint();
    const elapsed = Number(now - started) / 1e9;
    const delta = Number(now - previous) / 1e9;
    previous = now;
    console.log(`[pickup-replay timing] ${label}: +${elapsed.toFixed(2)}s (delta ${delta.toFixed(2)}s)`);
  };
}

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

async function isMjpegFile(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, "r");
    const header = Buffer.alloc(3);
    const result = await handle.read(header, 0, header.length, 0);
    return result.bytesRead === header.length &&
      header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function replayPageDiagnostics(cdp) {
  const result = await cdp.command("Runtime.evaluate", {
    expression: `(() => {
      const timing = window.__replayClipTiming;
      if (!timing) return null;
      const lastExportEvent = [...(timing.events || [])].reverse().find(event =>
        event.name === "webm-download" || event.name === "export-render-end"
      );
      return {
        mode: timing.mode,
        previewPasses: timing.previewPasses,
        exportPasses: timing.exportPasses,
        lastExportMode: lastExportEvent?.mode || "",
        events: (timing.events || []).map(event => ({
          name: event.name,
          atMs: event.atMs,
          jsHeapMb: event.jsHeapMb,
          frames: event.frames,
          renderCpuMs: event.renderCpuMs,
          codec: event.codec,
          fps: event.fps,
          message: event.message
        }))
      };
    })()`,
    returnByValue: true,
  });
  return result.result?.value || null;
}

function formatPageMilestones(diagnostics, names) {
  const selected = (diagnostics?.events || []).filter(event => names.includes(event.name));
  return selected.map(event => {
    const details = [
      `${event.name}=${(Number(event.atMs) / 1000).toFixed(2)}s`,
      Number.isFinite(event.jsHeapMb) ? `heap=${event.jsHeapMb}MB` : "",
      Number.isFinite(event.frames) ? `frames=${event.frames}` : "",
      Number.isFinite(event.renderCpuMs) ? `renderCpu=${event.renderCpuMs}ms` : "",
      event.codec ? `codec=${event.codec}` : "",
      Number.isFinite(event.fps) ? `fps=${event.fps}` : ""
    ].filter(Boolean);
    return details.join(" ");
  }).join(", ");
}

async function normalizeWebmDuration(
  inputPath,
  outputPath,
  targetDurationSeconds,
  profile = getRenderProfile(),
  mark = () => {},
) {
  if (!ffmpegPath || !(targetDurationSeconds > 0)) {
    await fsp.rename(inputPath, outputPath);
    return outputPath;
  }

  mark("FFmpeg duration probe started");
  const probeOutput = await runProcess(ffmpegPath, [
    "-hide_banner",
    "-i", inputPath,
    "-f", "null",
    "-",
  ]);
  mark("FFmpeg duration probe finished");
  const sourceDuration = lastFfmpegTimeSeconds(probeOutput);
  if (!(sourceDuration > 0)) throw new Error("Could not determine rendered WebM duration");

  if (Math.abs(sourceDuration - targetDurationSeconds) <= profile.durationTolerance) {
    mark(`duration already within tolerance (${sourceDuration.toFixed(3)}s)`);
    await fsp.rename(inputPath, outputPath);
    return outputPath;
  }

  const speed = targetDurationSeconds / sourceDuration;
  const temporaryPath = `${outputPath}.normalizing-${process.pid}-${Date.now()}.webm`;
  try {
    mark(`VP9 encode started (${sourceDuration.toFixed(3)}s -> ${targetDurationSeconds.toFixed(3)}s)`);
    await runProcess(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", inputPath,
      // Retiming preserves the rendered WebGL frames. Motion interpolation is
      // unsuitable here because it can warp 3D geometry and HUD elements.
      "-vf", `setpts=${speed.toFixed(9)}*PTS,format=yuv420p`,
      "-an",
      "-c:v", "libvpx-vp9",
      "-crf", String(profile.crf),
      "-b:v", "0",
      "-row-mt", "1",
      "-deadline", profile.deadline,
      "-cpu-used", String(profile.cpuUsed),
      "-r", String(profile.fps),
      "-fps_mode", "cfr",
      temporaryPath,
    ]);
    mark("VP9 encode finished");
    await fsp.rename(temporaryPath, outputPath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    await fsp.rm(inputPath, { force: true }).catch(() => {});
  }
  return outputPath;
}

async function encodeMjpegFrames(inputPath, outputPath, targetDurationSeconds, profile, mark) {
  if (!ffmpegPath || !(targetDurationSeconds > 0)) {
    throw new Error("FFmpeg is required to encode replay frame streams");
  }
  const temporaryPath = `${outputPath}.encoding-${process.pid}-${Date.now()}.webm`;
  try {
    mark(
      `Native VP9 encode started (${profile.exportWidth}x${profile.exportHeight}, ` +
      `${profile.exportFps}fps source -> ${profile.fps}fps WebM)`
    );
    await runProcess(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-f", "image2pipe",
      "-framerate", String(profile.exportFps),
      "-c:v", "mjpeg",
      "-i", inputPath,
      "-t", targetDurationSeconds.toFixed(6),
      "-an",
      "-vf", "format=yuv420p",
      "-c:v", "libvpx-vp9",
      "-crf", String(profile.crf),
      "-b:v", "0",
      "-row-mt", "1",
      "-threads", "1",
      "-deadline", profile.deadline,
      "-cpu-used", String(profile.cpuUsed),
      "-r", String(profile.fps),
      "-fps_mode", "cfr",
      temporaryPath,
    ]);
    mark("Native VP9 encode finished");
    await fsp.rename(temporaryPath, outputPath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    await fsp.rm(inputPath, { force: true }).catch(() => {});
  }
  return outputPath;
}

async function createRawFrameReceiver({ outputPath, targetDurationSeconds, profile, mark, timeoutMs }) {
  if (!ffmpegPath) throw new Error("FFmpeg is required for raw replay frame export");
  const token = crypto.randomBytes(24).toString("hex");
  const temporaryPath = `${outputPath}.raw-encoding-${process.pid}-${Date.now()}.webm`;
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: profile.exportWidth * profile.exportHeight * 4 + 1024,
  });
  await new Promise((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = error => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
  const port = server.address().port;
  let encoder = null;
  let connectedSocket = null;
  let receivedFrames = 0;
  let expectedFrames = 0;
  let streamStarted = false;
  let streamEnded = false;
  let settled = false;
  let rejectCompletion;
  let resolveCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  let timer = null;

  function finish(error, result) {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (error) rejectCompletion(error);
    else resolveCompletion(result);
  }

  function fail(error) {
    try { encoder?.kill(); } catch {}
    try { connectedSocket?.close(); } catch {}
    finish(error);
  }

  server.on("connection", (socket, request) => {
    let suppliedToken = "";
    try {
      suppliedToken = new URL(request.url, "http://127.0.0.1").searchParams.get("token") || "";
    } catch {}
    if (suppliedToken !== token || connectedSocket) {
      socket.close(1008, "invalid stream");
      return;
    }
    connectedSocket = socket;
    socket.send("ready");
    socket.on("message", (data, isBinary) => {
      void (async () => {
        if (isBinary) {
          if (!streamStarted || streamEnded || !encoder) throw new Error("Raw replay frame arrived out of order");
          const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
          const expectedBytes = profile.exportWidth * profile.exportHeight * 4;
          if (frame.length !== expectedBytes) {
            throw new Error(`Raw replay frame has ${frame.length} bytes; expected ${expectedBytes}`);
          }
          if (!encoder.stdin.write(frame)) await once(encoder.stdin, "drain");
          receivedFrames += 1;
          socket.send("frame");
          return;
        }

        const message = JSON.parse(String(data));
        if (message.type === "start") {
          if (streamStarted || message.width !== profile.exportWidth ||
              message.height !== profile.exportHeight || message.fps !== profile.exportFps) {
            throw new Error("Raw replay frame stream profile mismatch");
          }
          expectedFrames = Number(message.frames);
          if (!Number.isSafeInteger(expectedFrames) || expectedFrames < 1 || expectedFrames > 10000) {
            throw new Error("Invalid raw replay frame count");
          }
          encoder = spawn(ffmpegPath, [
            "-y",
            "-hide_banner",
            "-loglevel", "error",
            "-f", "rawvideo",
            "-pixel_format", "rgba",
            "-video_size", `${profile.exportWidth}x${profile.exportHeight}`,
            "-framerate", String(profile.exportFps),
            "-i", "pipe:0",
            "-t", targetDurationSeconds.toFixed(6),
            "-an",
            "-vf", "format=yuv420p",
            "-c:v", "libvpx-vp9",
            "-crf", String(profile.crf),
            "-b:v", "0",
            "-row-mt", "1",
            "-threads", "1",
            "-deadline", profile.deadline,
            "-cpu-used", String(profile.cpuUsed),
            "-r", String(profile.fps),
            "-fps_mode", "cfr",
            temporaryPath,
          ], { stdio: ["pipe", "ignore", "pipe"] });
          let stderr = "";
          encoder.stderr.on("data", chunk => { stderr += chunk.toString(); });
          encoder.once("error", fail);
          encoder.result = new Promise((resolve, reject) => {
            encoder.once("close", code => {
              if (code === 0) resolve();
              else reject(new Error(`FFmpeg raw replay encode exited with code ${code}: ${stderr.slice(-1000)}`));
            });
          });
          streamStarted = true;
          mark(
            `Raw frame VP9 pipeline started (${profile.exportWidth}x${profile.exportHeight}, ` +
            `${profile.exportFps}fps)`
          );
          socket.send("start");
          return;
        }
        if (message.type === "end") {
          if (!streamStarted || streamEnded || receivedFrames !== expectedFrames ||
              Number(message.frames) !== receivedFrames) {
            throw new Error(
              `Raw replay frame stream ended with ${receivedFrames}/${expectedFrames} frames`
            );
          }
          streamEnded = true;
          encoder.stdin.end();
          await encoder.result;
          await fsp.rm(outputPath, { force: true });
          await fsp.rename(temporaryPath, outputPath);
          mark(`Raw frame VP9 pipeline finished (${receivedFrames} frames)`);
          socket.send("complete");
          finish(null, outputPath);
        }
      })().catch(fail);
    });
    socket.once("error", fail);
    socket.once("close", () => {
      if (!settled && !streamEnded) fail(new Error("Raw replay frame connection closed early"));
    });
  });

  return {
    port,
    token,
    completion,
    arm() {
      if (!timer && !settled) {
        timer = setTimeout(() => fail(new Error("Timed out receiving raw replay frames")), timeoutMs);
      }
    },
    async close() {
      if (timer) clearTimeout(timer);
      try { encoder?.kill(); } catch {}
      try { connectedSocket?.close(); } catch {}
      await new Promise(resolve => server.close(resolve));
      await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    }
  };
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
  const profile = getRenderProfile();
  const mark = createTimingLogger();
  const renderStartedAt = Date.now();
  const targetDuration = requestedClipDuration(url, clip);
  await fsp.mkdir(outputDir, { recursive: true });
  let rawFrameReceiver = null;
  if (profile.fast && targetDuration > 0) {
    rawFrameReceiver = await createRawFrameReceiver({
      outputPath,
      targetDurationSeconds: targetDuration,
      profile,
      mark,
      timeoutMs,
    });
  }
  let navigationUrl;
  try {
    const parsedUrl = new URL(url);
    parsedUrl.searchParams.set("clipExport", "1");
    if (profile.fast) {
      parsedUrl.searchParams.set("clipFast", "1");
      parsedUrl.searchParams.set("clipWidth", String(profile.exportWidth));
      parsedUrl.searchParams.set("clipHeight", String(profile.exportHeight));
      parsedUrl.searchParams.set("clipFps", String(profile.exportFps));
      if (rawFrameReceiver) {
        parsedUrl.searchParams.set("clipStreamPort", String(rawFrameReceiver.port));
        parsedUrl.searchParams.set("clipStreamToken", rawFrameReceiver.token);
      }
    }
    navigationUrl = parsedUrl.href;
  } catch {
    await rawFrameReceiver?.close().catch(() => {});
    throw new Error("Replay render requires a valid absolute URL");
  }
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tfc-replay-browser-"));
  const port = await reservePort();
  const browser = spawnImpl(browserPath, [
    "--headless=new",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    ...(rawFrameReceiver ? ["--allow-running-insecure-content"] : []),
    ...(rawFrameReceiver ? [
      "--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessChecks,PrivateNetworkAccessSendPreflights,LocalNetworkAccessChecks"
    ] : []),
    `--window-size=${profile.width},${profile.height}`,
    "--force-device-scale-factor=1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"] });
  mark(`Chrome spawned (${profile.width}x${profile.height}, ${profile.fps}fps, fast=${profile.fast})`);

  let cdp = null;
  try {
    const target = await waitForDevTools(port, fetchImpl, timeoutMs);
    mark("Chrome DevTools ready");
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
    await cdp.command("Page.navigate", { url: navigationUrl });
    mark("Replay page navigation started");

    await waitFor(async () => {
      const result = await cdp.command("Runtime.evaluate", {
        expression: `(() => {
          const button = document.querySelector("#replay-clip-download");
          const editor = document.querySelector("#replay-clip-editor");
          return {
            ready: Boolean(button && !button.disabled && editor && !editor.hidden),
            mode: document.documentElement.dataset.replayClipMode || ""
          };
        })()`,
        returnByValue: true,
      });
      const readiness = result.result?.value;
      if (!readiness?.ready) return false;
      if (readiness.mode !== "direct") {
        throw new Error(
          `Replay page did not enter direct export mode (reported ${readiness.mode || "unknown"})`
        );
      }
      return true;
    }, { timeoutMs, label: "replay clip editor" });
    mark("Replay clip editor ready (direct export mode confirmed)");
    const readyDiagnostics = await replayPageDiagnostics(cdp);
    mark(
      `Replay page state (mode=${readyDiagnostics?.mode || "unknown"}, ` +
      `preview passes=${readyDiagnostics?.previewPasses ?? "unknown"})`
    );
    mark(`Replay page load milestones (${formatPageMilestones(readyDiagnostics, [
      "replay-metadata-loaded",
      "replay-telemetry-loaded",
      "replay-data-load-end",
      "map-load-end",
      "editor-ready"
    ])})`);

    await cdp.command("Runtime.evaluate", {
      expression: "document.querySelector('#replay-clip-download').click()",
    });
    rawFrameReceiver?.arm();
    mark("Replay download clicked");

    if (rawFrameReceiver) {
      await wait(750);
      const initialDiagnostics = await replayPageDiagnostics(cdp);
      const initialExportError = [...(initialDiagnostics?.events || [])]
        .reverse()
        .find(event => event.name === "export-error");
      if (initialExportError) {
        throw new Error(`Replay page raw-frame export failed: ${initialExportError.message || "unknown error"}`);
      }
      const result = await rawFrameReceiver.completion;
      mark("Raw replay frame stream encoded");
      const exportDiagnostics = await replayPageDiagnostics(cdp);
      mark(
        `Replay page export state (preview passes=${exportDiagnostics?.previewPasses ?? "unknown"}, ` +
        `export passes=${exportDiagnostics?.exportPasses ?? "unknown"}, ` +
        `mode=${exportDiagnostics?.lastExportMode || "unknown"})`
      );
      mark(`Replay page export milestones (${formatPageMilestones(exportDiagnostics, [
        "export-render-start",
        "raw-frame-stream-start",
        "raw-frame-stream-end",
        "export-render-end",
        "raw-frame-encode-complete"
      ])})`);
      mark("Render complete");
      return result;
    }

    // Do not depend on Page.downloadWillBegin/Page.downloadProgress: those
    // events are absent or inconsistent in some headless Chrome builds.
    const downloadedPath = await waitFor(async () => {
      const entries = await fsp.readdir(outputDir, { withFileTypes: true });
      for (const entry of entries) {
        // Chromium can leave auxiliary pages such as downloads.html in the
        // directory. Only the named media artifact is eligible here.
        if (!entry.isFile() || !/\.(?:webm|mjpg)$/i.test(entry.name)) continue;
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
          if (entry.name.toLowerCase().endsWith(".webm") && await isWebmFile(candidate)) return candidate;
          if (entry.name.toLowerCase().endsWith(".mjpg") && await isMjpegFile(candidate)) return candidate;
          throw new Error(`Downloaded replay artifact has an invalid header: ${entry.name}`);
        }
      }
      return null;
    }, { timeoutMs, label: "downloaded replay artifact" });
    mark("Replay artifact appeared");
    await waitFor(async () => {
      try {
        const stat = await fsp.stat(downloadedPath);
        return stat.size > 0;
      } catch {
        return false;
      }
    }, { timeoutMs, label: "downloaded replay artifact" });
    mark("Replay artifact finished writing");
    const exportDiagnostics = await replayPageDiagnostics(cdp);
    mark(
      `Replay page export state (preview passes=${exportDiagnostics?.previewPasses ?? "unknown"}, ` +
      `export passes=${exportDiagnostics?.exportPasses ?? "unknown"}, ` +
      `mode=${exportDiagnostics?.lastExportMode || "unknown"})`
    );
    mark(`Replay page export milestones (${formatPageMilestones(exportDiagnostics, [
      "export-render-start",
      "webcodecs-start",
      "webcodecs-end",
      "export-render-end",
      "webm-finalized",
      "webm-download",
      "frame-stream-start",
      "frame-stream-end",
      "frame-stream-finalized",
      "frame-stream-download"
    ])})`);
    if (targetDuration > 0) {
      if (downloadedPath.toLowerCase().endsWith(".mjpg")) {
        const result = await encodeMjpegFrames(
          downloadedPath,
          outputPath,
          targetDuration,
          profile,
          mark,
        );
        mark("Render complete");
        return result;
      }
      const result = await normalizeWebmDuration(
        downloadedPath,
        outputPath,
        targetDuration,
        profile,
        mark,
      );
      mark("Render complete");
      return result;
    }
    if (downloadedPath !== outputPath) await fsp.rename(downloadedPath, outputPath);
    mark("Render complete");
    return outputPath;
  } finally {
    try { await cdp?.command("Browser.close"); } catch {}
    cdp?.close();
    browser.kill?.();
    await rawFrameReceiver?.close().catch(() => {});
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
  createRawFrameReceiver,
  isMjpegFile,
  isWebmFile,
  renderReplayClip,
  resolveBrowserExecutable,
};
