"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { createPredictions } = require("../predictions");
const { postMatchCard } = require("../predictions/integration");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(t) {
  let now = 1000, beforeReturn = async () => {};
  const db = new Database(":memory:"), messages = new Map(), nonces = new Map();
  const channel = { id: "pickup", messages: { fetch: async id => messages.get(id) }, send: async payload => {
    if (payload.enforceNonce && nonces.has(payload.nonce)) return nonces.get(payload.nonce);
    const message = { id: String(messages.size + 1), channelId: "pickup", payload: JSON.parse(JSON.stringify(payload)), edit: async update => {
      Object.assign(message.payload, JSON.parse(JSON.stringify(update))); return message;
    } };
    messages.set(message.id, message);
    if (payload.enforceNonce) nonces.set(payload.nonce, message);
    await beforeReturn(message);
    return message;
  } };
  const s = createPredictions({ db, client: { channels: { fetch: async () => channel } },
    config: { predictionsEnabled: true }, clock: () => now, logger: { warn() {} },
    queryServerRoster: async () => ({ complete: true, mapName: "shutdown2", steamIds: [] }) });
  const m = s.onMatchFinalized({ matchId: "CARD1", blueIds: ["b1", "b2", "b3", "b4"], redIds: ["r1", "r2", "r3", "r4"],
    offenseIds: [], steamIdsByDiscordId: {}, serverKey: "east", mapName: "shutdown2", team1Starts: "offense" });
  const payload = { embeds: [{ title: "Match Ready — shutdown2", description: "Match ID: CARD1; assigned server: east" }] };
  t.after(() => { s.stop(); db.close(); });
  return { s, db, m, channel, messages, payload, hold: fn => { beforeReturn = fn; }, time: value => { now = value; } };
}

test("a pending match embed and the retry loop publish one bound card with working controls", async t => {
  const { s, m, channel, messages, payload, hold } = setup(t), started = deferred(), release = deferred();
  hold(async message => { if (message.id === "1") { started.resolve(); await release.promise; } });
  const posting = postMatchCard(s, m, channel, payload); await started.promise;
  const retry = s.retryPendingCards(); await flush();
  try { assert.equal(messages.size, 1); }
  finally { release.resolve(); await Promise.allSettled([posting, retry]); }
  const card = await posting;
  assert.equal(s.store.market(m.id).message_id, card.id);
  assert.equal(messages.size, 1);
  assert.equal(card.payload.embeds[0].title, "Match Ready — shutdown2");
  let modal;
  await s.handleInteraction({ id: "pick", customId: `pred:pick:${m.id}:1:blue`, user: { id: "spectator" }, message: card,
    showModal: async value => { modal = value; }, reply: async value => { assert.fail(value.content); } });
  assert.ok(modal);
});

test("two concurrent match publications share the same message instead of rebinding the controls", async t => {
  const { s, m, channel, messages, payload, hold } = setup(t), started = deferred(), release = deferred();
  hold(async message => { if (message.id === "1") { started.resolve(); await release.promise; } });
  const first = postMatchCard(s, m, channel, payload); await started.promise;
  const second = postMatchCard(s, m, channel, payload); await flush();
  try { assert.equal(messages.size, 1); }
  finally { release.resolve(); await Promise.allSettled([first, second]); }
  assert.equal((await first).id, (await second).id);
  assert.equal(s.store.market(m.id).message_id, "1");
});

test("an already bound market updates its existing embed when publication is requested again", async t => {
  const { s, m, channel, messages, payload } = setup(t);
  const first = await postMatchCard(s, m, channel, payload);
  const second = await postMatchCard(s, s.store.market(m.id), channel, { embeds: [{ title: "Updated match details" }] });
  assert.equal(messages.size, 1);
  assert.equal(second.id, first.id);
  assert.equal(first.payload.embeds[0].title, "Updated match details");
});

test("an initial send failure retains the full match embed for later publication", async t => {
  const { s, db, m, channel, messages, payload } = setup(t), send = channel.send;
  channel.send = async () => { throw new Error("Discord unavailable"); };
  await assert.rejects(postMatchCard(s, m, channel, payload), /Discord unavailable/);
  assert.equal(s.store.market(m.id).message_id, null);
  channel.send = send;
  const recovered = createPredictions({ db, client: s.client, config: { predictionsEnabled: false }, clock: () => 1000 });
  t.after(() => recovered.stop()); await recovered.retryPendingCards();
  const card = messages.get(s.store.market(m.id).message_id);
  assert.equal(messages.size, 1);
  assert.equal(card.payload.embeds?.[0].title, "Match Ready — shutdown2");
});

test("a retry already sending a recovery card adopts the original embed on the same message", async t => {
  const { s, m, channel, messages, payload, hold } = setup(t), started = deferred(), release = deferred();
  s.queueCardPublication(m.id, channel.id);
  hold(async message => { if (message.id === "1") { started.resolve(); await release.promise; } });
  const retry = s.retryPendingCards(); await started.promise;
  const posting = postMatchCard(s, m, channel, payload); await flush();
  try { assert.equal(messages.size, 1); }
  finally { release.resolve(); await Promise.allSettled([posting, retry]); }
  await flush();
  assert.equal(messages.size, 1);
  assert.equal(s.store.market(m.id).message_id, "1");
  assert.equal(messages.get("1").payload.embeds?.[0].title, "Match Ready — shutdown2");
});

