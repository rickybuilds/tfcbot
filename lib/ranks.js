"use strict";

// Single source of truth for Elo bands used by commands and display helpers.
const RANK_BANDS = Object.freeze([
  { rank: "NR", min: -1000, max: 300, label: "Not Ranked" },
  { rank: "1", min: 301, max: 720 },
  { rank: "2", min: 721, max: 1050 },
  { rank: "3", min: 1051, max: 1390 },
  { rank: "4", min: 1391, max: 1640 },
  { rank: "5", min: 1641, max: 2000 },
  { rank: "6", min: 2001, max: 2460 },
  { rank: "7", min: 2461, max: 2730 },
  { rank: "8", min: 2731, max: 3010 },
  { rank: "9", min: 3011, max: 3200 },
  { rank: "10", min: 3201, max: 3599 },
  { rank: "S", min: 3600, max: Infinity },
]);

function normalizedRating(rating) {
  const value = Number(rating);
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function getRankBand(rating) {
  const value = normalizedRating(rating);
  return RANK_BANDS.find((band) => value >= band.min && value <= band.max)
    || RANK_BANDS[0];
}

function rankFromRating(rating) {
  return getRankBand(rating).rank;
}

function getNextRank(rating) {
  const value = normalizedRating(rating);
  const index = RANK_BANDS.findIndex((band) => value >= band.min && value <= band.max);
  const currentIndex = index >= 0 ? index : 0;
  const current = RANK_BANDS[currentIndex];

  if (current.rank === "S") return { band: "S", next: "S", need: 0 };

  const next = RANK_BANDS[currentIndex + 1];
  return {
    band: current.rank,
    next: next.rank,
    need: Math.max(0, next.min - value),
  };
}

module.exports = {
  RANK_BANDS,
  normalizedRating,
  getRankBand,
  rankFromRating,
  getNextRank,
};
