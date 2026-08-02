"use strict";

const fetchDefault = require("node-fetch");

const CALCULATION_VERSION = "elo-shadow-v1";
const DEFAULT_FORMULA_VERSION = "nn-mvp-v1";

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function parseIds(value) {
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function expectedScore(avgBlue, avgRed) {
  const difference = finiteNumber(avgBlue) - finiteNumber(avgRed);
  return 1 / (1 + Math.pow(10, -difference / 400));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + finiteNumber(value), 0) / values.length;
}

function populationDeviation(values, mean = average(values)) {
  if (!values.length) return 0;
  const variance = values.reduce((sum, value) => {
    const difference = finiteNumber(value) - mean;
    return sum + difference * difference;
  }, 0) / values.length;
  return Math.sqrt(variance);
}

function boundedShares(rawShares, minimum, maximum) {
  const count = rawShares.length;
  if (!count) return [];

  const minShare = clamp(finiteNumber(minimum, 0), 0, 1 / count);
  const maxShare = clamp(finiteNumber(maximum, 1), 1 / count, 1);
  const raw = rawShares.map(value => Math.max(0, finiteNumber(value)));
  const rawTotal = raw.reduce((sum, value) => sum + value, 0);
  const base = rawTotal > 0 ? raw.map(value => value / rawTotal) : raw.map(() => 1 / count);
  const result = Array(count).fill(null);
  let remaining = new Set(base.map((_value, index) => index));
  let remainingMass = 1;

  while (remaining.size) {
    const indices = [...remaining];
    const weightTotal = indices.reduce((sum, index) => sum + base[index], 0);
    const provisional = new Map(indices.map(index => [
      index,
      weightTotal > 0 ? remainingMass * base[index] / weightTotal : remainingMass / indices.length,
    ]));
    let fixedAny = false;

    for (const index of indices) {
      const value = provisional.get(index);
      if (value < minShare - 1e-12) {
        result[index] = minShare;
        remainingMass -= minShare;
        remaining.delete(index);
        fixedAny = true;
      } else if (value > maxShare + 1e-12) {
        result[index] = maxShare;
        remainingMass -= maxShare;
        remaining.delete(index);
        fixedAny = true;
      }
    }

    if (!fixedAny) {
      for (const index of indices) result[index] = provisional.get(index);
      remaining.clear();
    }
  }

  const total = result.reduce((sum, value) => sum + value, 0);
  if (total && Math.abs(total - 1) > 1e-10) {
    const adjustable = result.findIndex(value => value > minShare && value < maxShare);
    const index = adjustable >= 0 ? adjustable : result.length - 1;
    result[index] += 1 - total;
  }
  return result;
}

function roundedAllocation(pool, shares, stableKeys = []) {
  const sign = Math.sign(pool);
  const magnitude = Math.abs(Math.round(finiteNumber(pool)));
  if (!magnitude || !shares.length) return shares.map(() => 0);

  const exact = shares.map(share => Math.max(0, finiteNumber(share)) * magnitude);
  const allocated = exact.map(Math.floor);
  let remainder = magnitude - allocated.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({
    index,
    fraction: value - Math.floor(value),
    key: String(stableKeys[index] ?? index),
  })).sort((a, b) => b.fraction - a.fraction || a.key.localeCompare(b.key));

  for (let index = 0; index < remainder; index++) {
    allocated[order[index % order.length].index] += 1;
  }
  return allocated.map(value => value * sign);
}

function equalShares(count) {
  return count > 0 ? Array(count).fill(1 / count) : [];
}

