'use strict';

const numbers = [4, 5, 6, 8, 9, 10];
const dice = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const quick = new Map([
  ['pass', 'Pass Line'], ['dont', 'Don’t Pass'], ['field', 'Field'],
  ...numbers.map(n => [`place_${n}`, `Place ${n}`]),
]);
const prefix = 'point-felt:';
const row = (...components) => ({type: 1, components});
const button = (id, label, style = 2, disabled = false) =>
  ({type: 2, custom_id: prefix + id, label, style, disabled});
const quiet = {parse: []};
const points = n => Number(n).toLocaleString('en-US');
const tableKey = table => `craps-board:${table.guildId}:${table.channelId}`;
const rollKey = table => `${tableKey(table)}:roll`;
const revision = round => `${round?.id || 0}:${round?.roll_version || 0}`;

function snapshot(games, table) {
  const round = games.crapsStatus(table);
  const bets = round ? games.store.db.prepare(`
    SELECT user_id, pick AS kind, NULL AS number, stake, NULL AS working, NULL AS phase
      FROM point_craps_bets WHERE round_id=? AND status='active'
    UNION ALL
    SELECT user_id, 'place', number, stake, working, NULL
      FROM point_craps_places WHERE round_id=? AND status='active'
    UNION ALL
    SELECT user_id, kind, number, stake, working, phase
      FROM point_craps_wagers WHERE round_id=? AND status='active'
  `).all(round.id, round.id, round.id) : [];
  return {round, bets};
}

function board(games, table, advancedRows, rollText) {
  const {round, bets} = snapshot(games, table);
  const last = JSON.parse(games.store.metadata(rollKey(table), 'null'));
  const totals = (kind, number) => points(bets.reduce((sum, bet) =>
    sum + (bet.kind === kind && (number == null || bet.number === number) ? bet.stake : 0), 0));
  const phase = round?.point ? `🟢 **POINT ON · ${round.point}**` : '⚪ **PUCK OFF · COME OUT**';
  return {
    content: '',
    allowedMentions: quiet,
    embeds: [{
      title: '🎲  NoNamePUGs Craps',
      color: round?.point ? 0x16885f : 0x215744,
      description: [
        phase,
        round ? `Shooter  <@${round.shooter}>` : 'Start the table with Pass Line or Don’t Pass.',
        last ? `Last roll  **${last.dice.map(n => dice[n - 1]).join(' ')}  ·  ${last.sum}**` : 'Last roll  —',
      ].join('\n'),
      fields: [
        ...numbers.map(n => ({
          name: round?.point === n ? `🟢 ${n} · POINT` : `PLACE ${n}`,
          value: `**${totals('place', n)}** pts`, inline: true,
        })),
        {name: 'Line & field', value: `Pass **${totals('pass')}**  ·  Don’t Pass **${totals('dont')}**  ·  Field **${totals('field')}**`},
        ...(last && rollText ? [{name: 'Roll result', value: rollText(last).slice(0, 1000)}] : []),
      ],
      footer: {text: 'Table totals in points • Open My Betting Tray to place or remove your bets'},
    }],
    components: [
      row(button('open', 'My Betting Tray', 3), button(`roll:${revision(round)}`, 'Roll Dice', 1, !round),
        button('refresh', 'Refresh')),
      ...advancedRows,
    ],
  };
}

function tray(games, table, chip, notice) {
  const {round, bets} = snapshot(games, table);
  const own = bets.filter(b => b.user_id === String(table.userId));
  const selected = [...new Set([5, 10, 25, 50, games.maxStake].filter(n => n <= games.maxStake))];
  const controls = [...quick].map(([token, label]) => {
    const [kind, number] = token.split('_');
    const active = own.filter(b => b.kind === kind && (!number || b.number === Number(number)));
    const stake = active.reduce((sum, bet) => sum + bet.stake, 0);
    const locked = token === 'pass' && stake > 0;
    const waiting = !stake && (kind === 'place' ? !round?.point : kind === 'field' ? !round : !!round?.point);
    const id = `bet:${revision(round)}:${chip}:${active.length}:${stake}:${token}`;
    return button(id, stake ? `${locked ? '🔒 ' : ''}${label} · ${points(stake)}` : label,
      stake ? 3 : 2, locked || waiting);
  });
  const listed = own.slice(0, 14).map(bet => {
    const token = bet.kind === 'place' ? `place_${bet.number}` : bet.kind;
    const name = quick.get(token) || `${bet.kind.replaceAll('_', ' ')}${bet.number ? ` ${bet.number}` : ''}`;
    const mode = bet.working === 'auto' && ['place','hardway','odds_come'].includes(bet.kind) && !round?.point
      ? ' · OFF on come-out' : ['on','off'].includes(bet.working) ? ` · ${bet.working.toUpperCase()}` : '';
    return `• ${name}  **${points(bet.stake)}** pts${mode}`;
  });
  if (own.length > listed.length) listed.push(`+${own.length - listed.length} more · use \`!craps status\``);
  return {
    allowedMentions: quiet,
    embeds: [{
      color: 0x16885f,
      title: 'My Betting Tray',
      description: [
        `**${points(games.store.account(table.userId)?.balance ?? 1000)}** pts available  ·  **${chip}** pt chip`,
        round?.point ? `Point **${round.point}**` : 'Come-out · Place bets open once a point is set.',
        notice || 'Tap to bet. Tap a removable bet again to take it down.',
      ].join('\n'),
      fields: [{name: 'Your bets', value: listed.join('\n').slice(0, 1024) || 'No bets down'}],
    }],
    components: [
      row(...selected.map(n => button(`chip:${n}`, `${n} pts`, n === chip ? 1 : 2))),
      row(...controls.slice(0, 3)),
      row(...controls.slice(3, 6)),
      row(...controls.slice(6), button(`tray:${chip}`, 'Refresh')),
    ],
  };
}