test("a deadline reached before send completion closes the original card as soon as it is bound", async t => {
  const { s, m, channel, payload, hold, time } = setup(t), started = deferred(), release = deferred();
  hold(async () => { started.resolve(); await release.promise; });
  const posting = postMatchCard(s, m, channel, payload); await started.promise;
  s.store.startCountdown(m.id, 1000); time(121000); s.tick();
  release.resolve(); const card = await posting; await flush();
  assert.match(card.payload.content, /Predictions closed/);
  assert.equal(card.payload.components[0].components[0].disabled, true);
  assert.equal(card.payload.embeds[0].title, "Match Ready — shutdown2");
});

test("retrying an accepted send with a lost response reuses Discord's recent-message nonce", async t => {
  const { s, m, channel, messages, payload, hold } = setup(t);
  hold(async () => { throw new Error("Response lost after Discord accepted the message"); });
  await assert.rejects(postMatchCard(s, m, channel, payload), /Response lost/);
  hold(async () => {}); await s.retryPendingCards();
  assert.equal(messages.size, 1);
  assert.equal(s.store.market(m.id).message_id, "1");
});

test("nonce recovery refreshes an accepted card whose betting deadline passed before the retry", async t => {
  const { s, m, channel, messages, payload, hold, time } = setup(t);
  hold(async () => { throw new Error("Response lost"); });
  await assert.rejects(postMatchCard(s, m, channel, payload), /Response lost/);
  s.store.startCountdown(m.id, 1000); time(121000); s.tick();
  hold(async () => {}); await s.retryPendingCards(); await flush();
  assert.equal(messages.size, 1);
  assert.match(messages.get("1").payload.content, /Predictions closed/);
  assert.equal(messages.get("1").payload.components[0].components[0].disabled, true);
});

for(const failure of ["channel","payload"]){
 test(`a ${failure} queue write failure preserves the original plain Match Ready and leaves no partial publication`,async t=>{
  const {s,db,m,channel,messages,payload}=setup(t);
  db.exec(failure==="channel"?"CREATE TRIGGER fail_queue BEFORE UPDATE OF channel_id ON prediction_markets BEGIN SELECT RAISE(ABORT,'queue failure'); END":"CREATE TRIGGER fail_queue BEFORE INSERT ON prediction_meta WHEN NEW.key LIKE 'card_payload:%' BEGIN SELECT RAISE(ABORT,'payload failure'); END");
  const message=await postMatchCard(s,m,channel,payload);assert.equal(messages.size,1);assert.equal(message.payload.embeds[0].title,payload.embeds[0].title);assert.equal(message.payload.components,undefined);assert.equal(s.store.market(m.id).channel_id,null);assert.equal(s.store.market(m.id).message_id,null);
  db.exec("DROP TRIGGER fail_queue");await s.retryPendingCards();assert.equal(messages.size,1);
 });
}
test("failed payload updates on an existing queued publication never send a second plain card",async t=>{
 const {s,db,m,channel,messages,payload}=setup(t);await postMatchCard(s,m,channel,payload);const original=s.store.market(m.id);db.exec("CREATE TRIGGER fail_payload BEFORE INSERT ON prediction_meta WHEN NEW.key LIKE 'card_payload:%' BEGIN SELECT RAISE(ABORT,'payload failure'); END");
 await assert.rejects(postMatchCard(s,m,channel,payload),/payload failure/);assert.equal(messages.size,1);assert.equal(s.store.market(m.id).message_id,original.message_id);
});
for(const recovered of [false,true])test(`concurrent publications share a plain fallback when queue storage ${recovered?'recovers':'still fails'}`,async t=>{
 const {s,db,m,channel,messages,payload,hold}=setup(t),started=deferred(),release=deferred();hold(async()=>{started.resolve();await release.promise;});db.exec("CREATE TRIGGER fail_queue BEFORE UPDATE OF channel_id ON prediction_markets BEGIN SELECT RAISE(ABORT,'queue failure'); END");
 const first=postMatchCard(s,m,channel,payload);await started.promise;if(recovered)db.exec("DROP TRIGGER fail_queue");const second=postMatchCard(s,m,channel,payload);await flush();
 try{assert.equal(messages.size,1);assert.equal(s.cardJobs.size,1);}finally{release.resolve();await Promise.allSettled([first,second]);}
 assert.equal((await first).id,(await second).id);if(!recovered)db.exec("DROP TRIGGER fail_queue");await s.retryPendingCards();assert.equal(messages.size,1);if(recovered){assert.equal(s.store.market(m.id).message_id,'1');assert.equal(messages.get('1').payload.embeds[0].title,payload.embeds[0].title);}
});