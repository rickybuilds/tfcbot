# Shared Blackjack Table Design

## Intent

Add blackjack as a public, shared casino-channel game alongside the bot's existing point games. The table supports 2–5 players, with individual player hands competing against one shared dealer hand.

## Goals and constraints

- `!blackjack` opens one public table message in the configured casino channel.
- The table has five seats. Joining an open seat opens a private Discord modal for the player's wager; initial wager is 1–500 points and must be affordable.
- On a successful join, that seat is occupied and its button is disabled for everyone else.
- The player who opened the table with `!blackjack` can choose **Deal now**, even if they have not taken a seat. Otherwise, the join window lasts 60 seconds and then closes and deals automatically.
- If no one joins before the window closes, the table closes without dealing.
- Initial hand wager maximum is 500 points. A split creates a second hand with an additional wager up to 500, so total exposure can reach 1,000 points if affordable.
- Each player controls only their own hand. Actions and dealer resolution are shown in the same casino channel; no threads or game channels are created.
- Follow existing casino channel restrictions, point ledger, and persistent SQLite game-state conventions.

## Blackjack rules

- Standard 52-card deck, shuffled for each table round; card points are 2–10 at face value, J/Q/K=10, and A=1 or 11 as best fits without busting.
- Each seated player gets two cards; dealer gets two cards with one hidden until all active player hands resolve.
- Actions: Hit, Stand, Double (double the current hand's wager, draw exactly one card, then stand), Split (allowed on equal rank starting cards; create a second hand with a separate wager up to 500 and sufficient available balance).
- Split aces receive one card per hand and then stand. No resplitting in the initial version.
- Dealer stands on all 17s. Dealer blackjack is checked before player actions; player natural blackjack pays 3:2, regular win 1:1, push returns stake, loss returns zero. Split-hand 21 is not a natural blackjack.
- After the 60-second table wait, subsequent player action turns time out after 60 seconds and auto-stand that hand. Deal now is available to any seated player before dealing.

## Approaches considered

1. Separate 1:1 blackjack rounds: simplest, but does not deliver the requested social table.
2. Shared in-memory table: quick to prototype, but restart recovery and safe stake accounting are weaker than existing games.
3. Persisted shared table with one public Discord message and private join modals: recommended. It matches shared craps persistence and current modal/button conventions while keeping the requested casino-channel experience.

## Implementation choices

Use approach 3. Create an open table record keyed to guild/channel, persistent seat and hand state, and escrow stakes through the existing point ledger. Update the table message as seats fill and actions resolve. Store message ID and deadline so timers and restart recovery can update or finish open tables. Prevent concurrent active blackjack tables in the same guild/channel. Use interaction IDs for idempotent ledger operations.

## Out of scope

Cash wagers, private game channels, threads, spectators betting on a round, insurance, surrender, resplitting, and multiple concurrent tables in one casino channel.

## Remaining implementation decisions

Use Discord's standard modal for seat stakes and per-hand action buttons. Use an unref'd timer while running plus a database deadline scan on service startup to recover expired join/action windows. Any Discord message edit failure must not repeat settlement; database transitions and ledger postings are authoritative.
