// commands/jail.js
"use strict";

const ms = require("ms");
const { isAdmin } = require("../lib/guards");
const { sendAuditLog } = require("../lib/auditLog");

async function register(reg, deps) {
  const { config, jailStore } = deps;
  const JAIL_ROLE = config.roles.jail;

  reg.set("jail", async (message, args) => {
    if (!isAdmin(message)) return;

    const target = message.mentions.members.first();
    if (!target) {
      await message.channel.send("Please mention a user to jail.");
      return;
    }

    const durationStr = args[1];
    const reason = args.slice(2).join(" ") || "No reason provided";

    let durationMs = 0;
    try {
      durationMs = ms(durationStr);
    } catch {}
    if (!durationMs) {
      await message.channel.send("Invalid duration. Example: `!jail @user 12h reason here`");
      return;
    }

    const oldRoles = target.roles.cache
      .filter(r => r.name !== "@everyone")
      .map(r => r.id);

    try {
      // remove roles
for (const [, role] of target.roles.cache) {
  if (role.name === "@everyone") continue;
  if (role.managed) continue; // 🔒 skip managed roles (e.g. Server Booster, integrations)
  try {
    await target.roles.remove(role);
  } catch (err) {
    console.warn(`[jail] couldn't remove role ${role.name}:`, err.message);
  }
}

      // add jail role
      await target.roles.add(JAIL_ROLE).catch(() => {});

      // save to jailStore
      jailStore.set(target.id, {
        oldRoles,
        expires: Date.now() + durationMs,
        reason,
        admin: message.author.id,
      });

      const until = new Date(Date.now() + durationMs).toLocaleString();
      await message.channel.send(`${target} is now in Jail for ${durationStr} — "${reason}"`);

      // ------------------ audit log ------------------
      await sendAuditLog({
        client: message.client,
        channelId: config?.channels?.audit,
        payload: `⛓️ JAIL: <@${message.author.id}> jailed <@${target.id}> for ${durationStr} — "${reason}" (until ${until})`,
        errorMessage: "[jail audit] failed:",
      });
      // ------------------------------------------------
      
    } catch (err) {
      console.error("[!jail error]", err);
      await message.channel.send("Failed to jail user.");
    }
  });
}

module.exports = { register };
