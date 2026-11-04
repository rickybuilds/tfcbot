# Discord point games

Point games use the same available points as match predictions; they do not affect Elo or prediction stake progression. Commands and results are public in the server, including wager and player names; account balances remain private through `!bank`. Stakes are whole numbers from 1 to 100 points.

Set `CASINO_CHANNEL_ID` to the Discord channel ID where `!roulette`, `!coinflip` and `!duel` should work. These commands are silently ignored in other channels and when the setting is missing. `!give`, `!bank`, and match prediction bets are unaffected. Duel buttons on already-posted challenges continue working until they expire.

- `!roulette <red|black|odd|even|low|high|0-36> <points>` spins a single-zero wheel. Even-money selections return twice the stake on a win; an exact number returns 36 times the stake. Zero is green and loses every even-money bet. Players can spin again immediately.
- `!coinflip <heads|tails> <points>` returns twice the stake for a correct choice.
- `!baccarat <player|banker|tie> <points>` deals a fresh eight-deck punto banco hand with standard automatic third-card rules. A player win returns twice the stake; a banker win returns the stake plus 95% profit, rounded down to whole points; a correct tie bet returns nine times the stake. On a tie, player and banker bets are refunded. Each return includes the stake.
- `!duel @player <points>` offers an equal-stake challenge. Only the named player can use the **Accept Duel** or **Decline Duel** buttons. Declining closes the challenge without moving points. Challenges expire after two minutes, do not reserve points, and require both players to have sufficient available points on acceptance. The winner is selected at random and gains the opponent's stake. Older challenges can still be accepted with `!duel accept <challenge message ID>` until they expire.
- `!give @player <points>` transfers a positive whole number of available points to another player. There is no 100-point game stake limit for gifts; the sender must have enough available points. The transfer is public, but balances remain private. A new recipient receives the usual one-time 1,000-point account grant as well as the gift.

Set `POINT_GAMES_ENABLED=1` to enable games independently, or `POINT_GAMES_ENABLED=0` to disable them. If unset, it follows `PREDICTIONS_ENABLED` (which defaults off). The existing `!pred pause` also stops new game plays and duel acceptances until resumed. Point transfers, payouts, house funding and collections are recorded atomically in the prediction ledger. Operation IDs prevent repeat processing of the same Discord message.

The prediction owner can use `!pred house` for a private all-time breakdown of roulette and coin-flip house collections, funding and net points. Duels and gifts are excluded because their points move between players rather than to or from the house.
