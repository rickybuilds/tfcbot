# Bootcamp account-link and Discord role sync

The Website verifies the Steam and Discord accounts and writes the existing shared `player_steam_ids` mapping. The Bot does not accept an identity submitted by a player; it consumes the Website's durable `bootcamp_account_link_outbox`, recomputes the Website's authoritative license, and synchronizes only configured license roles.

Both services must point to the same NoName `elo.db`. Account-link role synchronization is disabled by default and additionally depends on the existing Bootcamp watcher being enabled:

```dotenv
BOOTCAMP_WATCHER_ENABLED=false
BOOTCAMP_ACCOUNT_LINK_SYNC_ENABLED=false
BOOTCAMP_ACCOUNT_LINK_URL=https://noname.example/bootcamp.html
```

Configure `BOOTCAMP_ACCOUNT_LINK_URL` only after the Website has enabled its Steam OpenID and Discord OAuth flow. With that HTTPS URL configured, `!license` and `!learning` provide the self-service link. Without it, the current admin-managed `!linksteam` instructions remain the recovery path.

To enable Bot role sync in a non-production environment, explicitly set `BOOTCAMP_WATCHER_ENABLED=true` and `BOOTCAMP_ACCOUNT_LINK_SYNC_ENABLED=true`, configure the Website service token and license role IDs, and confirm the Bot can access the shared database. The worker claims pending rows once, retries failures using bounded backoff, and reclaims work left in `processing` by a crashed Bot. A row becomes `done` only after the Website license recomputation and Discord role sync return successfully.

This worker does not turn on learning-pug or main-queue enforcement. Keep those separate switches disabled until their eligibility policy is deliberately reviewed. See the Website's `docs/bootcamp-account-linking.md` for callback registration, stored flow fields, end-to-end setup, and rollback.
