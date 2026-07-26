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

  function combinations(start, end) {
    const groups = Array.from({ length: end - start + 1 }, () => []);

    function collect(i, picked, sum) {
      if (i === end) {
        groups[picked.length].push({ indices: picked, sum });
        return;
      }
      collect(i + 1, picked.concat(i), sum + ratings[i]);
      collect(i + 1, picked, sum);
    }

    collect(start, [], 0);
    return groups;
  }

  function compareIndices(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }

  function consider(left, right) {
    const blueIdx = [0, ...left.indices, ...right.indices];
    const sumBlue = ratings[0] + left.sum + right.sum;
    const sumRed = total - sumBlue;
    const diff = Math.abs(sumBlue - sumRed);
    if (!best || diff < best.diff ||
        (diff === best.diff && compareIndices(blueIdx, best.blueIdx) < 0)) {
      const blueSet = new Set(blueIdx);
      const redIdx = [];
      for (let t = 0; t < n; t++) if (!blueSet.has(t)) redIdx.push(t);
      best = { blueIdx, redIdx, sumBlue, sumRed, diff };
    }
  }

  const middle = 1 + Math.floor((n - 1) / 2);
  const leftGroups = combinations(1, middle);
  const rightGroups = combinations(middle, n);

  for (let count = 0; count < rightGroups.length; count++) {
    rightGroups[count].sort((a, b) =>
      (a.sum - b.sum) || compareIndices(a.indices, b.indices)
    );
    rightGroups[count] = rightGroups[count].filter(
      (entry, i, entries) => i === 0 || entry.sum !== entries[i - 1].sum
    );
  }

  for (let leftCount = 0; leftCount < leftGroups.length; leftCount++) {
    const rightCount = k - 1 - leftCount;
    const entries = rightGroups[rightCount];
    if (!entries || !entries.length) continue;

    for (const left of leftGroups[leftCount]) {
      const target = total / 2 - ratings[0] - left.sum;
      let low = 0;
      let high = entries.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (entries[mid].sum < target) low = mid + 1;
        else high = mid;
      }
      if (low < entries.length) consider(left, entries[low]);
      if (low > 0) consider(left, entries[low - 1]);
    }
  }

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
