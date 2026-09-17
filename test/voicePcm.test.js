"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FRAME_BYTES, DEFAULT_JITTER_FRAMES, PcmBuffer, mixFrames, LiveMixer } = require("../lib/voicePcm");

function stereo(left, right) {
  const frame = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < frame.length; i += 4) {
    frame.writeInt16LE(left, i);
    frame.writeInt16LE(right, i + 2);
  }
  return frame;
}

function virtualClock(stalls = () => 0) {
  let now = 0;
  let nextId = 0;
  const tasks = new Map();
  const schedule = (role, callback, delay) => {
    const due = now + delay;
    const id = ++nextId;
    tasks.set(id, { at: due + stalls(role, due), callback });
    return id;
  };
  return {
    schedule,
    tasks,
    mixer(role, options = {}) {
      const context = {
        module: { exports: {} }, Buffer,
        require: name => name === "node:perf_hooks" ? { performance: { now: () => now } } : require(name),
        setTimeout: (callback, delay) => schedule(role, callback, delay),
        clearTimeout: id => tasks.delete(id),
      };
      // Optional source override lets this same regression run against a prior
      // revision without editing production files.
      const source = process.env.VOICE_PCM_TEST_SOURCE || path.join(__dirname, "../lib/voicePcm.js");
      // Compile trusted local CommonJS in this realm; a VM context adds costly
      // global lookups inside every PCM sample loop during the long simulation.
      const load = new Function("require", "module", "setTimeout", "clearTimeout", fs.readFileSync(source, "utf8"));
      load(context.require, context.module, context.setTimeout, context.clearTimeout);
      return new context.module.exports.LiveMixer(options);
    },
    runUntil(end) {
      while (tasks.size) {
        const [id, task] = [...tasks].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (task.at > end) break;
        tasks.delete(id);
        now = task.at;
        task.callback();
      }
      now = end;
    },
  };
}

test("actual timer recovers repeated stalls for 35 minutes with six speakers on each team", () => {
  // Team processes get occasional delays; spectator has varying 30-60 ms
  // stalls every seven seconds, like the reported scheduling lateness. Varying
  // duration matters: identical periodic stalls can phase-lock with a bad clock.
  const clock = virtualClock((role, due) => {
    if (role === "wire") return 0;
    const period = role === "spectator" ? 7000 : 17000;
    const phase = due % period;
    const end = 2030 + (Math.floor(due / period) * 17) % 31;
    return phase >= 2000 && phase < end ? end - phase : 0;
  });
  const teams = [clock.mixer("blue", { prebufferFrames: DEFAULT_JITTER_FRAMES }), clock.mixer("red", { prebufferFrames: DEFAULT_JITTER_FRAMES })];
  const spectator = clock.mixer("spectator", { prebufferFrames: DEFAULT_JITTER_FRAMES, gain: 0.25 });
  const people = teams.flatMap(team => Array.from({ length: 6 }, (_, id) => team.add(id)));
  const feeds = [spectator.add("blue"), spectator.add("red")];
  const signals = people.map((_, id) => stereo((id + 1) * 100, -(id + 1) * 100));
  let played = 0;
  let corrupted = 0;
  let maxQueued = 0;
  // Replace only the downstream sink; production timer callbacks, frame
  // consumption, jitter buffering and mixing execute unchanged.
  teams.forEach((team, index) => {
    team._read();
    team.push = frame => {
      if (frame) clock.schedule("spectator", () => feeds[index].write(frame), 1);
      return true;
    };
  });
  spectator._read();
  spectator.push = frame => {
    if (frame && ++played > 20 && !frame.equals(stereo(1950, -1950))) corrupted++;
    maxQueued = Math.max(maxQueued, ...feeds.map(input => input.buffer.length));
    return true;
  };
  let sending = true;
  const send = () => {
    people.forEach((input, id) => input.write(signals[id]));
    if (sending) clock.schedule("wire", send, 20);
  };
  clock.schedule("wire", send, 1);
  try {
    clock.runUntil(35 * 60 * 1000);
    assert.equal(spectator.outputFrames, 35 * 60 * 50);
    assert.ok(spectator.lateTicks > 200, "must exercise repeated scheduling delays");
    assert.equal(spectator.clockSkippedFrames, 0);
    assert.equal(corrupted, 0, "every playout frame after startup retains all twelve speakers");
    assert.ok(maxQueued < 10 * FRAME_BYTES);
    for (const input of [...people, ...feeds]) {
      assert.equal(input.droppedBytes, 0);
      assert.equal(input.underflows, 0);
      assert.equal(input.writtenBytes, input.consumedBytes + input.buffer.length);
    }
  } finally {
    sending = false;
    teams.forEach(team => team.destroy());
    spectator.destroy();
  }
});

