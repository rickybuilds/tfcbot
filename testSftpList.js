// testSftpList.js
"use strict";

require("dotenv").config();
const SFTPClient = require("ssh2-sftp-client");

(async () => {
  const sftp = new SFTPClient();
  try {
    const cfg = {
      host: process.env.HL_SSH_HOST,
      port: Number(process.env.HL_SSH_PORT || 22),
      username: process.env.HL_SSH_USER,
    };

    if (process.env.HL_SSH_KEY_PATH) {
      const fs = require("fs");
      cfg.privateKey = fs.readFileSync(process.env.HL_SSH_KEY_PATH);
      if (process.env.HL_SSH_KEY_PASSPHRASE) {
        cfg.passphrase = process.env.HL_SSH_KEY_PASSPHRASE;
      }
    } else if (process.env.HL_SSH_PASS || process.env.HL_SSH_PASSWORD) {
      cfg.password = process.env.HL_SSH_PASS || process.env.HL_SSH_PASSWORD;
    }

    console.log("[TEST] Connecting with config:", {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      usingPassword: !!cfg.password,
      usingKey: !!cfg.privateKey,
    });

    await sftp.connect(cfg);

    const remoteDir = process.env.HL_REMOTE_LOG_DIR || "logs";
    console.log(`[TEST] Listing remote dir: ${remoteDir}`);

    const list = await sftp.list(remoteDir);
    list.forEach(f =>
      console.log(`- ${f.name} (${f.size} bytes, ${f.modifyTime})`)
    );

    await sftp.end();
    console.log("[TEST] Done.");
  } catch (err) {
    console.error("[TEST ERROR]", err);
    process.exit(1);
  }
})();
