"use strict";
function initializeSchema(db) {
 const initialize=()=>{
  require("../lib/matchDeletionAudit").initializeMatchDeletionAudit(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS prediction_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO prediction_meta VALUES ('schema_version','2');
    CREATE TABLE IF NOT EXISTS prediction_accounts (
      discord_id TEXT PRIMARY KEY, balance INTEGER NOT NULL CHECK(typeof(balance)='integer' AND balance BETWEEN 0 AND 9007199254740991), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS prediction_markets (
      id INTEGER PRIMARY KEY, match_id TEXT NOT NULL, revision INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('open','countdown','closed','settled','void','review_required')),
      snapshot TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'pregame', opened_at INTEGER NOT NULL,
      closes_at INTEGER, closed_at INTEGER, live_at INTEGER, phase_evidence TEXT,
      reason TEXT, result TEXT, observed_result TEXT, settlement_version INTEGER NOT NULL DEFAULT 0,
      allocation TEXT, paid_credits TEXT NOT NULL DEFAULT '{}', rule_version INTEGER NOT NULL DEFAULT 1,
      channel_id TEXT, message_id TEXT, deletion_authorized INTEGER NOT NULL DEFAULT 0,
      UNIQUE(match_id,revision)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS prediction_one_current ON prediction_markets(match_id) WHERE state NOT IN ('settled','void');
    CREATE INDEX IF NOT EXISTS prediction_deadlines ON prediction_markets(state,closes_at);
    CREATE TABLE IF NOT EXISTS prediction_bets (
      id INTEGER PRIMARY KEY, market_id INTEGER NOT NULL, discord_id TEXT NOT NULL,
      pick TEXT NOT NULL CHECK(pick IN ('blue','red','tie')), stake INTEGER NOT NULL CHECK(typeof(stake)='integer' AND stake BETWEEN 1 AND 9007199254740991),
      status TEXT NOT NULL CHECK(status IN ('active','cancelled','refunded','settled')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(market_id,discord_id)
    );
    CREATE INDEX IF NOT EXISTS prediction_market_bets ON prediction_bets(market_id,status);
    CREATE TABLE IF NOT EXISTS point_craps_rounds (
      id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, shooter TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('open','point','settled','cancelled')), point INTEGER, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS point_craps_active ON point_craps_rounds(guild_id,channel_id) WHERE state IN ('open','point');
    CREATE TABLE IF NOT EXISTS point_craps_bets (
      round_id INTEGER NOT NULL, user_id TEXT NOT NULL, pick TEXT NOT NULL CHECK(pick IN ('pass','dont')),
      stake INTEGER NOT NULL CHECK(stake BETWEEN 1 AND 100), status TEXT NOT NULL CHECK(status IN ('active','settled','refunded')),
      PRIMARY KEY(round_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS point_craps_places (
      round_id INTEGER NOT NULL, user_id TEXT NOT NULL, number INTEGER NOT NULL CHECK(number IN (4,5,6,8,9,10)),
      stake INTEGER NOT NULL CHECK(stake BETWEEN 1 AND 100), status TEXT NOT NULL CHECK(status IN ('active','lost','refunded')),
      PRIMARY KEY(round_id,user_id,number)
    );
    CREATE TABLE IF NOT EXISTS point_craps_wagers (
      id INTEGER PRIMARY KEY, round_id INTEGER NOT NULL, user_id TEXT NOT NULL,
      kind TEXT NOT NULL, number INTEGER, stake INTEGER NOT NULL CHECK(stake BETWEEN 1 AND 100),
      status TEXT NOT NULL DEFAULT 'active', phase TEXT NOT NULL DEFAULT 'pending',
      working TEXT NOT NULL DEFAULT 'auto', parent_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS point_craps_fire_hands (
      guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, shooter TEXT NOT NULL,
      made_mask INTEGER NOT NULL DEFAULT 0, started INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(guild_id,channel_id)
    );
    CREATE TABLE IF NOT EXISTS point_blackjack_rounds (
      id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, opener_id TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL CHECK(state IN ('joining','playing','settled','cancelled')),
      created_at INTEGER NOT NULL, deadline INTEGER NOT NULL, shoe TEXT NOT NULL, shoe_pos INTEGER NOT NULL DEFAULT 0,
      dealer_cards TEXT NOT NULL DEFAULT '[]', current_seat INTEGER, result TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS point_blackjack_active ON point_blackjack_rounds(guild_id,channel_id) WHERE state IN ('joining','playing');
    CREATE TABLE IF NOT EXISTS point_blackjack_seats (
      round_id INTEGER NOT NULL, seat INTEGER NOT NULL CHECK(seat BETWEEN 1 AND 5), user_id TEXT NOT NULL,
      stake INTEGER NOT NULL CHECK(stake BETWEEN 1 AND 500), status TEXT NOT NULL CHECK(status IN ('active','settled','refunded')),
      PRIMARY KEY(round_id,seat), UNIQUE(round_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS point_blackjack_hands (
      id INTEGER PRIMARY KEY, round_id INTEGER NOT NULL, user_id TEXT NOT NULL, seat INTEGER NOT NULL,
      hand_no INTEGER NOT NULL DEFAULT 1, cards TEXT NOT NULL, stake INTEGER NOT NULL CHECK(stake BETWEEN 1 AND 1000),
      state TEXT NOT NULL CHECK(state IN ('active','stood','bust','blackjack','settled')), result TEXT,
      doubled INTEGER NOT NULL DEFAULT 0, split_aces INTEGER NOT NULL DEFAULT 0,
      UNIQUE(round_id,seat,hand_no)
    );
    CREATE TABLE IF NOT EXISTS prediction_transactions (
      id INTEGER PRIMARY KEY, account_id TEXT, amount INTEGER NOT NULL CHECK(typeof(amount)='integer'), kind TEXT NOT NULL,
      market_id INTEGER, bet_id INTEGER, operation_key TEXT NOT NULL, entry_key TEXT NOT NULL,
      actor_id TEXT NOT NULL, reason TEXT, settlement_version INTEGER, metadata TEXT, created_at INTEGER NOT NULL,
      UNIQUE(operation_key,entry_key)
    );
    CREATE INDEX IF NOT EXISTS prediction_account_history ON prediction_transactions(account_id,created_at);
    CREATE INDEX IF NOT EXISTS prediction_settlement_history ON prediction_transactions(market_id,settlement_version);
    CREATE TRIGGER IF NOT EXISTS prediction_history_no_update BEFORE UPDATE ON prediction_transactions BEGIN SELECT RAISE(ABORT,'Prediction history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS prediction_history_no_delete BEFORE DELETE ON prediction_transactions BEGIN SELECT RAISE(ABORT,'Prediction history is append-only'); END;
  `);
  if(!db.prepare('PRAGMA table_info(point_craps_places)').all().some(c=>c.name==='working'))db.exec("ALTER TABLE point_craps_places ADD COLUMN working TEXT NOT NULL DEFAULT 'auto'");
  if(!db.prepare('PRAGMA table_info(point_craps_rounds)').all().some(c=>c.name==='roll_version'))db.exec('ALTER TABLE point_craps_rounds ADD COLUMN roll_version INTEGER NOT NULL DEFAULT 0');
  if(!db.prepare('PRAGMA table_info(point_blackjack_rounds)').all().some(c=>c.name==='opener_id'))db.exec("ALTER TABLE point_blackjack_rounds ADD COLUMN opener_id TEXT NOT NULL DEFAULT ''");
  const version=db.prepare("SELECT value FROM prediction_meta WHERE key='schema_version'").get().value;
  if(version==="1"){
    // V1's fixed CHECK prevents earned limits above 250. Keep every bet ID and
    // ledger reference while replacing only this feature's constraint atomically.
    db.exec(`
      CREATE TABLE prediction_bets_v2 (
        id INTEGER PRIMARY KEY, market_id INTEGER NOT NULL, discord_id TEXT NOT NULL,
        pick TEXT NOT NULL CHECK(pick IN ('blue','red','tie')), stake INTEGER NOT NULL CHECK(typeof(stake)='integer' AND stake BETWEEN 1 AND 9007199254740991),
        status TEXT NOT NULL CHECK(status IN ('active','cancelled','refunded','settled')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(market_id,discord_id)
      );
      INSERT INTO prediction_bets_v2 SELECT id,market_id,discord_id,pick,stake,status,created_at,updated_at FROM prediction_bets;
      DROP TABLE prediction_bets;
      ALTER TABLE prediction_bets_v2 RENAME TO prediction_bets;
      CREATE INDEX prediction_market_bets ON prediction_bets(market_id,status);
      UPDATE prediction_meta SET value='2' WHERE key='schema_version';
    `);
  }else if(version!=="2")throw new Error("Unsupported prediction schema version");
  db.exec("CREATE INDEX IF NOT EXISTS prediction_bet_progression ON prediction_bets(discord_id,status,market_id)");
  // A trigger protects every connection, including legacy MatchStore and purge paths.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='matches'").get()) db.exec(`
    CREATE TRIGGER IF NOT EXISTS prediction_match_delete_guard BEFORE DELETE ON matches
    WHEN EXISTS (SELECT 1 FROM prediction_markets WHERE match_id=OLD.match_id AND state!='void' AND deletion_authorized=0)
    BEGIN SELECT RAISE(ABORT,'Resolve prediction market before deleting match'); END;
  `);
 };
 return db.inTransaction?initialize():db.transaction(initialize).immediate();
}
module.exports={initializeSchema};
