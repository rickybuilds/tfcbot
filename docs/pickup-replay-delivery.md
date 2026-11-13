# Pickup replay delivery

The bot can request replay upload after a full match and web-server game-details import after verified delivery. Disabled by default until `PICKUP_DELIVERY_ENABLED=true` and dedicated SSH settings are installed.

Deployment instructions and root-owned forced-command helpers live in the website repository:
https://github.com/rickybuilds/nonamepickup-web/blob/main/docs/bot-replay-delivery-setup.md

One private key stays on the bot host. Every destination authorizes its public key with a source-IP restriction and a forced command. Existing HLTV/SFTP credentials are unchanged. Unknown SSH host keys are rejected.

The bot saves a finalize job at round-two completion, before stopping the recorder and processing the recap. Recap completion releases the job. After a restart, an unreleased job is recoverable after its two-minute grace only when the match is completed and both recording rows are ready. Current stored analytics are used on recovery; analytics interrupted by the restart may require an explicit later reimport. Recorder finalization failures leave a visible finalize job pending until reconciliation restores ready rows. A failed report leaves the job pending until match completion is repaired.

New uploads defer during active matches on pickup servers sharing the configured SSH host. Once started, uploads are never stopped, and the next match is never blocked. Upload receipts allow safe retry. Successful delivery advances to import after 35 seconds; web failures retry import without requesting another upload. Jobs survive restarts in `pickup_replay_delivery_jobs` in the matches-store SQLite database.

Disable independent game-server upload timers when enabling this feature. Leave web maintenance cron enabled for recovery. Only bot-tracked pickup matches participate in the busy check; tracking-only skill servers are excluded. Servers sharing a machine must use the same SSH host string for grouping.

No production keys, timers, service settings or environment values are changed by installing this code.
