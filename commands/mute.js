// commands/mute.js

const OWNER_IDS = new Set([
  "255834576742645761", // Ricky
  "468578577537826831", // Rufio
]);

async function sendAuditLog(message, context, content) {
  try {
    const auditChannelId = context.config?.channels?.audit;
    if (!auditChannelId) return;

    let auditChannel = message.guild?.channels?.cache?.get(auditChannelId);

    if (!auditChannel && message.client?.channels?.fetch) {
      try {
        auditChannel = await message.client.channels.fetch(auditChannelId);
      } catch {}
    }

    if (auditChannel) {
      await auditChannel.send({ content });
    }
  } catch (err) {
    console.error("[pickup_mute] Failed to log audit:", err);
  }
}

module.exports = {
  name: "mute",
  aliases: ["pmute", "pickupmute", "unmute", "punmute", "mutelist"],

  async execute(message, args, context = {}) {
    const db = context.matchesStore?.db;

    if (!db) {
      return message.reply("❌ DB not available for mute command.");
    }

    if (!OWNER_IDS.has(message.author.id)) {
      return message.reply("❌ Only bot owners may use this command.");
    }

    const content = message.content.trim();
    const cmd = content.split(/\s+/)[0].toLowerCase();

    if (cmd === "!mutelist") {
      db.all(
        `SELECT discord_id, muted_by, reason, created_at
         FROM pickup_mutes
         ORDER BY created_at DESC`,
        [],
        (err, rows) => {
          if (err) {
            console.error("[pickup_mute] mutelist failed:", err);
            return message.reply("❌ Failed to read mute list.");
          }

          if (!rows.length) {
            return message.reply("✅ Nobody is pickup-muted.");
          }

          const lines = rows.map(row => {
            const reason = row.reason ? ` — ${row.reason}` : "";
            return `<@${row.discord_id}> muted by <@${row.muted_by}>${reason}`;
          });

          return message.reply(`🔇 **Pickup-muted users:**\n${lines.join("\n")}`);
        }
      );

      return;
    }

    const user = message.mentions.users.first();

    if (!user) {
      return message.reply("Usage: `!mute @user [reason]` or `!unmute @user`");
    }

    if (user.bot) {
      return message.reply("❌ I am not pickup-muting bots.");
    }

    if (cmd === "!unmute" || cmd === "!punmute") {
      db.run(
        `DELETE FROM pickup_mutes WHERE discord_id = ?`,
        [user.id],
        async function (err) {
          if (err) {
            console.error("[pickup_mute] unmute failed:", err);
            return message.reply("❌ Failed to unmute user.");
          }

          context.state.pickupMutedUsers?.delete(String(user.id));

          await sendAuditLog(
            message,
            context,
            `🔊 **Pickup Unmute**\n` +
              `**User:** ${user} (${user.tag})\n` +
              `**By:** ${message.author} (${message.author.tag})`
          );

          return message.reply(`🔊 <@${user.id}> is no longer pickup-muted.`);
        }
      );

      return;
    }

    const reason = args.slice(1).join(" ").trim();

    db.run(
      `INSERT OR REPLACE INTO pickup_mutes
       (discord_id, muted_by, reason, created_at)
       VALUES (?, ?, ?, ?)`,
      [
        user.id,
        message.author.id,
        reason || null,
        Math.floor(Date.now() / 1000),
      ],
      async err => {
        if (err) {
          console.error("[pickup_mute] mute failed:", err);
          return message.reply("❌ Failed to mute user.");
        }

        context.state.pickupMutedUsers?.add(String(user.id));

        await sendAuditLog(
          message,
          context,
          `🔇 **Pickup Mute**\n` +
            `**User:** ${user} (${user.tag})\n` +
            `**By:** ${message.author} (${message.author.tag})\n` +
            `**Reason:** ${reason || "None provided"}`
        );

        return message.reply(
          `🔇 <@${user.id}> can now only use \`!add\`, \`!addadl\`, \`++\`, or \`**\`.`
        );
      }
    );
  },
};