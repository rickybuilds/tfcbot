"use strict";

const { Readable } = require("node:stream");
const { performance } = require("node:perf_hooks");

// Discord raw audio: signed 16-bit little-endian, 48 kHz, stereo, 20 ms.
const FRAME_BYTES = 3840;
const SAMPLE_BYTES = 4;

class PcmBuffer {
  constructor(maxFrames = 10, prebufferFrames = 0) {
    this.limit = maxFrames * FRAME_BYTES;
    this.buffer = Buffer.alloc(0);
    this.droppedBytes = 0;
    this.prebufferFrames = prebufferFrames;
    this.primed = false;
    this.waitTicks = 0;
    this.underflows = 0;
    this.writtenBytes = 0;
    this.consumedBytes = 0;
  }

  write(chunk) {
    this.writtenBytes += chunk.length;
    const combined = Buffer.concat([this.buffer, chunk]);
    // TCP chunks can split a stereo sample. Drop only complete samples.
    const drop = Math.max(0, Math.ceil((combined.length - this.limit) / SAMPLE_BYTES) * SAMPLE_BYTES);
    this.droppedBytes += drop;
    this.buffer = Buffer.from(combined.subarray(drop));
  }

  readFrame() {
    if (this.prebufferFrames > 0) {
      // Give independently timed packets a short playout cushion. Also flush
      // short utterances after the same bounded wait, even below the target.
      if (!this.primed) {
        if (this.buffer.length) this.waitTicks++;
        if (this.buffer.length < FRAME_BYTES ||
            (this.buffer.length < this.prebufferFrames * FRAME_BYTES && this.waitTicks < this.prebufferFrames)) {
          return Buffer.alloc(FRAME_BYTES);
        }
        this.primed = true;
        this.waitTicks = 0;
      }
      if (this.buffer.length < FRAME_BYTES) {
        this.underflows++;
        this.primed = false;
        return Buffer.alloc(FRAME_BYTES);
      }
    }
    const length = Math.min(FRAME_BYTES, this.buffer.length - this.buffer.length % SAMPLE_BYTES);
    this.consumedBytes += length;
    const frame = Buffer.alloc(FRAME_BYTES);
    this.buffer.copy(frame, 0, 0, length);
    this.buffer = Buffer.from(this.buffer.subarray(length));
    return frame;
  }
}

function mixFrames(frames, gain = 1) {
  const output = Buffer.alloc(FRAME_BYTES);
  for (let offset = 0; offset < FRAME_BYTES; offset += SAMPLE_BYTES) {
    let left = 0;
    let right = 0;
    for (const frame of frames) {
      left += frame.readInt16LE(offset) * gain;
      right += frame.readInt16LE(offset + 2) * gain;
    }
    const scale = Math.min(1, 32767 / (Math.max(Math.abs(left), Math.abs(right)) || 1));
    output.writeInt16LE(Math.round(left * scale), offset);
    output.writeInt16LE(Math.round(right * scale), offset + 2);
  }
  return output;
}

class LiveMixer extends Readable {
  constructor({ gain = 1, maxFrames = 10, prebufferFrames = 0, clock = true } = {}) {
    super({ highWaterMark: FRAME_BYTES });
    this.inputs = new Map();
    this.gain = gain;
    this.maxFrames = maxFrames;
    this.prebufferFrames = prebufferFrames;
    this.backpressureTicks = 0;
    this.lateTicks = 0;
    this.outputFrames = 0;
    this.wantFrame = false;
    // Schedule against a monotonic deadline; setInterval drift otherwise builds
    // input backlog over long matches. Never burst-replay frames after a stall.
    this.deadline = performance.now() + 20;
    const run = () => {
      if (performance.now() - this.deadline > 10) this.lateTicks++;
      this.tick();
      this.deadline += 20;
      const now = performance.now();
      if (this.deadline < now) this.deadline = now + 20;
      if (!this.destroyed) this.timer = setTimeout(run, Math.max(1, this.deadline - now));
    };
    this.timer = clock ? setTimeout(run, 20) : null;
  }

  add(id) {
    const input = new PcmBuffer(this.maxFrames, this.prebufferFrames);
    this.inputs.set(id, input);
    return input;
  }

  _read() { this.wantFrame = true; }

  tick() {
    if (this.destroyed) return;
    // Encoder/Discord demand must be checked BEFORE taking samples. Previously
    // every paused tick silently deleted speech without increasing droppedBytes.
    // Inputs remain bounded by PcmBuffer.write, which counts any real overflow.
    if (!this.wantFrame) { this.backpressureTicks++; return; }
    const frames = [...this.inputs.values()].map(input => input.readFrame());
    this.outputFrames++;
    this.wantFrame = this.push(mixFrames(frames, this.gain));
  }

  _destroy(error, callback) {
    clearTimeout(this.timer);
    this.inputs.clear();
    callback(error);
  }
}

module.exports = { FRAME_BYTES, PcmBuffer, mixFrames, LiveMixer };