test("actual timer limits catch-up work after a multi-second freeze and cancels on destroy", () => {
  const clock = virtualClock((role, due) => due >= 1000 && due < 6000 ? 6000 - due : 0);
  const mixer = clock.mixer("spectator");
  mixer._read();
  mixer.push = () => true;
  clock.runUntil(6020);
  assert.ok(mixer.clockSkippedFrames >= 240);
  assert.ok(mixer.outputFrames < 65, "must not emit hundreds of catch-up frames");
  assert.equal(mixer.outputFrames + mixer.clockSkippedFrames, 301);
  mixer.destroy();
  assert.equal(clock.tasks.size, 0);
});

test("TCP fragments preserve incomplete stereo samples between reads", () => {
  const input = new PcmBuffer();
  const frame = stereo(1234, -2345);
  input.write(frame.subarray(0, 7));
  assert.deepEqual(input.readFrame().subarray(0, 4), frame.subarray(0, 4));
  input.write(frame.subarray(7));
  assert.deepEqual(input.readFrame().subarray(0, FRAME_BYTES - 4), frame.subarray(4));
});

test("overflow drops old audio without shifting PCM byte or stereo alignment", () => {
  const input = new PcmBuffer(1);
  const frame = stereo(0x1234, -12345);
  input.write(frame);
  input.write(frame.subarray(0, 101));
  assert.equal(input.droppedBytes, 104);
  input.write(frame.subarray(101));
  assert.deepEqual(input.readFrame(), frame);
  assert.ok(input.buffer.length <= FRAME_BYTES);
});

test("both teams sum, absent teams are silent, and peaks never wrap", () => {
  assert.deepEqual(mixFrames([stereo(4000, -4000), stereo(2000, -2000)], 0.25), stereo(1500, -1500));
  assert.deepEqual(mixFrames([stereo(4000, -4000)], 0.25), stereo(1000, -1000));
  assert.deepEqual(mixFrames([]), Buffer.alloc(FRAME_BYTES));
  const clipped = mixFrames([stereo(30000, -30000), stereo(30000, -30000)]);
  assert.equal(clipped.readInt16LE(0), 32767);
  assert.equal(clipped.readInt16LE(2), -32767);
});

test("backpressure preserves speech until the consumer requests the next frame", () => {
  const mixer = new LiveMixer({ clock: false });
  const input = mixer.add("speaker");
  mixer._read();
  input.write(stereo(100, -100));
  mixer.tick();
  input.write(stereo(200, -200));
  mixer.tick();
  assert.equal(mixer.readableLength, FRAME_BYTES);
  assert.equal(input.buffer.length, FRAME_BYTES, "second frame must not disappear under backpressure");
  assert.deepEqual(mixer.read(FRAME_BYTES), stereo(100, -100));
  mixer._read();
  mixer.tick();
  assert.deepEqual(mixer.read(FRAME_BYTES), stereo(200, -200));
  mixer.destroy();
  assert.equal(mixer.inputs.size, 0);
});

test("all twelve speakers contribute to the spectator's exact mixed samples", () => {
  const teams = [new LiveMixer({ clock: false }), new LiveMixer({ clock: false })];
  const spectator = new LiveMixer({ gain: 0.25, clock: false });
  try {
    for (let team = 0; team < 2; team++) {
      for (let person = 1; person <= 6; person++) {
        const value = (team * 6 + person) * 100;
        teams[team].add(person).write(stereo(value, -value));
      }
      teams[team]._read();
      teams[team].tick();
      spectator.add(team).write(teams[team].read(FRAME_BYTES));
    }
    spectator._read();
    spectator.tick();
    // 100 + 200 + ... + 1200 = 7800; the spectator applies 0.25 gain.
    assert.deepEqual(spectator.read(FRAME_BYTES), stereo(1950, -1950));
    spectator.inputs.delete(1);
    teams[0].inputs.get(1).write(stereo(400, -400));
    teams[0]._read();
    teams[0].tick();
    spectator.inputs.get(0).write(teams[0].read(FRAME_BYTES));
    spectator._read();
    spectator.tick();
    assert.deepEqual(spectator.read(FRAME_BYTES), stereo(100, -100));
  } finally {
    teams.forEach(team => team.destroy());
    spectator.destroy();
  }
});

