// setup-pingsdb.js
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbPath = path.resolve("/root/tfcbot-api/pings.db");
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS ping_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      server TEXT NOT NULL,
      median INTEGER NOT NULL
    )
  `);
  console.log("✅ pings.db setup complete");
});

db.close();
