const test = require('node:test');
const assert = require('node:assert/strict');
const { createAronQueueWatcher } = require('../services/aronQueueWatcher');

test('publishes an empty queue and updates the same board as players join', async () => {
  let data = { ok: true, count: 0, max: 10, players: [] };
  const sent = [], edits = [];
  const board = { edit: async payload => edits.push(payload) };
  const channel = { messages: { fetch: async () => [] }, send: async payload => { sent.push(payload); return board; } };
  const watcher = createAronQueueWatcher({ client: { user: { id: 'bot' }, channels: { fetch: async () => channel } }, channelId: '123', fetchQueue: async () => data });
  await watcher.poll(); assert.equal(sent.length, 1);
  assert.match(sent[0].embeds[0].data.title, /0\/10/);
  data = { ...data, count: 1, players: [{name:'a'}] };
  await watcher.poll(); assert.equal(sent.length, 1);
  assert.match(edits[0].embeds[0].data.title, /1\/10/);
  assert.match(edits[0].embeds[0].data.description, /a/);
  await watcher.poll(); assert.equal(edits.length, 1);
});

test('recreates a deleted board when fewer than four players are queued', async () => {
  let sends = 0;
  const board = { edit: async () => { throw Object.assign(new Error('deleted'), { code: 10008 }); } };
  const channel = { messages: { fetch: async () => [] }, send: async () => { sends++; return board; } };
  let data = { ok: true, count: 1, max: 10, players: [{ name: 'a' }] };
  const watcher = createAronQueueWatcher({ client: { user: { id: 'bot' }, channels: { fetch: async () => channel } }, channelId: '123', fetchQueue: async () => data });
  await watcher.poll();
  data = { ...data, count: 0, players: [] };
  await watcher.poll();
  assert.equal(sends, 2);
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
