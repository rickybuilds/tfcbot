"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { FRAME_BYTES, PcmBuffer, mixFrames, LiveMixer } = require("../lib/voicePcm");

function stereo(left, right) {
  const frame = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < frame.length; i += 4) {
    frame.writeInt16LE(left, i);
    frame.writeInt16LE(right, i + 2);
  }
  return frame;
}

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

test("slow consumers do not create unbounded output or stop draining inputs", () => {
  const mixer = new LiveMixer({ clock: false });
  const input = mixer.add("speaker");
  mixer._read();
  for (let i = 0; i < 1000; i++) {
    input.write(stereo(100, -100));
    mixer.tick();
  }
  assert.equal(mixer.readableLength, FRAME_BYTES);
  assert.equal(input.buffer.length, 0);
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
