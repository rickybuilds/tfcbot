"use strict";

// Uploaded TFC class emojis. IDs keep mentions working even if renamed.
const TIERS = [
  [0, "Civilianold_tfc", "1564293690971652228"],
  [25, "Scoutold_tfc", "1564293700115234856"],
  [50, "Pyroold_tfc", "1564293698160824360"],
  [75, "Medicold_tfc", "1564293696659128322"],
  [100, "Spyold_tfc", "1564293703584059534"],
  [150, "Sniperold_tfc", "1564293701537239181"],
  [375, "Engineerold_tfc", "1564293694125903925"],
  [750, "Soldierold_tfc", "1564293702590009435"],
  [1125, "Demomanold_tfc", "1564293693098168400"],
  [1500, "Heavyold_tfc", "1564293696147689643"],
];

function winEmblem(wins) {
  const tier = TIERS.findLast(([minimum]) => Number(wins) >= minimum) || TIERS[0];
  return `<:${tier[1]}:${tier[2]}>`;
}

const statements = new WeakMap();

function queueWinEmblems(elo, playerIds) {
  const ids = [...new Set(playerIds.map(String))];
  if (!elo?.db || !ids.length) return new Map();
  try {
    let statement = statements.get(elo.db);
    if (!statement) {
      // Count outcomes, not positive Elo deltas; a duplicated roster ID is one win.
      statement = elo.db.prepare(`
        SELECT CAST(roster.value AS TEXT) AS player_id,
               COUNT(DISTINCT m.match_id) AS wins
        FROM matches m,
             json_each(CASE m.winner WHEN 'BLUE' THEN m.blue_ids
                                    WHEN 'RED' THEN m.red_ids ELSE '[]' END) roster
        WHERE m.status = 'completed'
          AND CAST(roster.value AS TEXT) IN (SELECT value FROM json_each(?))
        GROUP BY CAST(roster.value AS TEXT)
      `);
      statements.set(elo.db, statement);
    }
    const wins = new Map(statement.all(JSON.stringify(ids)).map(row => [row.player_id, row.wins]));
    return new Map(ids.map(id => [id, `${winEmblem(wins.get(id) || 0)} `]));
  } catch (error) {
    console.warn("[queue win emblems] Win history unavailable:", error.message);
    return new Map();
  }
}

module.exports = { winEmblem, queueWinEmblems };
