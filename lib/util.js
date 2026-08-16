// lib/util.js
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const NUM_EMOJI = ["", "1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣"];
const NUM_SHORT = ["", ":one:", ":two:", ":three:", ":four:", ":five:", ":six:", ":seven:", ":eight:", ":nine:"];
const RANK_EMOJIS = [
  { min: 300,  max: 720,  emoji: "<:rank1:1410287215296254114>" },
  { min: 721,  max: 1050,  emoji: "<:rank2:1410288067075641526>" },
  { min: 1051, max: 1390, emoji: "<:rank3:1410288076525277345>" },
  { min: 1391, max: 1640, emoji: "<:rank4:1410288084406505523>" },
  { min: 1641, max: 2000, emoji: "<:rank5:1410288260961271879>" },
  { min: 2001, max: 2460, emoji: "<:rank6:1410288804027174983>" },
  { min: 2461, max: 2730, emoji: "<:rank7:1410289581319917668>" },
  { min: 2731, max: 3010, emoji: "<:rank8:1410290495376064552>" },
  { min: 3011, max: 3200, emoji: "<:rank9:1410291101578825858>" },
  { min: 3201, max: 3599, emoji: "<:rank10:1410291111141834894>" },
  { min: 3600, max: Infinity, emoji: "<:srank:1410291720343785694>" },
];


const isRealDiscordId = (id) => typeof id === "string" && /^\d{15,22}$/.test(id);
const mention = (id) => `<@${id}>`;
const clearAnyTimer = (t) => { try { clearTimeout(t); } catch {} try { clearInterval(t); } catch {} };
const emojiFor = (idx) => NUM_EMOJI[idx] || String(idx);


// Helper to map Elo → Emoji
function getRankEmoji(rating) {
  const r = Number(rating) || 1941;
  const found = RANK_EMOJIS.find(t => r >= t.min && r <= t.max);
  return found ? found.emoji : "";
}

function mirvLabel(tier) {
  const n = Number.isFinite(tier) ? tier : parseInt(tier, 10) || 0;
  return `${n} mirv${n === 1 ? "" : "s"}`;
}

function buildButtonsForHandle(handle) {
  const rows = [];
  const opts = handle.options || [];
  for (let i = 0; i < opts.length; i += 5) {
    const row = new ActionRowBuilder();
    opts.slice(i, i + 5).forEach((o, j) => {
      const idx = i + j + 1;
      const label = o.id === "N" ? `🆕 ${o.name}` : `${emojiFor(idx)} ${o.name}`;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`vote_${o.id}`)
          .setStyle(ButtonStyle.Primary)
          .setLabel(label)
      );
    });
    rows.push(row);
  }
  return rows;
}

function disableAllButtons(message) {
  if (!message?.components?.length) return [];
  return message.components.map((r) => {
    const row = new ActionRowBuilder();
    for (const c of r.components) {
      row.addComponents(ButtonBuilder.from(c).setDisabled(true));
    }
    return row;
  });
}

function genMatchId(len = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random()*alphabet.length)];
  return out;
}

/**
 * Return the canonical name stored for a player.  Discord display names are
 * only a fallback for players who have not been seeded in the Elo store yet.
 */
function getStoredPlayerName(elo, userId, fallbackName = "") {
  const id = String(userId || "");
  const fallback = String(fallbackName || "").trim();

  try {
    if (typeof elo?.getDisplayName === "function") {
      const stored = String(elo.getDisplayName(id, fallback) || "").trim();
      if (stored) return stored;
    }
  } catch {}

  return fallback || `Player#${id.slice(-4) || "????"}`;
}

/**
 * formatPlayerName(state, elo, id, name)
 * - Always shows name + Elo rating.
 */
function formatPlayerName(state, elo, userId, fallbackName, privacy, showRank = true) {
  const id = String(userId);
  const displayName = getStoredPlayerName(
    elo,
    id,
    fallbackName || (state?.nameOf ? state.nameOf({ id }) : null)
  );

  const hidden = privacy?.isHidden?.(id) || false;

  let rating = null;
  try {
    rating = Math.round(
      Number(elo.getRating(id, displayName, { createIfMissing: false })) || 1941
    );
  } catch {
    rating = 1941;
  }

  // 🔒 Force-disable ranks everywhere
  return `${displayName}`;
}



module.exports = {
  NUM_SHORT,
  isRealDiscordId,
  mention,
  clearAnyTimer,
  mirvLabel,
  buildButtonsForHandle,
  disableAllButtons,
  genMatchId,
  getStoredPlayerName,
  formatPlayerName,
};
