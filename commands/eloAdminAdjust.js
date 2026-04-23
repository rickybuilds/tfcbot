// commands/eloAdminAdjust.js
"use strict";

const {
  isAdmin,
  isEloManager,
  inEloAdminChannel,
} = require("../lib/guards");

function register(reg, { elo }) {
  // !setelo @user 1800
  // !setelo <discordId> <rating>
  reg.set("setelo", async (message, args = []) => {
    if (!inEloAdminChannel(message)) return; // only allow in Elo Admin channel
    if (!isEloManager(message)) {
      return message.channel.send("⛔ Elo managers only.");
    }

    const user = message.mentions?.users?.first();
    let discordId, rating;

    if (user) {
      // Case 1: Mention
      discordId = user.id;
      rating = parseInt(args[1], 10);
    } else {
      // Case 2: Raw ID
      discordId = args[0];
      rating = parseInt(args[1], 10);
    }

    if (!discordId || !Number.isFinite(rating)) {
      return message.channel.send(
        "Usage: `!setelo @user <rating>` or `!setelo <discordId> <rating>`"
      );
    }

    // --- NEW: safer name lookup ---
    let displayName = null;

    // 1️⃣ Check guild cache
    const cached = message.guild?.members?.cache?.get(discordId);
    if (cached) {
      displayName = cached.displayName;
    } else {
      // 2️⃣ Try fetching full member from API
      try {
        const fetched = await message.guild.members.fetch(discordId);
        if (fetched) displayName = fetched.displayName;
      } catch {
        // 3️⃣ Fallbacks
        if (user) {
          displayName = user.username;
        } else {
          // Try to fetch user globally (outside guild)
          try {
            const fetchedUser = await message.client.users.fetch(discordId);
            if (fetchedUser) displayName = fetchedUser.username;
          } catch {
            displayName = String(discordId); // last-ditch fallback
          }
        }
      }
    }

    const res = elo.setRatingAdmin(discordId, rating, displayName);

    await message.channel.send(
      `✅ Set Elo for <@${discordId}> (${displayName || discordId}): **${res.before} → ${res.after}** (Δ ${
        res.delta >= 0 ? "+" : ""
      }${res.delta})`
    );
  });

  // !bumpelo @user +25
  // !bumpelo <discordId> <delta>
  reg.set("bumpelo", async (message, args = []) => {
    if (!inEloAdminChannel(message)) return; // only allow in Elo Admin channel
    if (!isEloManager(message)) {
      return message.channel.send("⛔ Elo managers only.");
    }

    const user = message.mentions?.users?.first();
    let discordId, delta;

    if (user) {
      discordId = user.id;
      delta = parseInt(args[1], 10);
    } else {
      discordId = args[0];
      delta = parseInt(args[1], 10);
    }

    if (!discordId || !Number.isFinite(delta)) {
      return message.channel.send(
        "Usage: `!bumpelo @user <delta>` or `!bumpelo <discordId> <delta>`"
      );
    }

    const displayName =
      message.guild?.members?.cache?.get(discordId)?.displayName ||
      (user ? user.username : null);

    const res = elo.bump(
      discordId,
      delta,
      `admin-bump-${Date.now()}`,
      displayName
    );

    await message.channel.send(
      `✅ Bumped Elo for <@${discordId}>: **${res.before} → ${res.after}** (Δ ${
        res.delta >= 0 ? "+" : ""
      }${res.delta})`
    );
  });

  // !eloof @user
  // !eloof <discordId>
  reg.set("eloof", async (message, args = []) => {
    if (!inEloAdminChannel(message)) return; // only allow in Elo Admin channel
    if (!isAdmin(message)) {
      return message.channel.send("⛔ Admins only.");
    }

    const user = message.mentions?.users?.first();
    const discordId = user ? user.id : args[0];

    if (!discordId) {
      return message.channel.send("Usage: `!eloof @user` or `!eloof <discordId>`");
    }

    const r = elo.peekRating(discordId);
    await message.channel.send(`📈 Elo for <@${discordId}>: **${r}**`);
  });

  // !setname <discordId> <newDisplayName>
  reg.set("setname", async (message, args = []) => {
    if (!inEloAdminChannel(message)) return; // only allow in Elo Admin channel
    if (!isEloManager(message)) {
      return message.channel.send("⛔ Elo managers only.");
    }

    const discordId = args[0];
    const newName = args.slice(1).join(" ").trim();

    if (!discordId || !newName) {
      return message.channel.send("Usage: `!setname <discordId> <newDisplayName>`");
    }

    try {
      const result = elo.setDisplayName(discordId, newName);
      await message.channel.send(
        `✅ Updated display name for <@${discordId}> → **${newName}** (current Elo: ${result.rating})`
      );
    } catch (err) {
      console.error(err);
      await message.channel.send("⚠️ Failed to update display name.");
    }
  });
}

module.exports = { register };
