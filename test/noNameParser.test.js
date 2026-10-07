"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { uploadToNoNameParser } = require("../services/noNameParser");
async function server(t, handler) {
  const srv = http.createServer(handler);
  await new Promise(resolve => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { srv.closeAllConnections(); srv.close(resolve); }));
  return `http://127.0.0.1:${srv.address().port}`;
}
function log(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nn-parser-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "L001.log"); fs.writeFileSync(file, "sample log"); return file;
}
test("single-log HTTP upload authenticates and awaits JSON import without removing logs", async t => {
  const file = log(t); let imported = false;
  const baseUrl = await server(t, (req, res) => {
    assert.equal(req.url, "/api/parseGame"); assert.equal(req.headers.authorization, "Bearer secret");
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      assert.match(body, /name="logs\[\]"/); assert.match(body, /sample log/);
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ success: { path: "/matches/m1", api: "/api/matches/m1" }, result: { schemaVersion: 1, matchId: "m1", rounds: [{}] } }));
    });
  });
  const result = await uploadToNoNameParser({ paths: [file], matchId: "m1", baseUrl, token: "secret", importStats: async () => { await new Promise(r => setTimeout(r, 10)); imported = true; } });
  assert.equal(result.ok, true); assert.equal(imported, true); assert.equal(result.url, `${baseUrl}/matches/m1`); assert.equal(result.parser, "noname"); assert.equal(fs.existsSync(file), true);
});
test("HTTP errors, invalid JSON, oversized responses, mismatched match IDs and import failures fail safely", async t => {
  const file = log(t);
  for (const scenario of ["status", "json", "size", "mismatch", "import"]) {
    const baseUrl = await server(t, (req, res) => { req.resume(); req.on("end", () => {
      if (scenario === "status") { res.statusCode = 401; return res.end('{"error":"unauthorized"}'); }
      if (scenario === "json") return res.end("bad");
      if (scenario === "size") return res.end("x".repeat(1024));
      res.end(JSON.stringify({ success: { path: "/matches/m1" }, result: { schemaVersion: 1, matchId: scenario === "mismatch" ? "other" : "m1", rounds: [{}] } }));
    }); });
    const result = await uploadToNoNameParser({ paths: [file], matchId: "m1", baseUrl, maxResponseBytes: 512, importStats: () => { throw new Error("import blocked"); } });
    assert.equal(result.ok, false, scenario); assert.equal(fs.existsSync(file), true);
  }
});
test("missing input and invalid IDs are rejected before HTTP", async t => {
  const file = log(t);
  assert.equal((await uploadToNoNameParser({ paths: [], matchId: "m1", baseUrl: "http://127.0.0.1:1" })).ok, false);
  assert.equal((await uploadToNoNameParser({ paths: [file], matchId: "../bad", baseUrl: "http://127.0.0.1:1" })).ok, false);
});
test("stalled HTTP response is bounded by the upload timeout", async t => {
  const baseUrl = await server(t, req => req.resume());
  const result = await uploadToNoNameParser({ paths: [log(t)], matchId: "m1", baseUrl, timeoutMs: 25 });
  assert.equal(result.ok, false); assert.match(result.text, /abort/i);
});

test("three consumers receive original logs and local parser failure preserves them without env opt-in", async () => {
  const vm = require("node:vm");
  for (const ok of [true, false]) for (const maxLogs of [1, 2]) {
    const files = new Map(); const consumed = [];
    class SFTP { async connect() {} async list() { return [1, 2].map(n => ({ name: `L00${n}.log`, size: 102400, modifyTime: Math.floor(Date.now() / 1000) })); } async fastGet(remote, local) { files.set(local, 'Loading map "2fort"'); } async end() {} }
    class Form { append(key, value) { if (key === "logs[]") consumed.push(value); } getHeaders() { return {}; } }
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../services/hldsTransfer.js"), "utf8"), { module, console, AbortController, setTimeout, clearTimeout, process: { ...process, env: {}, cwd: process.cwd.bind(process) }, require: name => name === "ssh2-sftp-client" ? SFTP : name === "../lib/ensureDir" ? dir => dir : name === "fs" ? { readFileSync: file => files.get(file), unlinkSync: file => files.delete(file), createReadStream: file => { assert.ok(files.has(file)); return file; } } : name === "form-data" ? Form : name === "node-fetch" ? async () => { return { ok: true, status: 200, text: async () => '{"success":{"path":"http://tfcstats/result"}}' }; } : name.endsWith("noNameParser") ? { isConfigured: () => true, uploadToNoNameParser: async ({ paths }) => { for (const file of paths) assert.ok(files.has(file)); consumed.push("parser"); return { ok, parser: "noname" }; } } : require(name) });
    const result = await module.exports.downloadAndUploadLogs({ matchId: "m1", map: "2fort", maxLogs });
    assert.equal(result.upload.ok, maxLogs !== 1); assert.equal(result.noname.ok, ok); assert.equal(result.tfcstats.ok, true); assert.equal(consumed.length, maxLogs === 1 ? 2 : 5); assert.equal(files.size, ok ? 0 : maxLogs);
  }
});

