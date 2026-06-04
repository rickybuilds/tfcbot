// test_fetch.js — quick runner for services/hltvFetch.js
(async () => {
  try {
    const path = require("path");
    const { fetchAndZipRecentDemos, cleanupResult } = require("./services/hltvFetch");

    const preferMap = process.argv[2] || null;
    console.log("Starting fetchAndZipRecentDemos...", preferMap ? `preferred map=${preferMap}` : "(auto-select)");

    const res = await fetchAndZipRecentDemos({
      mapName: preferMap,
      lookback: 20,
      requiredCount: 2,
    });

    console.log("✅ FETCH OK");
    console.log("Zip path:", res.zipPath);
    console.log("Downloaded demos:");
    for (const d of res.demos) {
      console.log(" -", d.filename, "->", d.localPath);
    }
    console.log("Tmp dir:", res.tmpDir);

    // Option: keep files for inspection. If you want auto-cleanup, uncomment next line:
    // cleanupResult(res);

    process.exit(0);
  } catch (err) {
    console.error("FETCH ERROR:", err && err.message || err);
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  }
})();