test("jitter buffering waits for complete frames and flushes short utterances", () => {
  const input = new PcmBuffer(10, 3);
  const frame = stereo(1234, -2345);
  input.write(frame.subarray(0, 7));
  assert.deepEqual(input.readFrame(), Buffer.alloc(FRAME_BYTES));
  assert.equal(input.buffer.length, 7);
  input.write(frame.subarray(7));
  assert.deepEqual(input.readFrame(), Buffer.alloc(FRAME_BYTES));
  assert.deepEqual(input.readFrame(), frame);
  assert.deepEqual(input.readFrame(), Buffer.alloc(FRAME_BYTES));
  assert.equal(input.underflows, 1);
  assert.equal(input.writtenBytes, input.consumedBytes);
});

test("prolonged backpressure remains bounded and every dropped byte is accounted for", () => {
  const mixer = new LiveMixer({ clock: false });
  const input = mixer.add("speaker");
  mixer._read();
  for (let tick = 0; tick < 100; tick++) {
    input.write(stereo(100, -100));
    mixer.tick();
  }
  assert.equal(mixer.readableLength, FRAME_BYTES);
  assert.equal(input.buffer.length, input.limit);
  assert.equal(input.writtenBytes, input.consumedBytes + input.droppedBytes + input.buffer.length);
  assert.equal(input.droppedBytes, 89 * FRAME_BYTES);
  assert.equal(mixer.backpressureTicks, 99);
  mixer.destroy();
});

test("35-minute independent-clock simulation: 12 speakers, jitter, TCP fragmentation and playback pause", () => {
  const teams = [new LiveMixer({ clock: false, prebufferFrames: 3 }), new LiveMixer({ clock: false, prebufferFrames: 3 })];
  const spectator = new LiveMixer({ clock: false, prebufferFrames: 3, gain: 0.25 });
  const speakers = teams.flatMap(team => Array.from({ length: 6 }, (_, person) => team.add(person)));
  const feeds = [spectator.add("blue"), spectator.add("red")];
  const frames = speakers.map((_, person) => stereo((person + 1) * 100, -(person + 1) * 100));
  const events = [];
  const allInputs = [...speakers, ...feeds];
  let silentAfterWarmup = 0;
  let played = 0;
  try {
    for (let tick = 0; tick < 35 * 60 * 50; tick++) {
      const base = tick * 20;
      // Producers have independent phase offsets and +/- 4 ms packet jitter.
      speakers.forEach((input, person) => {
        events.push({ at: base + 4 + person % 7 + (tick + person) % 5, run: () => input.write(frames[person]) });
      });
      teams.forEach((team, index) => {
        events.push({ at: base + 2 + index * 5, run: () => {
          team._read();
          team.tick();
          const frame = team.read(FRAME_BYTES);
          // Split TCP data across separate events, not consecutive writes.
          feeds[index].write(frame.subarray(0, 101));
          events.push({ at: base + 6 + index * 5, run: () => feeds[index].write(frame.subarray(101)) });
        } });
      });
      events.push({ at: base + 12, run: () => spectator.tick() });
      events.push({ at: base + 16, run: () => {
        // At minute 26 the encoder stops accepting PCM for 80 ms. The old
        // implementation deleted frames in this situation with droppedBytes=0.
        if (tick >= 26 * 60 * 50 && tick < 26 * 60 * 50 + 4) return;
        const frame = spectator.read(FRAME_BYTES);
        spectator._read();
        if (tick > 20) {
          assert.ok(frame, `missing playout frame at ${tick}`);
          if (frame.readInt16LE(0) === 0) silentAfterWarmup++;
          assert.deepEqual(frame, stereo(1950, -1950), `lost speaker or broken frame at ${tick}`);
          played++;
        }
      } });
      while (events.length) {
        events.sort((a, b) => a.at - b.at);
        events.shift().run();
      }
      if (tick % 1000 === 0) {
        for (const input of allInputs) {
          assert.equal(input.writtenBytes, input.consumedBytes + input.droppedBytes + input.buffer.length);
          assert.ok(input.buffer.length <= input.limit);
        }
      }
    }
    assert.ok(played > 100000);
    assert.equal(silentAfterWarmup, 0);
    assert.ok(spectator.backpressureTicks >= 3);
    for (const input of allInputs) {
      assert.equal(input.underflows, 0);
      assert.equal(input.droppedBytes, 0);
      assert.equal(input.writtenBytes, input.consumedBytes + input.buffer.length);
    }
  } finally {
    teams.forEach(team => team.destroy());
    spectator.destroy();
  }
});