function allocateTeam(players, pool, options = {}) {
  const alpha = finiteNumber(options.alpha, 0.35);
  const minimumShare = finiteNumber(options.minimumShare, 0.15);
  const maximumShare = finiteNumber(options.maximumShare, 0.35);
  const usePerformance = options.usePerformance !== false && players.every(player => Number.isFinite(player.score));
  let zScores = players.map(() => 0);
  let shares = equalShares(players.length);

  if (usePerformance && players.length) {
    const scores = players.map(player => player.score);
    const mean = average(scores);
    const deviation = populationDeviation(scores, mean);
    if (deviation > 0) {
      zScores = scores.map(score => clamp((score - mean) / deviation, -2, 2));
      const direction = pool < 0 ? -1 : 1;
      const weights = zScores.map(zScore => Math.exp(direction * alpha * zScore));
      const total = weights.reduce((sum, value) => sum + value, 0);
      shares = boundedShares(weights.map(value => value / total), minimumShare, maximumShare);
    }
  }

  const deltas = roundedAllocation(pool, shares, players.map(player => player.id));
  const ranks = [...players]
    .sort((a, b) => finiteNumber(b.score, -Infinity) - finiteNumber(a.score, -Infinity) || String(a.id).localeCompare(String(b.id)))
    .reduce((map, player, index) => map.set(String(player.id), index + 1), new Map());

  return players.map((player, index) => ({
    ...player,
    teamRank: Number.isFinite(player.score) ? ranks.get(String(player.id)) : null,
    zScore: zScores[index],
    share: shares[index],
    shadowDelta: deltas[index],
  }));
}

function calculateShadow(input, options = {}) {
  const blue = Array.isArray(input.blue) ? input.blue.map(player => ({ ...player, team: "BLUE" })) : [];
  const red = Array.isArray(input.red) ? input.red.map(player => ({ ...player, team: "RED" })) : [];
  if (!blue.length || !red.length) throw new Error("Shadow Elo requires both official teams");

  const avgBlue = average(blue.map(player => player.before));
  const avgRed = average(red.map(player => player.before));
  const expBlue = expectedScore(avgBlue, avgRed);
  const winner = String(input.winner || "").toLowerCase();
  const scoreBlue = winner === "blue" ? 1 : winner === "red" ? 0 : 0.5;
  const teamK = Math.max(1, finiteNumber(options.teamK, 80));
  const poolCap = Math.max(1, finiteNumber(options.poolCap, 120));
  const poolMultiplier = Math.max(0, finiteNumber(options.poolMultiplier, 1));
  const blueDirection = Math.sign(scoreBlue - expBlue);
  const poolMagnitude = Math.min(
    poolCap,
    Math.round(Math.abs(teamK * (scoreBlue - expBlue)) * poolMultiplier)
  );
  const bluePool = blueDirection * poolMagnitude;
  const redPool = -bluePool;
  const usePerformance = !input.fallbackReason;
  const allocationOptions = {
    alpha: options.alpha,
    minimumShare: options.minimumShare,
    maximumShare: options.maximumShare,
    usePerformance,
  };

  return {
    matchId: String(input.matchId),
    calculationVersion: CALCULATION_VERSION,
    formulaVersion: input.formulaVersion || null,
    calculatedAt: Math.floor(Date.now() / 1000),
    winner: winner || "tie",
    avgBlue,
    avgRed,
    expectedBlue: expBlue,
    expectedRed: 1 - expBlue,
    teamK,
    poolMultiplier,
    fallbackReason: input.fallbackReason || null,
    apiPlayerCount: finiteNumber(input.apiPlayerCount, 0),
    teams: {
      blue: allocateTeam(blue, bluePool, allocationOptions),
      red: allocateTeam(red, redPool, allocationOptions),
    },
    pools: { blue: bluePool, red: redPool },
  };
}

function signed(value) {
  const rounded = Math.round(finiteNumber(value));
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function readableFallback(reason) {
  const value = String(reason || "");
  const rowCount = value.match(/^performance_rows_(\d+)$/);
  if (rowCount) return `website returned ${rowCount[1]} performance rows (expected 8)`;
  const mappings = value.match(/^official_mappings_(\d+)_of_(\d+)$/);
  if (mappings) return `only ${mappings[1]} of ${mappings[2]} official players mapped uniquely`;
  if (value === "stats_import_timeout") return "player statistics were not finalized before the shadow timeout";
  if (value === "duplicate_or_missing_steam") return "a performance row had a duplicate or missing Steam ID";
  if (value === "ambiguous_discord_mapping") return "a Steam ID mapped to multiple official Discord players";
  if (value === "duplicate_discord_mapping") return "multiple performance rows mapped to one Discord player";
  if (value === "missing_final_score") return "a player was missing the No Name final score";
  if (value.startsWith("formula_")) return `unexpected No Name formula version: ${value.slice(8)}`;
  return value.replace(/_/g, " ") || "performance data failed validation";
}

function formatShadowMessage(snapshot) {
  const lines = [
    `🧪 **Elo V2 Shadow — ${snapshot.matchId}** *(no live Elo changed)*`,
    `Team pools: 🔵 **${signed(snapshot.pools.blue)}** / 🔴 **${signed(snapshot.pools.red)}** · ` +
      `odds ${Math.round(snapshot.expectedBlue * 100)}%/${Math.round(snapshot.expectedRed * 100)}% · ` +
      `performance ${snapshot.fallbackReason ? "equal-share fallback" : `\`${snapshot.formulaVersion}\``}`,
  ];

  for (const [teamKey, icon, label] of [["blue", "🔵", "Blue"], ["red", "🔴", "Red"]]) {
    lines.push(`${icon} **${label}**`);
    for (const player of snapshot.teams[teamKey]) {
      const score = Number.isFinite(player.score) ? ` · NN ${player.score.toFixed(2)} (#${player.teamRank})` : "";
      lines.push(`• <@${player.id}>: current **${signed(player.currentDelta)}** → shadow **${signed(player.shadowDelta)}**${score}`);
    }
  }

  if (snapshot.fallbackReason) lines.push(`⚠️ Fallback: ${readableFallback(snapshot.fallbackReason)}`);
  return lines.join("\n").slice(0, 1990);
}

