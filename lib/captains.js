"use strict";

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");

// Fixed six-player draft order: Team 1, Team 2, Team 1, Team 2, Team 2, Team 1.
const PICK_ORDER = ["blue", "red", "blue", "red", "red", "blue"];
const RPS_CHOICES = ["rock", "paper", "scissors"];

function pickOrderFor(firstTeam) {
  return PICK_ORDER.slice();
}

function captainIds(players) {
  return (players || []).filter(p => p.captain).map(p => String(p.id));
}

function isCaptainMode(players) {
  return captainIds(players).length === 2;
}

function buildDraftDescription({ captains, teams, remaining, activeTeam, pickIndex }) {
  const team = id => (teams[id] || []).map(p => `<@${p.id}>`).join(", ") || "_empty_";
  const waiting = remaining.map(p => `<@${p.id}>`).join(", ") || "_none_";
  const active = captains[activeTeam];
  return [
    `**Pick ${pickIndex + 1}/${PICK_ORDER.length}** — Team ${activeTeam === "blue" ? "1" : "2"} captain <@${active.id}> is picking.`,
    `Click a player button below. Only <@${active.id}> can make this pick.`,
    "",
    `**Team 1 🔵:** ${team("blue")}`,
    `**Team 2 🔴:** ${team("red")}`,
    `**Remaining:** ${waiting}`,
  ].join("\n");
}

async function runCaptainDraft(message, players, { reminderMs = 60000, cancelToken = null } = {}) {
  if (!isCaptainMode(players)) return null;

  const declaredCaptains = {
    blue: players.find(p => p.captain),
    red: players.filter(p => p.captain)[1],
  };
  const firstTeam = await runBlindRps(message, declaredCaptains, { reminderMs, cancelToken });
  const captains = firstTeam === "blue"
    ? declaredCaptains
    : { blue: declaredCaptains.red, red: declaredCaptains.blue };
  const pickOrder = pickOrderFor("blue");
  const remaining = players.filter(p => !p.captain).map(p => ({ ...p }));
  const teams = { blue: [captains.blue], red: [captains.red] };
  let pickIndex = 0;
  let draftMessage;

  const buttonRows = () => {
    const rows = [];
    for (let i = 0; i < remaining.length; i += 5) {
      const row = new ActionRowBuilder();
      remaining.slice(i, i + 5).forEach(player => {
        row.addComponents(new ButtonBuilder()
          .setCustomId(`captain_pick_${player.id}`)
          .setLabel(String(player.name || player.id).slice(0, 80))
          .setStyle(ButtonStyle.Primary));
      });
      rows.push(row);
    }
    return rows;
  };

  const edit = async () => {
    const activeTeam = pickOrder[pickIndex];
    await draftMessage.edit({
      embeds: [new EmbedBuilder()
        .setColor(activeTeam === "blue" ? 0x3498db : 0xed4245)
        .setTitle("Captain Draft")
        .setDescription(buildDraftDescription({
          captains, teams, remaining, activeTeam, pickIndex,
        }))],
      components: pickIndex < pickOrder.length ? buttonRows() : [],
    });
  };

  draftMessage = await message.channel.send({
    embeds: [new EmbedBuilder().setTitle("Captain Draft").setDescription("Starting captain draft…")],
    components: [],
  });
  await edit();

  return new Promise((resolve, reject) => {
    const collector = draftMessage.createMessageComponentCollector();
    const reminder = setInterval(() => {
      const activeTeam = pickOrder[pickIndex];
      draftMessage.channel.send(
        `⏰ <@${captains[activeTeam].id}> — you are the active captain. Please make the next draft pick.`
      ).catch(() => {});
    }, reminderMs);
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearInterval(reminder);
      collector.stop("finished");
      if (error) reject(error);
      else resolve(value);
    };
    if (cancelToken) {
      cancelToken.cancel = () => finish(new Error("Captain draft canceled"));
      if (cancelToken.cancelled) return finish(new Error("Captain draft canceled"));
    }

    collector.on("collect", async interaction => {
      const activeTeam = pickOrder[pickIndex];
      if (String(interaction.user.id) !== String(captains[activeTeam].id)) {
        await interaction.reply({ content: `It is <@${captains[activeTeam].id}>'s turn.`, ephemeral: true }).catch(() => {});
        return;
      }

      const playerId = String(interaction.customId).replace(/^captain_pick_/, "");
      const index = remaining.findIndex(p => String(p.id) === playerId);
      if (index < 0) {
        await interaction.reply({ content: "That player is no longer available.", ephemeral: true }).catch(() => {});
        return;
      }

      const [picked] = remaining.splice(index, 1);
      teams[activeTeam].push(picked);
      pickIndex += 1;
      await interaction.deferUpdate().catch(() => {});

      if (pickIndex >= pickOrder.length) {
        await draftMessage.edit({
          embeds: [new EmbedBuilder().setColor(0x57f287).setTitle("Captain Draft Complete")
            .setDescription(`**Team 1 🔵:** ${teams.blue.map(p => `<@${p.id}>`).join(", ")}\n**Team 2 🔴:** ${teams.red.map(p => `<@${p.id}>`).join(", ")}`)],
          components: [],
        }).catch(() => {});
        finish(null, { blue: teams.blue, red: teams.red, captains });
        return;
      }
      await edit().catch(error => finish(error));
    });

    collector.on("end", () => clearInterval(reminder));
  });
}