const updates = new Map();

async function refresh(games, table, channel, render, fallback) {
  const key = tableKey(table);
  const id = games.store.metadata(key);
  if (!id && !fallback?.edit) return;
  const previous = updates.get(key) || Promise.resolve();
  const next = previous.then(async () => {
    const current = games.store.metadata(key);
    try {
      const message = !current || current === fallback?.id ? fallback : await channel?.messages?.fetch(current);
      await message?.edit(render());
    } catch (error) {
      if (error.code !== 10008) console.error('[craps board refresh]', error);
    }
  });
  updates.set(key, next);
  try { await next; }
  finally { if (updates.get(key) === next) updates.delete(key); }
}

function roll(games, table, roundId, context) {
  return games.store.atomic(() => {
    const replay = games.store.db.prepare(
      "SELECT 1 FROM prediction_transactions WHERE operation_key=? AND entry_key='result'",
    ).get(context.operationKey);
    const result = games.crapsRoll({...table, roundId, context});
    if (!replay) games.store.setMetadata(rollKey(table), JSON.stringify(result));
    return result;
  });
}

function quickBet(games, table, context, match) {
  const [, roundId, version, rawChip, count, oldStake, token] = match;
  const chip = Number(rawChip);
  if (!quick.has(token)) throw new Error('Craps wager is invalid.');
  games.stake(chip);
  return games.store.operation(context, `quick-craps:${table.guildId}:${table.channelId}:${match[0]}`, () => {
    const {round, bets} = snapshot(games, table);
    const [kind, rawNumber] = token.split('_');
    const number = Number(rawNumber);
    const active = bets.filter(b => b.user_id === String(table.userId) && b.kind === kind && (!number || b.number === number));
    if (revision(round) !== `${roundId}:${version}` || active.length !== Number(count)
      || active.reduce((sum, b) => sum + b.stake, 0) !== Number(oldStake)) {
      throw new Error('Craps table changed. Check your refreshed bets and tap again.');
    }
    const args = {...table, number, stake: chip, pick: token, kind, context: {...context, operationKey: `${context.operationKey}:wager`}};
    const label = quick.get(token);
    if (!active.length) {
      if (number) games.crapsPlace(args);
      else if (kind === 'field') games.crapsWager({...args, number: null});
      else games.crapsJoin(args);
      return `Placed **${chip}** pts on **${label}**.`;
    }
    let refund;
    if (number) refund = games.crapsTake(args).stake;
    else if (kind !== 'field') refund = games.crapsTakeLine(args).stake;
    else {
      refund = active.reduce((sum, _, index) => sum + games.crapsTakeWager({
        ...args, number: null, context: {...args.context, operationKey: `${args.context.operationKey}:${index}`},
      }).stake, 0);
    }
    return `Took down **${label}** · **${points(refund)}** pts returned.`;
  });
}

async function handle(i, games, casinoChannelId, clock, render) {
  if (!String(i.customId || '').startsWith(prefix)) return false;
  if (!i.guildId || !casinoChannelId || String(i.channelId) !== String(casinoChannelId) || !i.isButton?.()) {
    await i.reply({content: 'This craps table is unavailable here.', ephemeral: true});
    return true;
  }
  const id = i.customId.slice(prefix.length);
  const table = {guildId: i.guildId, channelId: i.channelId, userId: i.user.id};
  const context = {operationKey: `craps-felt:${i.id}`, actorId: String(i.user.id), now: clock()};
  const defaultChip = Math.min(10, games.maxStake);
  const bet = /^bet:(\d+):(\d+):(\d+):(\d+):(\d+):([a-z0-9_]+)$/.exec(id);
  const select = /^(?:chip|tray):(\d+)$/.exec(id);
  const updateBoard = fallback => refresh(games, table, i.channel, () => render(table), fallback);
  if (id === 'open') {
    await i.reply({...tray(games, table, defaultChip), ephemeral: true});
    return true;
  }
  if (select || bet) {
    const candidate = Number(select?.[1] ?? bet[3]);
    const chip = candidate > 0 && candidate <= games.maxStake ? candidate : defaultChip;
    let notice;
    let changed = false;
    if (bet) {
      try {
        notice = quickBet(games, table, context, bet);
        changed = true;
      } catch (error) {
        notice = publicError(error);
      }
    }
    try { await i.update(tray(games, table, chip, notice)); }
    finally { if (changed) await updateBoard(); }
    return true;
  }
  try {
    if (id !== 'refresh') {
      const match = /^roll:(\d+):(\d+)$/.exec(id);
      if (!match) throw new Error('Craps control is invalid.');
      games.store.operation(context, `felt-roll:${table.guildId}:${table.channelId}:${id}`, () => {
        const round = games.crapsStatus(table);
        if (!round || revision(round) !== `${match[1]}:${match[2]}`) throw new Error('Craps table changed. Refresh before rolling.');
        return roll(games, table, round.id, {...context, operationKey: `${context.operationKey}:roll`});
      });
    }
  } catch (error) {
    await i.reply({content: publicError(error), ephemeral: true});
    return true;
  }
  if (i.deferUpdate) {
    try { await i.deferUpdate(); }
    finally { await updateBoard(i.message); }
  } else {
    await updateBoard(i.message);
    await i.update(render(table));
  }
  return true;
}

function publicError(error) {
  return /^(Craps |Choose |Stake must|Insufficient funds|Only the shooter|Point games are paused)/.test(error.message)
    ? error.message : 'Unable to use the craps table right now.';
}

module.exports = {board, handle, refresh, roll, tableKey};