test("casual own-parser failure still uploads the single log to TFCStats and preserves it", async () => {
  const vm = require("node:vm"); const files = new Map(); let uploads = 0;
  class SFTP { async connect() {} async list() { return [{ type: "-", name: "L001.log", size: 200000, modifyTime: Date.now() / 1000 }]; } async fastGet(remote, local) { files.set(local, 'Loading map "2fort"'); } async end() {} }
  class Form { append(key, value) { if (key === "logs[]") assert.ok(files.has(value)); } getHeaders() { return {}; } }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../services/hldsCasualLogs.js"), "utf8"), { module, console, AbortController, setTimeout, clearTimeout, process: { ...process, env: { NONAME_PARSER_URL: "http://parser" }, cwd: process.cwd.bind(process) }, require: name => name === "ssh2-sftp-client" ? SFTP : name === "../lib/ensureDir" ? dir => dir : name === "../config/rcon" ? { east: { ssh: { host: "test" } } } : name === "fs" ? { existsSync: file => files.has(file), readFileSync: file => files.get(file), unlinkSync: file => files.delete(file), createReadStream: file => file } : name === "form-data" ? Form : name === "node-fetch" ? async () => { uploads++; return { ok: true, status: 200, text: async () => '{"success":{"path":"http://tfcstats/result"}}' }; } : name.endsWith("noNameParser") ? { uploadToNoNameParser: async () => { throw new Error("offline"); } } : require(name) });
  const result = await module.exports.uploadCasualLogsForMap("2fort");
  assert.equal(uploads, 1); assert.equal(result.hampalyzerOk, false); assert.equal(result.nonameOk, false); assert.equal(result.tfcstatsOk, true); assert.equal(files.size, 1);
});

test("own-parser recaps keep the existing stats link without a duplicate parser link or scraper", async () => {
  const vm = require("node:vm"); let spawned = 0; const sent = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../services/discordUpload.js"), "utf8"), { module, console, process, require: name => name === "child_process" ? { spawn: () => { spawned++; return { unref() {} }; } } : name === "../config/rcon" ? {} : name === "./noNameParser" ? { isOwnParserUrl: url => url?.startsWith("http://parser/") } : require(name) });
  await module.exports.sendRecapWithDemos({ channels: { fetch: async () => ({ send: async payload => sent.push(payload) }) } }, "channel", { matchInfo: { matchId: "m1", server: "east" }, hampalyzer: { url: "http://parser/matches/m1" } });
  assert.equal(spawned, 0); assert.match(sent[0].embeds[0].data.description, /View NoName Stats/);
  assert.doesNotMatch(sent[0].embeds[0].data.description, /View No Name Parser|View Hampalyzer|http:\/\/parser/);
});

test("database-only parser accepts the configured existing website match URL", async t => {
  const baseUrl = await server(t, (req, res) => { req.resume(); req.on("end", () => res.end(JSON.stringify({ success: { path: "https://nonamepickup.servehalflife.com/match.html?id=m1", api: "/api/matches/m1" }, result: { matchId: "m1", schemaVersion: 1 } }))); });
  const result = await uploadToNoNameParser({ paths: [log(t)], matchId: "m1", baseUrl, importStats: () => ({ players: 1 }) });
  assert.equal(result.ok, true); assert.equal(result.url, "https://nonamepickup.servehalflife.com/match.html?id=m1");
});

test("recaps never invoke the legacy HTML importer for external Hampalyzer links", async () => {
  const vm = require("node:vm"); let spawned = 0; const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../services/discordUpload.js"), "utf8"), { module, console, process, require: name => name === "child_process" ? { spawn: () => { spawned++; return { unref() {} }; } } : name === "../config/rcon" ? {} : name === "./noNameParser" ? { isOwnParserUrl: () => false } : require(name) });
  await module.exports.sendRecapWithDemos({ channels: { fetch: async () => ({ send: async () => {} }) } }, "channel", { matchInfo: { matchId: "m1", server: "east" }, hampalyzer: { url: "https://app.hampalyzer.com/parsedlogs/old" } });
  assert.equal(spawned, 0);
});