async function runBlindRps(message, captains, { reminderMs, cancelToken = null }) {
  const labels = { rock: "🪨 Rock", paper: "📄 Paper", scissors: "✂️ Scissors" };
  const beats = { rock: "scissors", paper: "rock", scissors: "paper" };

  for (let round = 1; ; round += 1) {
    const choices = new Map();
    const prompt = await message.channel.send({
      embeds: [new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle(`Captain RPS — Round ${round}`)
        .setDescription(`Both captains choose privately. The result will be revealed after both choices are locked.\n\nTeam 1: <@${captains.blue.id}>\nTeam 2: <@${captains.red.id}>`)],
      components: [new ActionRowBuilder().addComponents(
        ...RPS_CHOICES.map(choice => new ButtonBuilder()
          .setCustomId(`captain_rps_${choice}`)
          .setLabel(labels[choice])
          .setStyle(ButtonStyle.Primary))
      )],
    });

    const result = await new Promise((resolve, reject) => {
      const collector = prompt.createMessageComponentCollector();
      const reminder = setInterval(() => {
        const waiting = ["blue", "red"].filter(team => !choices.has(team));
        if (!waiting.length) return;
        prompt.channel.send(
          `⏰ ${waiting.map(team => `<@${captains[team].id}>`).join(" ")} — please submit your blind RPS choice.`
        ).catch(() => {});
      }, reminderMs);
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearInterval(reminder);
        collector.stop("complete");
        error ? reject(error) : resolve(value);
      };
      if (cancelToken) {
        cancelToken.cancel = () => finish(new Error("Captain RPS canceled"));
        if (cancelToken.cancelled) return finish(new Error("Captain RPS canceled"));
      }

      collector.on("collect", async interaction => {
        const uid = String(interaction.user.id);
        const team = uid === String(captains.blue.id) ? "blue" :
          uid === String(captains.red.id) ? "red" : null;
        const choice = String(interaction.customId).replace(/^captain_rps_/, "");
        if (!team || !RPS_CHOICES.includes(choice)) {
          await interaction.reply({ content: "Only the two captains can use these buttons.", ephemeral: true }).catch(() => {});
          return;
        }
        if (choices.has(team)) {
          await interaction.reply({ content: "Your RPS choice is already locked.", ephemeral: true }).catch(() => {});
          return;
        }

        choices.set(team, choice);
        await interaction.reply({ content: `Locked in: **${labels[choice]}**.`, ephemeral: true }).catch(() => {});
        if (choices.size < 2) return;

        const blueChoice = choices.get("blue");
        const redChoice = choices.get("red");
        const winner = blueChoice === redChoice
          ? null
          : beats[blueChoice] === redChoice ? "blue" : "red";
        await prompt.edit({
          embeds: [new EmbedBuilder()
            .setColor(winner ? 0x57f287 : 0x95a5a6)
            .setTitle(`Captain RPS — Round ${round}`)
            .setDescription(`Team 1 chose **${labels[blueChoice]}**\nTeam 2 chose **${labels[redChoice]}**\n\n${winner ? `Team ${winner === "blue" ? "1" : "2"} wins and picks first.` : "Tie — another blind round starts now."}`)],
          components: [],
        }).catch(() => {});
        finish(null, winner);
      });

      collector.on("end", () => clearInterval(reminder));
    });

    if (result) return result;
  }
}

module.exports = { PICK_ORDER, RPS_CHOICES, captainIds, isCaptainMode, pickOrderFor, runCaptainDraft };
