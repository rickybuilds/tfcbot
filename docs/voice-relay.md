# Spectator voice relay

## What it does

Six players in Blue and six players in Red can speak concurrently. Each team
bot receives Discord Opus, decodes it to 48 kHz stereo PCM, and mixes its team.
Two loopback TCP feeds carry that PCM to the spectator process, which combines
them and encodes the result for Discord. Spectator is deafened; the team bots
are muted. There is no return path, AI service, transcription, or recording.

The three existing Discord accounts, PM2 process names, role env files and match
start/stop hooks remain in use. Separate accounts let the bots occupy all three
channels in the same guild.

## Why replace the old pipeline

The old spectator used FFmpeg with two input pipes, an output PassThrough, and
a watchdog. Its output trimming could discard an arbitrary byte count. Stereo
PCM requires four-byte alignment; losing alignment can produce robotic noise.
Input queues were unbounded. Repeated Discord Ready events also installed new
listeners, intervals and pipelines, and FFmpeg restart callbacks could refer to
a newer process. These are plausible causes of degradation over long matches;
they do not prove which caused the reported noise after about 25 minutes.

The replacement uses a direct Node mixer with 20 ms frames, a monotonic clock,
200 ms maximum pending audio per input, sample-aligned overflow trimming, and
bounded readable output. Late input is discarded to stay live. Missing teams
contribute silence. Each role initializes one pipeline; voice recovery reuses
the connection, and unrecoverable errors exit for PM2 to restart. Closed receive
streams are removed and subscribed again when that player speaks. A new TCP
connection replaces that team's old buffer. Slow TCP sends reset rather than
accumulating stale speech. Shutdown releases sockets, decoders and timers.

### Follow-up for robotic audio with zero dropped bytes

The first Node replacement had a separate defect: its timer consumed input
frames even when its readable output was backpressured, then discarded the
mixed result. These losses were invisible to `droppedBytes`. The mixer now
checks output demand before consuming anything. Prolonged backpressure can
still overflow the bounded input queues, but those losses are counted.

Both stages now prebuffer three frames (60 ms) to tolerate packet jitter and
independent timer phases. Set `VOICE_JITTER_FRAMES` to an integer from 1 to 8
in each role's env file to adjust this. The default adds roughly 120 ms of
input buffering across both stages, plus Discord/codec buffering. Incomplete
frames are retained until complete instead of padding and consuming each TCP
fragment. Short utterances flush after a bounded wait even below the target.

Startup identifies this revision as `Audio pipeline v2`. Health counters now
include `underflows` (buffer starvation after playback started; team speech
pauses also cause these), `backpressureTicks` (20 ms mixer opportunities held
for a slow consumer), `lateTicks` (timer lateness above 10 ms), byte accounting,
and `outputFrames`. `loopMaxMs` is the maximum sampled event-loop delay in the
last minute, not cumulative; other mixer counters are cumulative. Input
counters reset when that input is removed/replaced. Zero overflow alone does
not establish healthy playback or rule out packet loss upstream of decoding.

This revision fixes a reproduced loss bug, not a confirmed diagnosis of all
live robotic audio. Deploy `voicebot.js` and `lib/voicePcm.js` together and
restart all three PM2 voice processes between games. On the Ubuntu host, use
the existing operator order: `pm2 restart tfcbot-spectator`, wait for
`SPECTATOR READY`, then `pm2 restart tfcbot-red tfcbot-blue`. Preserve the new
health lines from all roles if the problem returns. The reported spontaneous
recovery is consistent with a transient timing problem but does not identify
which stage is responsible.

The spectator gain remains 0.25, matching the old FFmpeg volume setting. Set
`SPECTATOR_GAIN` in `.env.spectator` to tune it (0 through 2). Peak limiting
prevents integer overflow when speakers overlap; this is not loudness
normalization. The other required settings remain `BOT_ROLE`, `DISCORD_TOKEN`,
`GUILD_ID`, and `VOICE_CHANNEL_ID`. The optional `BLUE_PCM_PORT` (7001) and
`RED_PCM_PORT` (7002) must agree across all three roles and must differ.

## Verification and rollout

Run `npm run test:voice`. The accelerated 35-minute PCM simulation drives six
distinct speakers per team, overlapping speech and pauses, fragmented TCP
chunks, 400 ms stalls, and a Red disconnect/reconnect at minute 26. It checks
sample alignment throughout and bounded queues. Additional tests check mixing,
clipping, backpressure and PM2 lifecycle failures. This is simulated PCM time,
not a 35-minute live Discord/Opus/network test.

A second 35-minute simulation uses six producers per team with independent
phases and jitter, team and spectator clocks with different phases, TCP
fragments delivered in separate events, and an 80 ms playback pause at minute
26. It asserts the exact twelve-speaker sum after warmup, no underflows or
unaccounted sample losses, and bounded queues. The backpressure regression
test was verified to fail against the first Node replacement.

The host needs Node 22.12+ and a functioning native `@discordjs/opus` install.
This relay no longer needs an FFmpeg process; FFmpeg dependencies remain for
other project features. Keep the existing PM2 ecosystem configuration and env
files. Deploy the changed files together while no match is using the relay.
Start the existing three processes through the normal match flow (or start
them by name for a controlled test). Do not run duplicate copies of a role.

Before declaring the robotic-audio issue resolved, listen through a live match
for at least 35 minutes with six participants in each team channel. Verify each
team independently, overlapping speech, and one sender restarting while the
other continues. Check spectator `SPECTATOR READY` and per-minute `Health` logs:
queued bytes must stay bounded; continually increasing dropped bytes indicate
a timing/load problem worth investigating. Also check host CPU and Discord
packet loss if noise persists. No live deployment is performed by the tests.

Discord audio receive is not a documented Discord protocol contract; the
library warns that stable support is not guaranteed:
https://discord.js.org/docs/packages/voice/stable
