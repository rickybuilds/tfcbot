# HLTV recording finalization

An HLDEMO recording with directory offset zero is unfinished. The retained later demos from several matches have this header, while their map names are correct. The current download path waits three seconds and checks byte counts but does not prove the recording stopped. This establishes a missing collection safeguard; it does not yet establish whether the original HLTV server files later finalized or never finalized.

## Inspect the original sources first

Pull the bot checkout in `/root/tfcbot`, then run either read-only command:

```sh
node /root/tfcbot/scripts/checkHltvSources.js --match DZW8NE
node /root/tfcbot/scripts/checkHltvSources.js --all-failed
```

The script loads the existing bot `.env`, registry database and per-server SFTP settings. It reads local headers and small remote header/directory ranges (at most 100 registered recordings per invocation). It performs no full demo download, database update, remote command, recording stop, upload, deletion or file replacement. No bot restart is needed for inspection.

- `recovery_candidate:true`: the local copy is unfinished, but the exact original filename on the configured server now has a stable, structurally valid directory. A separate, explicit recovery can retrieve that completed version. Preserve the old held artifact and audit history; different bytes must not overwrite an existing registered SHA-256 silently.
- `remote_finalized:false` / `unfinalized_demo`: the original still has no directory. Waiting longer before a download cannot repair a recording that never closes. Investigate the HLTV recording owner/plugin and stop/finalize behavior on that game server. This repository has no HLTV stop-record command or recorder plugin to change; do not guess one or stop an active match.
- A missing original is not recoverable through this tool. Keep the existing bytes for inspection. Header/map/directory errors and source changes are reported separately.

These checks validate container finalization only, not log pairing, full packet decoding, parser compatibility or firing accuracy. No directory entries or demo content are fabricated to make analysis pass.

## Recover originals confirmed finalized

Update both the website and bot repositories first. On the shared server run:

```sh
flock -n /var/lib/noname-hltv-worker/worker.lock node /root/tfcbot/scripts/recoverHltvSources.js --apply
```

Use `--match DZW8NE` to restrict recovery to one match, or `--api-root /var/www/tfcbot/api` to name the API checkout explicitly (that is the default). The script reads bot SFTP credentials and API storage/analysis settings without changing either `.env`. Both must point at the same private registry/storage. API upstream and statistics must be enabled for the queued work. The command selects at most 100 available originals whose latest analysis failed, excluding replacement artifacts. It does not run the decoder or send Discord uploads; successful imports are explicitly queued for the existing worker.

Append `--analyze` to process those specific recovery jobs serially in the same locked command, ahead of unrelated queued games. This explicitly runs the existing upstream worker, with its configured resource limits and production alert settings; no Discord recap uploads are sent. Already terminal jobs are reported without falling through to another game. Without this option, cron processes the queued recovery jobs normally.

For each unfinished local capture, it checks the exact original filename on the configured server, retrieves the finalized version once into a separate private match/map/server folder, verifies source stability and the downloaded directory, then asks the API registry to verify the original byte prefix. The only permitted prefix difference is the four-byte directory offset in the header, with extra data appended to the original capture. A filename/map match alone is insufficient. Different or truncated prefixes fail closed and remain available for inspection.

The registry transaction creates a new demo/checksum, a persistent analysis hold and one recovery link/run; original bytes, IDs, checksums, reviews, assignments and holds remain unchanged. The stronger retention class and expiry are preserved on the recovered version. Review details link both versions. Re-running a completed recovery returns its existing link/run without another download or analysis hold. If interrupted after a completed download but before registration, the same deterministic recovery path is verified and reused. Existing `.part` files are never silently overwritten; inspect them before retrying. Disk headroom must cover the configured reserve plus the new file. This one-time recovery download is explicit; routine collection still has only one full download per demo.

Recovered paths look like `incoming/DZW8NE-schtop-central-recovery-<original-id>/DZW8NE-schtop-recovered.dem`. Old UUID folders are not renamed because manifests, evidence and active workflows reference their storage keys. For readable authenticated downloads after log pairing, enable `HLTV_FRIENDLY_DEMO_NAMES_ENABLED=true` in the website API `.env`; verified downloads then use `DZW8NE-schtop-round-2.dem`. Unpaired recordings use an explicit `unpaired` name. This naming flag defaults off and never establishes a log round from timestamp order.

Set the same `HLTV_FRIENDLY_DEMO_NAMES_ENABLED=true` in the bot `.env` for future routine collection folders named `<match>-<map>-<server>-<uuid>`. The UUID suffix avoids collisions; original remote filenames stay inside those folders for source lookup. This bot setting also defaults off and takes effect after restarting the bot. Existing folders are left untouched. Verified round labels are applied to authenticated downloads rather than guessing a round for local files before log pairing.

## Prevent new premature downloads

After inspecting and validating original sources, add to `/root/tfcbot/.env`:

```dotenv
HLTV_FINALIZATION_CHECK_ENABLED=true
HLTV_FINALIZATION_WAIT_MS=120000
```

Restart `tfcbot` when operationally appropriate. The feature defaults off. The wait is bounded per selected file (up to two minutes by default, configurable between one second and ten minutes). Each SFTP inspection also has a bounded timeout. The same selected filenames are kept; the guard does not substitute an older recording of the same map. It polls only small header/directory ranges and checks map, file size/type, directory bounds and entry spans. After the source has finalized, the existing `fastGet` downloads that file once for BOTH Discord ZIP delivery and retention. The downloaded header/directory and source metadata must still match before the file is renamed/published.

On timeout or change, the HLTV fetch reports a failure and autoRecap's existing catch continues its report without a demo ZIP. It does not publish the unfinished bytes as a ready handoff. A post-transfer failure leaves the private `.part` file for operator inspection. No automatic second full download or background recovery is introduced. The guard does not stop HLTV, change the game server, repair old files, bypass the analyzer's completeness checks, release evidence holds or change cleanup policy.

Validation covers unfinished and finalized headers, wrong maps, malformed directory entries, source changes, bounded waits, small range reads, downloaded-file verification and single-download integration. Actual SFTP server outcomes must still be checked on the deployment; no server credentials or originals are available in the development checkout.