test("35-minute simulation: six Blue + six Red speakers, fragmentation, stalls and reconnect", () => {
  const teams = [new LiveMixer({ clock: false }), new LiveMixer({ clock: false })];
  const spectator = new LiveMixer({ gain: 0.25, clock: false });
  const people = teams.map(team => Array.from({ length: 6 }, (_, i) => team.add(`speaker-${i}`)));
  const feeds = [spectator.add("blue"), spectator.add("red")];
  // Twelve distinct signals. All twelve overlap during the first half of each
  // cycle; the second half also covers natural pauses from individual speakers.
  const signals = Array.from({ length: 12 }, (_, user) => {
    const frame = Buffer.alloc(FRAME_BYTES);
    for (let sample = 0; sample < 960; sample++) {
      const value = Math.round(900 * Math.sin(2 * Math.PI * (user + 3) * sample / 960));
      frame.writeInt16LE(value, sample * 4);
      frame.writeInt16LE(-value, sample * 4 + 2);
    }
    return frame;
  });
  let checked = 0;
  let sawDrop = false;
  try {
    for (let tick = 0; tick < 35 * 60 * 50; tick++) {
      for (let team = 0; team < 2; team++) {
        for (let user = 0; user < 6; user++) {
          if (tick % 100 < 50 || (tick + user) % 3 !== 0) people[team][user].write(signals[team * 6 + user]);
        }
        teams[team]._read();
        teams[team].tick();
        const frame = teams[team].read(FRAME_BYTES);
        assert.equal(frame.length, FRAME_BYTES);
        // Lose Red for 5 simulated seconds at minute 26, then reconnect fresh.
        if (team === 1 && tick === 26 * 60 * 50) spectator.inputs.delete("red");
        if (team === 1 && tick === 26 * 60 * 50 + 250) feeds[1] = spectator.add("red");
        if (team === 1 && tick >= 26 * 60 * 50 && tick < 26 * 60 * 50 + 250) continue;
        const split = 1 + (tick * 137) % (FRAME_BYTES - 1);
        feeds[team].write(frame.subarray(0, split));
        feeds[team].write(frame.subarray(split));
      }
      // 400 ms event-loop stalls force bounded input overflow, including after
      // the reported 25-minute point. Playback backpressure is tested separately.
      if (tick % 15000 < 20) continue;
      spectator._read();
      spectator.tick();
      const output = spectator.read(FRAME_BYTES);
      assert.equal(output.length, FRAME_BYTES);
      // Opposite stereo channels remain opposite at EVERY sample: any byte
      // misalignment or interleaving makes this invariant fail.
      for (let offset = 0; offset < FRAME_BYTES; offset += 4) {
        const left = output.readInt16LE(offset);
        const right = output.readInt16LE(offset + 2);
        assert.ok(Math.abs(left + right) <= 1, `PCM corrupted at tick ${tick}, offset ${offset}`);
      }
      for (const input of spectator.inputs.values()) {
        assert.ok(input.buffer.length <= 10 * FRAME_BYTES);
        sawDrop ||= input.droppedBytes > 0;
      }
      checked++;
    }
    assert.ok(checked > 100000);
    assert.ok(sawDrop, "simulation exercised overflow trimming");
    assert.equal(spectator.inputs.size, 2);
  } finally {
    teams.forEach(team => team.destroy());
    spectator.destroy();
  }
});