test("pickup and casual local parsing starts while public uploads are unresolved and cleanup waits", async () => {
  const vm = require("node:vm");
  for (const casual of [false, true]) {
    const files = new Map(); let localStarted = false; let release;
    const publicGate = new Promise(resolve => { release = resolve; });
    class SFTP { async connect() {} async list() { return [1, 2].map(n => ({ type: "-", name: `L00${n}.log`, size: 200000, modifyTime: Date.now() / 1000 })); } async fastGet(remote, local) { files.set(local, 'Loading map "2fort"'); } async end() {} }
    class Form { append() {} getHeaders() { return {}; } }
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../services/${casual ? "hldsCasualLogs" : "hldsTransfer"}.js`), "utf8"), {
      module, console, AbortController, setTimeout, clearTimeout,
      process: { ...process, env: {}, cwd: process.cwd.bind(process) },
      require: name => name === "ssh2-sftp-client" ? SFTP : name === "../lib/ensureDir" ? dir => dir : name === "../config/rcon" ? { east: { ssh: { host: "test" } } } : name === "fs" ? { existsSync: file => files.has(file), readFileSync: file => files.get(file), unlinkSync: file => files.delete(file), createReadStream: file => file } : name === "form-data" ? Form : name === "node-fetch" ? async () => { await publicGate; return { ok: true, status: 200, text: async () => '{"success":{"path":"http://public/result"}}' }; } : name.endsWith("noNameParser") ? { uploadToNoNameParser: async () => { localStarted = true; return { ok: true, url: "http://local/result" }; } } : require(name),
    });
    const running = casual ? module.exports.uploadCasualLogsForMap("2fort") : module.exports.downloadAndUploadLogs({ matchId: "m1", map: "2fort" });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(localStarted, true, casual ? "casual parser" : "pickup parser");
      assert.equal(files.size, 2, "logs stay available until public uploads finish");
    } finally { release(); await running; }
    assert.equal(files.size, 0);
  }
});

test("public Hampalyzer and TFCStats uploads abort stalled headers and bodies", async t => {
  const vm = require("node:vm"); const file = log(t);
  for (const sendHeaders of [false, true]) {
    const baseUrl = await server(t, (req, res) => { req.resume(); req.on("end", () => { if (sendHeaders) { res.writeHead(200); res.write("partial response"); } setTimeout(() => res.end("late"), 150); }); });
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../services/hldsTransfer.js"), "utf8"), {
      module, console, AbortController, setTimeout, clearTimeout,
      process: { ...process, env: { HAMPALYZER_UPLOAD_URL: baseUrl, TFCSTATS_UPLOAD_URL: baseUrl }, cwd: process.cwd.bind(process) },
      require: name => name === "../lib/ensureDir" ? dir => dir : require(name),
    });
    for (const upload of [module.exports.uploadToHampalyzer, module.exports.uploadToTFCStats]) {
      const start = Date.now();
      const result = await upload({ paths: [file, file], matchId: "m1", timeoutMs: 25 });
      assert.equal(result.ok, false); assert.match(result.text, /abort/i);
      assert.ok(Date.now() - start < 1000, "deadline covers the entire HTTP upload/response");
      assert.equal(fs.existsSync(file), true);
    }
  }
});

test("casual public deadlines retain logs while the concurrent local import completes", async t => {
  const vm = require("node:vm");
  for (const sendHeaders of [false, true]) {
    const file = log(t); let localImported = false;
    const baseUrl = await server(t, (req, res) => { req.resume(); req.on("end", () => { if (sendHeaders) { res.writeHead(200); res.write("partial"); } setTimeout(() => res.end("late"), 150); }); });
    class SFTP { async connect() {} async list() { return [1, 2].map(n => ({ type: "-", name: `L00${n}.log`, size: 200000, modifyTime: Date.now() / 1000 })); } async fastGet(remote, local) { fs.writeFileSync(local, 'Loading map "2fort"'); } async end() {} }
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../services/hldsCasualLogs.js"), "utf8"), {
      module, console, AbortController, setTimeout, clearTimeout,
      process: { ...process, env: { HAMPALYZER_UPLOAD_URL: baseUrl, TFCSTATS_UPLOAD_URL: baseUrl }, cwd: process.cwd.bind(process) },
      require: name => name === "ssh2-sftp-client" ? SFTP : name === "../lib/ensureDir" ? () => path.dirname(file) : name === "../config/rcon" ? { east: { ssh: { host: "test" } } } : name.endsWith("noNameParser") ? { uploadToNoNameParser: async () => { localImported = true; return { ok: true, url: "http://local/result" }; } } : require(name),
    });
    const result = await module.exports.uploadCasualLogsForMap("2fort", { timeoutMs: 25 });
    assert.equal(localImported, true); assert.equal(result.nonameOk, true);
    assert.equal(result.hampalyzerOk, false); assert.equal(result.tfcstatsOk, false);
    assert.equal(fs.existsSync(path.join(path.dirname(file), "L001.log")), true);
    assert.equal(fs.existsSync(path.join(path.dirname(file), "L002.log")), true);
  }
});