class EloShadowService {
  constructor(options = {}) {
    if (!options.db?.prepare) throw new Error("EloShadowService requires a better-sqlite3 database");
    this.db = options.db;
    this.client = options.client || null;
    this.channelId = String(options.channelId || "");
    this.mode = String(options.mode || process.env.ELO_V2_MODE || "off").trim().toLowerCase();
    this.enabled = this.mode === "shadow";
    this.fetch = options.fetch || fetchDefault;
    this.baseUrl = String(options.baseUrl || process.env.NONAME_URL || "https://nonamepickup.servehalflife.com").replace(/\/+$/, "");
    this.formulaVersion = String(options.formulaVersion || process.env.ELO_SHADOW_FORMULA_VERSION || DEFAULT_FORMULA_VERSION);
    this.teamK = finiteNumber(options.teamK ?? process.env.ELO_V2_TEAM_K, 80);
    this.poolCap = finiteNumber(options.poolCap ?? process.env.ELO_V2_TEAM_POOL_CAP, 120);
    this.alpha = finiteNumber(options.alpha ?? process.env.ELO_V2_PERFORMANCE_ALPHA, 0.35);
    this.minimumShare = finiteNumber(options.minimumShare ?? process.env.ELO_V2_MIN_SHARE, 0.15);
    this.maximumShare = finiteNumber(options.maximumShare ?? process.env.ELO_V2_MAX_SHARE, 0.35);
    this.initialDelayMs = Math.max(0, finiteNumber(options.initialDelayMs ?? process.env.ELO_SHADOW_INITIAL_DELAY_MS, 15000));
    this.pollIntervalMs = Math.max(1000, finiteNumber(options.pollIntervalMs ?? process.env.ELO_SHADOW_POLL_MS, 15000));
    this.maxAttempts = Math.max(1, Math.round(finiteNumber(options.maxAttempts ?? process.env.ELO_SHADOW_MAX_ATTEMPTS, 40)));
    this.requestTimeoutMs = Math.max(1000, finiteNumber(options.requestTimeoutMs ?? process.env.ELO_SHADOW_HTTP_TIMEOUT_MS, 10000));
    this.requireLocalImport = options.requireLocalImport ?? true;
    this.logger = options.logger || console;
    this.active = new Map();
    this._ensureSchema();
  }

