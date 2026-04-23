// lib/balance.js
"use strict";

/**
 * Balance players into two teams with the closest Elo sum.
 * Uses raw Elo values only (ignores privacy masking).
 *
 * @param {Array} players - Array of player objects, each with {id, name}.
 * @param {Object} elo - Elo manager instance, must expose getRating(id, name).
 * @returns {Object} - Teams and stats { blue, red, sumBlue, sumRed, avgBlue, avgRed, diff }.
 */
function makeBalancedTeams(players, elo) {
  const n = players.length;
  if (n <= 1) {
    return {
      blue: players.slice(),
      red: [],
      sumBlue: 0,
      sumRed: 0,
      avgBlue: 0,
      avgRed: 0,
      diff: 0
    };
  }

  const k = Math.ceil(n / 2);

  // Fetch raw ratings from Elo (ignore privacy, never return "Hidden")
  const ratings = players.map(p => {
    const r = elo.getRating(p.id, p.name, { createIfMissing: true });
    return (typeof r === "number" && !isNaN(r)) ? r : 1941; // fallback to default if DB missing
  });

  const total = ratings.reduce((a, b) => a + b, 0);

  let best = null;

  function dfs(i, picked, sum) {
    if (picked.length === k) {
      const blueSet = new Set(picked);
      const blueIdx = [...picked].sort((a, b) => a - b);
      const redIdx = [];
      for (let t = 0; t < n; t++) if (!blueSet.has(t)) redIdx.push(t);
      const sumBlue = sum;
      const sumRed = total - sumBlue;
      const diff = Math.abs(sumBlue - sumRed);
      if (!best || diff < best.diff) {
        best = { blueIdx, redIdx, sumBlue, sumRed, diff };
      }
      return;
    }
    if (i >= n) return;
    const remaining = n - i;
    const need = k - picked.length;
    if (remaining < need) return;
    dfs(i + 1, picked.concat(i), sum + ratings[i]);
    dfs(i + 1, picked, sum);
  }

  // Start DFS with first player always on Blue to avoid mirror duplicates
  dfs(1, [0], ratings[0]);

  // Attach raw rating to each player object for downstream use
  const blue = best.blueIdx.map(i => ({ ...players[i], rating: ratings[i] }));
  const red = best.redIdx.map(i => ({ ...players[i], rating: ratings[i] }));
  const avgBlue = Math.round(best.sumBlue / blue.length);
  const avgRed = Math.round(best.sumRed / red.length);

  return {
    blue,
    red,
    sumBlue: best.sumBlue,
    sumRed: best.sumRed,
    avgBlue,
    avgRed,
    diff: best.diff
  };
}

module.exports = { makeBalancedTeams };
