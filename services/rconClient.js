// services/rconClient.js - UDP for GoldSrc RCON
const Rcon = require("rcon");
const rconCfgs = require("../config/rcon");

/**
 * Run an RCON command against a configured server (UDP for GoldSrc).
 * @param {string} serverKey - e.g. "east"
 * @param {string} command - the command to run ("mp_timeleft", "status", etc.)
 * @param {number} [retries=2] - Number of retry attempts
 * @returns {Promise<string>} - the server's response
 */
async function runRconCommand(serverKey, command, retries = 2) {
  const cfg = rconCfgs[serverKey];
  if (!cfg) {
    throw new Error(`Unknown server key: ${serverKey}`);
  }

  // GoldSrc UDP mode: tcp: false, challenge: true
  const options = { 
    timeout: 10000,
    tcp: false,
    challenge: true
  };

  // Formatters for nicer output
  const formatters = {
    mp_timeleft: (raw) => {
      const secs = parseInt(raw.match(/(\d+)/)?.[1] || 0, 10);
      const mins = Math.floor(secs / 60);
      const remainingSecs = secs % 60;
      return `${mins}m ${remainingSecs}s left`;
    },
    status: (raw) => {
      const mapLine = raw.split("\n").find(l => l.toLowerCase().includes("map"));
      if (!mapLine) return "Map info not found";
      const parts = mapLine.split(":");
      if (parts.length > 1) {
        return `Map: ${parts[1].trim().split(" ")[0]}`;
      }
      return mapLine;
    },
    combined_timeleft: async (cfg, options) => {
      // Helper to run a single RCON command
      const run = (cmd) => new Promise((resolve, reject) => {
        const conn = new Rcon(cfg.host, cfg.port, cfg.password, options);
        let responses = [];
        let done = false;

        const finish = () => {
          if (done) return;
          done = true;
          try { conn.disconnect(); } catch {}
          resolve(responses.join("\n"));
        };

        conn.on("auth", () => conn.send(cmd));
        conn.on("response", (str) => { responses.push(str.trim()); setTimeout(finish, 300); });
        conn.on("error", (err) => reject(err));
        conn.on("end", finish);

        conn.connect();
      });

      const [statusRaw, timeRaw] = await Promise.all([
        run("status"),
        run("mp_timeleft"),
      ]);

      const map = formatters.status(statusRaw).replace("Map: ", "").trim();
      const time = formatters.mp_timeleft(timeRaw);

      return `Map: ${map}\nTimeleft: ${time}`;
    }
  };

  const attempt = (attemptNum) => new Promise((resolve, reject) => {
    const conn = new Rcon(cfg.host, cfg.port, cfg.password, options);

    let resolved = false;
    let authSent = false;
    let responses = [];
    let packetTimer;

    const finish = async () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(packetTimer);
      try { conn.disconnect(); } catch {}
      let fullResponse = responses.join("\n") || "No response from server";

      // Apply formatter
      if (formatters[command]) {
        try {
          if (formatters[command].constructor.name === "AsyncFunction") {
            fullResponse = await formatters[command](cfg, options);
          } else {
            fullResponse = formatters[command](fullResponse);
          }
        } catch {}
      }

      resolve(fullResponse);
    };

    conn.on("auth", () => {
      if (!authSent) {
        authSent = true;
        conn.send(command);

        if (/^(changelevel|map|amx_map)\s+/i.test(command)) {
          packetTimer = setTimeout(finish, 750);
        }
      }
    });

    conn.on("response", (str) => {
      if (resolved) return;
      const trimmed = str.trim();
      if (trimmed) {
        responses.push(trimmed);
      }
      clearTimeout(packetTimer);
      packetTimer = setTimeout(finish, 500); // finish after last packet
    });

    conn.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      if (attemptNum < retries && err.message.includes("ECONNREFUSED")) {
        const backoff = 3000 * attemptNum;
        setTimeout(() => attempt(attemptNum + 1).then(resolve).catch(reject), backoff);
      } else {
        reject(new Error(`RCON error (attempt ${attemptNum}): ${err.message}`));
      }
    });

    conn.on("end", () => {
      if (!resolved) finish();
    });

    // Global timeout
    setTimeout(() => {
      if (!resolved) {
        reject(new Error("RCON UDP timeout - server may be busy"));
        resolved = true;
        try { conn.disconnect(); } catch {}
      }
    }, 12000);

    conn.connect();
  });

  return attempt(1);
}

module.exports = { runRconCommand };
