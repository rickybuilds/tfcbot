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

## Prevent new premature downloads

After inspecting and validating original sources, add to `/root/tfcbot/.env`:

```dotenv
HLTV_FINALIZATION_CHECK_ENABLED=true
HLTV_FINALIZATION_WAIT_MS=120000
```

Restart `tfcbot` when operationally appropriate. The feature defaults off. The wait is bounded per selected file (up to two minutes by default, configurable between one second and ten minutes). Each SFTP inspection also has a bounded timeout. The same selected filenames are kept; the guard does not substitute an older recording of the same map. It polls only small header/directory ranges and checks map, file size/type, directory bounds and entry spans. After the source has finalized, the existing `fastGet` downloads that file once for BOTH Discord ZIP delivery and retention. The downloaded header/directory and source metadata must still match before the file is renamed/published.

On timeout or change, the HLTV fetch reports a failure and autoRecap's existing catch continues its report without a demo ZIP. It does not publish the unfinished bytes as a ready handoff. A post-transfer failure leaves the private `.part` file for operator inspection. No automatic second full download or background recovery is introduced. The guard does not stop HLTV, change the game server, repair old files, bypass the analyzer's completeness checks, release evidence holds or change cleanup policy.

Validation covers unfinished and finalized headers, wrong maps, malformed directory entries, source changes, bounded waits, small range reads, downloaded-file verification and single-download integration. Actual SFTP server outcomes must still be checked on the deployment; no server credentials or originals are available in the development checkout.
