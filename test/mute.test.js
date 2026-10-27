const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const command = require('../commands/mute');

test('unmute accepts a Discord ID and removes it from the database and cache', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE pickup_mutes (discord_id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO pickup_mutes VALUES (?)').run('123456789012345678');
  const muted = new Set(['123456789012345678']);
  let reply;
  await command.execute({
    content: '!unmute 123456789012345678',
    author: { id: '255834576742645761' },
    mentions: { users: { first: () => undefined } },
    reply: text => { reply = text; },
  }, ['123456789012345678'], { matchesStore: { db }, state: { pickupMutedUsers: muted } });
  assert.equal(db.prepare('SELECT * FROM pickup_mutes').all().length, 0);
  assert.equal(muted.has('123456789012345678'), false);
  assert.match(reply, /no longer pickup-muted/);
  db.close();
});

test('unmute still accepts a mention', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE pickup_mutes (discord_id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO pickup_mutes VALUES (?)').run('123456789012345678');
  const muted = new Set(['123456789012345678']);
  const user = { id: '123456789012345678', bot: false, toString: () => '<@123456789012345678>' };
  await command.execute({
    content: '!unmute <@123456789012345678>',
    author: { id: '255834576742645761' },
    mentions: { users: { first: () => user } },
    reply: () => {},
  }, ['<@123456789012345678>'], { matchesStore: { db }, state: { pickupMutedUsers: muted } });
  assert.equal(db.prepare('SELECT * FROM pickup_mutes').all().length, 0);
  assert.equal(muted.has(user.id), false);
  db.close();
});
