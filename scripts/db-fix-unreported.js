// (deprecated: unified to elo.db) "use strict";
const Database = require("better-sqlite3");
const path = require("path");

// change if your DB path differs
const dbPath = path.resolve(process.cwd(), "matches.db");
const db = new Database(dbPath);

const info = db.prepare(`
  UPDATE matches
     SET winner = NULL,
         score_blue = NULL,
         score_red  = NULL
   WHERE reported = 0
`).run();

console.log(`Fixed rows: ${info.changes}`);
