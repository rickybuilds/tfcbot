const test = require('node:test');
const assert = require('node:assert/strict');
const { createAronQueueWatcher } = require('../services/aronQueueWatcher');

test('publishes at four and updates the same board as the queue changes', async () => {
  let data = { ok: true, count: 3, max: 10, players: [{name:'a'},{name:'b'},{name:'c'}] };
  const sent = [], edits = [];
  const board = { edit: async payload => edits.push(payload) };
  const channel = { messages: { fetch: async () => [] }, send: async payload => { sent.push(payload); return board; } };
  const watcher = createAronQueueWatcher({ client: { user: { id: 'bot' }, channels: { fetch: async () => channel } }, channelId: '123', fetchQueue: async () => data });
  await watcher.poll(); assert.equal(sent.length, 0);
  data = { ...data, count: 4, players: [...data.players, {name:'d'}] };
  await watcher.poll(); assert.equal(sent.length, 1);
  assert.match(sent[0].embeds[0].data.title, /4\/10/);
  assert.match(sent[0].embeds[0].data.description, /d/);
  await watcher.poll(); assert.equal(edits.length, 0);
  data = { ...data, count: 3, players: data.players.slice(0, 3) };
  await watcher.poll(); assert.match(edits[0].embeds[0].data.title, /3\/10/);
});

test('does not replace a valid board when the API fails or is malformed', async () => {
  let data = { ok: true, count: 4, max: 10, players: Array.from({length: 4}, (_, i) => ({name: String(i)})) };
  let edits = 0;
  const channel = { messages: { fetch: async () => [] }, send: async () => ({ edit: async () => edits++ }) };
  const watcher = createAronQueueWatcher({ client: { user: { id: 'bot' }, channels: { fetch: async () => channel } }, channelId: '123', fetchQueue: async () => data, logger: { error() {} } });
  await watcher.poll(); data = { ok: false }; await watcher.poll();
  assert.equal(edits, 0);
});


test('recovers the existing board after a restart even below four players', async () => {
  const edits = [];
  const existing = { author: { id: 'bot' }, embeds: [{ footer: { text: 'Aron PUGs queue' } }], edit: async payload => edits.push(payload) };
  const channel = { messages: { fetch: async () => [existing] }, send: async () => assert.fail('should reuse the existing board') };
  const watcher = createAronQueueWatcher({ client: { user: { id: 'bot' }, channels: { fetch: async () => channel } }, channelId: '123', fetchQueue: async () => ({ ok: true, count: 0, max: 10, players: [] }) });
  await watcher.poll();
  assert.match(edits[0].embeds[0].data.title, /0\/10/);
});
