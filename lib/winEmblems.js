"use strict";

// Uploaded TFC class emojis. IDs keep mentions working even if renamed.
const TIERS = [
  [0, "Civilianold_tfc", "1564265028343832616"],
  [25, "Scoutold_tfc", "1564265032873672744"],
  [50, "Pyrold_tfc", "1564265032018173992"],
  [75, "Medicold_tfc", "1564265031057678478"],
  [100, "Spyold_tfc", "1564265035935654038"],
  [150, "Sniperold_tfc", "1564265034291482694"],
  [375, "Engineerold_tfc", "1564265029711171717"],
  [750, "Soldierold_tfc", "1564265035109376040"],
  [1125, "Demomanold_tfc", "1564265028960653402"],
  [1500, "Heavyold_tfc", "1564265030516744224"],
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
