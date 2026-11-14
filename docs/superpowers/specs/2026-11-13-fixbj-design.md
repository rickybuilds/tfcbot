# `!fixbj` Design

- **Intent:** Let configured admins clear a stuck blackjack table in the current Discord channel so a new table can start.
- **Behavior:** `!fixbj` is restricted to the configured admin role and current channel. It refunds every outstanding seat or hand stake, marks the round cancelled, cancels its timer, and refreshes its existing table message. It reports when there is no open table.
- **Accounting:** Refunds use the existing point ledger and durable operation/idempotency keys. Joining rounds refund active seat stakes; playing rounds refund unsettled hand stakes, including double and split wagers. All changes occur atomically with cancelling the round.
- **Non-goals:** No cross-channel targeting, no deleting historical rows, and no refunding already settled hands or rounds.
- **Approach:** Add a transactional cancellation/refund operation to the blackjack game module and expose it through the existing point game command registration, using the same admin role configuration and table refresh/timer mechanisms already in use.
- **Calls:** Current-channel scope and full refund of outstanding stakes follow the request and confirmation. The existing ledger and cancellation state are retained for auditability.