  _ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS elo_shadow_results (
        match_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        calculation_version TEXT NOT NULL DEFAULT '${CALCULATION_VERSION}',
        formula_version TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        api_player_count INTEGER,
        payload_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        calculated_at INTEGER,
        posted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_elo_shadow_status ON elo_shadow_results(status, updated_at);
    `);
  }

  start() {
    if (!this.enabled) {
      this.logger.info?.(`[elo-shadow] disabled (ELO_V2_MODE=${this.mode || "off"})`);
      return { enabled: false, resumed: 0 };
    }
    const pending = this.db.prepare(`
      SELECT match_id, status, payload_json
      FROM elo_shadow_results
      WHERE posted_at IS NULL AND status IN ('pending','retrying','calculated','post_failed')
      ORDER BY updated_at
    `).all();
    for (const row of pending) this.schedule(row.match_id, { delayMs: 1000 });
    this.logger.info?.(
      `[elo-shadow] enabled; channel=${this.channelId || "missing"}; resumed ${pending.length} pending match(es)`
    );
    return { enabled: true, resumed: pending.length };
  }

  schedule(matchId, options = {}) {
    if (!this.enabled) return { enabled: false };
    const id = String(matchId || "").trim();
    if (!id) throw new Error("Missing shadow match ID");
    const existing = this.db.prepare("SELECT status, posted_at FROM elo_shadow_results WHERE match_id=?").get(id);
    if (existing?.posted_at && !options.force) return { enabled: true, idempotent: true, status: existing.status };

    if (options.force) {
      this.db.prepare(`
        INSERT INTO elo_shadow_results(match_id,status,calculation_version,attempts,reason,payload_json,updated_at,calculated_at,posted_at)
        VALUES (?, 'pending', ?, 0, NULL, NULL, strftime('%s','now'), NULL, NULL)
        ON CONFLICT(match_id) DO UPDATE SET
          status='pending', calculation_version=excluded.calculation_version, attempts=0,
          reason=NULL, payload_json=NULL, updated_at=strftime('%s','now'), calculated_at=NULL, posted_at=NULL
      `).run(id, CALCULATION_VERSION);
    } else {
      this.db.prepare(`
        INSERT OR IGNORE INTO elo_shadow_results(match_id,status,calculation_version)
        VALUES (?, 'pending', ?)
      `).run(id, CALCULATION_VERSION);
    }

    if (this.active.has(id)) return { enabled: true, idempotent: true, status: "scheduled" };
    const delayMs = Math.max(0, finiteNumber(options.delayMs, this.initialDelayMs));
    const timer = setTimeout(() => {
      this.active.delete(id);
      this._process(id).catch(error => this.logger.error?.(`[elo-shadow] ${id} failed:`, error));
    }, delayMs);
    timer.unref?.();
    this.active.set(id, timer);
    return { enabled: true, scheduled: true };
  }

  async runNow(matchId) {
    const id = String(matchId);
    const timer = this.active.get(id);
    if (timer) clearTimeout(timer);
    this.active.delete(id);
    return this._process(id);
  }

  _localImportReady(matchId) {
    if (!this.requireLocalImport) return true;
    try {
      const row = this.db.prepare(`
        SELECT status FROM match_stat_imports WHERE match_id=?
      `).get(String(matchId));
      return String(row?.status || "").toLowerCase() === "ok";
    } catch {
      return false;
    }
  }

  _loadMatch(matchId) {
    const match = this.db.prepare(`
      SELECT match_id, winner, status, blue_ids, red_ids, mode, rng_multiplier
      FROM matches WHERE match_id=?
    `).get(String(matchId));
    if (!match) throw new Error("match_not_found");

    const blueIds = parseIds(match.blue_ids);
    const redIds = parseIds(match.red_ids);
    const officialIds = [...blueIds, ...redIds];
    const changes = this.db.prepare(`
      SELECT c.id, c.player_id, c.before, c.delta, r.display_name
      FROM rating_changes c
      LEFT JOIN ratings r ON r.player_id=c.player_id
      WHERE c.match_id=?
      ORDER BY c.id
    `).all(String(matchId));
    const latest = new Map();
    for (const change of changes) latest.set(String(change.player_id), change);
    const toPlayer = (id, team) => {
      const change = latest.get(String(id));
      return {
        id: String(id),
        name: change?.display_name || String(id),
        team,
        before: finiteNumber(change?.before, NaN),
        currentDelta: finiteNumber(change?.delta, 0),
        score: null,
        steamId: null,
      };
    };
    const blue = blueIds.map(id => toPlayer(id, "BLUE"));
    const red = redIds.map(id => toPlayer(id, "RED"));
    if (officialIds.length !== 8 || blue.length !== 4 || red.length !== 4) {
      throw new Error(`official_roster_${blue.length}v${red.length}`);
    }
    if ([...blue, ...red].some(player => !Number.isFinite(player.before))) {
      throw new Error("missing_v1_rating_snapshot");
    }
    return { match, blue, red, officialIds };
  }

  async _fetchPerformance(matchId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}/api/match/${encodeURIComponent(matchId)}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`performance_http_${response.status}`);
        error.retryable = response.status === 404 || response.status === 429 || response.status >= 500;
        throw error;
      }
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  _mapScores(roster, payload) {
    const matchPayload = payload?.match;
    const performance = matchPayload?.nn_mvp;
    if (!payload?.ok || String(matchPayload?.id) !== String(roster.match.match_id)) {
      return { ready: false, reason: "performance_match_not_ready" };
    }
    if (String(matchPayload?.status || "").toLowerCase() !== "completed" || performance?.available !== true) {
      return { ready: false, reason: "performance_not_available" };
    }
    if (String(performance.formula_version || "") !== this.formulaVersion) {
      return {
        ready: true,
        fallbackReason: `formula_${performance.formula_version || "missing"}`,
        formulaVersion: performance.formula_version || null,
        apiPlayerCount: Array.isArray(performance.players) ? performance.players.length : 0,
      };
    }

    const apiPlayers = Array.isArray(performance.players) ? performance.players : [];
    if (apiPlayers.length < 8) return { ready: false, reason: `performance_rows_${apiPlayers.length}` };
    const links = this.db.prepare(`
      SELECT discord_id, steam_id FROM player_steam_ids
    `).all();
    const discordBySteam = new Map();
    for (const link of links) {
      const steam = String(link.steam_id || "").trim().toUpperCase();
      if (!steam) continue;
      const ids = discordBySteam.get(steam) || new Set();
      ids.add(String(link.discord_id));
      discordBySteam.set(steam, ids);
    }

    const official = new Set(roster.officialIds);
    const mapped = new Map();
    let mappingProblem = null;
    const seenSteam = new Set();
    for (const apiPlayer of apiPlayers) {
      const steam = String(apiPlayer.steam_id || apiPlayer.player_key || "").trim().toUpperCase();
      if (!steam || seenSteam.has(steam)) {
        mappingProblem = mappingProblem || "duplicate_or_missing_steam";
        continue;
      }
      seenSteam.add(steam);
      const candidates = [...(discordBySteam.get(steam) || [])].filter(id => official.has(id));
      if (candidates.length !== 1) {
        if (candidates.length > 1) mappingProblem = mappingProblem || "ambiguous_discord_mapping";
        continue;
      }
      const discordId = candidates[0];
      if (mapped.has(discordId)) {
        mappingProblem = mappingProblem || "duplicate_discord_mapping";
        continue;
      }
      const score = Number(apiPlayer.final_score);
      if (!Number.isFinite(score)) {
        mappingProblem = mappingProblem || "missing_final_score";
        continue;
      }
      mapped.set(discordId, { score, steamId: steam });
    }

    let fallbackReason = null;
    if (apiPlayers.length !== 8) fallbackReason = `performance_rows_${apiPlayers.length}`;
    else if (mappingProblem) fallbackReason = mappingProblem;
    else if (mapped.size !== official.size) fallbackReason = `official_mappings_${mapped.size}_of_${official.size}`;

    for (const player of [...roster.blue, ...roster.red]) {
      const score = mapped.get(player.id);
      if (score) Object.assign(player, score);
    }
    return {
      ready: true,
      formulaVersion: performance.formula_version,
      apiPlayerCount: apiPlayers.length,
      fallbackReason,
    };
  }

  _persistSnapshot(snapshot) {
    this.db.prepare(`
      UPDATE elo_shadow_results
      SET status='calculated', calculation_version=?, formula_version=?, reason=?,
          api_player_count=?, payload_json=?, updated_at=strftime('%s','now'), calculated_at=?
      WHERE match_id=?
    `).run(
      snapshot.calculationVersion,
      snapshot.formulaVersion,
      snapshot.fallbackReason,
      snapshot.apiPlayerCount,
      JSON.stringify(snapshot),
      snapshot.calculatedAt,
      snapshot.matchId
    );
  }

  async _post(snapshot) {
    if (!this.channelId) throw new Error("missing_recap_channel");
    let channel = this.client?.channels?.cache?.get?.(this.channelId);
    if (!channel) channel = await this.client?.channels?.fetch?.(this.channelId);
    if (!channel?.send) throw new Error("recap_channel_unavailable");
    await channel.send(formatShadowMessage(snapshot));
    this.db.prepare(`
      UPDATE elo_shadow_results
      SET status='posted', posted_at=strftime('%s','now'), updated_at=strftime('%s','now')
      WHERE match_id=?
    `).run(snapshot.matchId);
    this.logger.info?.(`[elo-shadow] posted ${snapshot.matchId}`);
    return snapshot;
  }

  _attemptCount(matchId) {
    this.db.prepare(`
      UPDATE elo_shadow_results
      SET attempts=attempts+1, status='retrying', updated_at=strftime('%s','now')
      WHERE match_id=?
    `).run(String(matchId));
    return this.db.prepare("SELECT attempts FROM elo_shadow_results WHERE match_id=?").get(String(matchId))?.attempts || 1;
  }

  _scheduleRetry(matchId, reason) {
    this.db.prepare(`
      UPDATE elo_shadow_results SET status='retrying', reason=?, updated_at=strftime('%s','now') WHERE match_id=?
    `).run(String(reason), String(matchId));
    this.schedule(matchId, { delayMs: this.pollIntervalMs });
  }

  async _finalizeFallback(matchId, reason) {
    const roster = this._loadMatch(matchId);
    const snapshot = calculateShadow({
      matchId,
      winner: roster.match.winner,
      blue: roster.blue,
      red: roster.red,
      formulaVersion: null,
      apiPlayerCount: 0,
      fallbackReason: reason,
    }, this);
    this._persistSnapshot(snapshot);
    return this._post(snapshot);
  }

  async _process(matchId) {
    if (!this.enabled) return { enabled: false };
    const row = this.db.prepare("SELECT * FROM elo_shadow_results WHERE match_id=?").get(String(matchId));
    if (!row) {
      this.db.prepare("INSERT INTO elo_shadow_results(match_id,status,calculation_version) VALUES (?, 'pending', ?)")
        .run(String(matchId), CALCULATION_VERSION);
    } else if (row.posted_at) {
      return JSON.parse(row.payload_json || "null");
    } else if (row.payload_json && ["calculated", "post_failed"].includes(row.status)) {
      try {
        return await this._post(JSON.parse(row.payload_json));
      } catch (error) {
        this.db.prepare("UPDATE elo_shadow_results SET status='post_failed', reason=?, updated_at=strftime('%s','now') WHERE match_id=?")
          .run(error.message, String(matchId));
        this._scheduleRetry(matchId, `post_${error.message}`);
        return { retrying: true, reason: error.message };
      }
    }

    const attempts = this._attemptCount(matchId);
    if (!this._localImportReady(matchId)) {
      if (attempts >= this.maxAttempts) return this._finalizeFallback(matchId, "stats_import_timeout");
      this._scheduleRetry(matchId, "waiting_for_stats_import");
      return { retrying: true, reason: "waiting_for_stats_import" };
    }

    try {
      const roster = this._loadMatch(matchId);
      const payload = await this._fetchPerformance(matchId);
      const mapping = this._mapScores(roster, payload);
      if (!mapping.ready) {
        if (attempts >= this.maxAttempts) return this._finalizeFallback(matchId, mapping.reason);
        this._scheduleRetry(matchId, mapping.reason);
        return { retrying: true, reason: mapping.reason };
      }

      const snapshot = calculateShadow({
        matchId,
        winner: roster.match.winner,
        blue: roster.blue,
        red: roster.red,
        formulaVersion: mapping.formulaVersion,
        apiPlayerCount: mapping.apiPlayerCount,
        fallbackReason: mapping.fallbackReason,
      }, this);
      this._persistSnapshot(snapshot);
      return await this._post(snapshot);
    } catch (error) {
      const retryable = error.retryable !== false;
      if (!retryable || attempts >= this.maxAttempts) {
        try {
          return await this._finalizeFallback(matchId, error.message || "shadow_failed");
        } catch (fallbackError) {
          this.db.prepare("UPDATE elo_shadow_results SET status='failed', reason=?, updated_at=strftime('%s','now') WHERE match_id=?")
            .run(fallbackError.message, String(matchId));
          throw fallbackError;
        }
      }
      this._scheduleRetry(matchId, error.message || "performance_request_failed");
      return { retrying: true, reason: error.message };
    }
  }
}

module.exports = {
  CALCULATION_VERSION,
  DEFAULT_FORMULA_VERSION,
  EloShadowService,
  allocateTeam,
  boundedShares,
  calculateShadow,
  expectedScore,
  formatShadowMessage,
  roundedAllocation,
};
