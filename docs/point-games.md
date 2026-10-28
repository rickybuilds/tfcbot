# Discord point games

Point games use the same available points as match predictions; they do not affect Elo or prediction stake progression. Commands and results are public in the server, including wager and player names; account balances remain private through `!bank`. Stakes are whole numbers from 1 to 100 points.

- `!roulette <red|black|odd|even|low|high|0-36> <points>` spins a single-zero wheel. Even-money selections return twice the stake on a win; an exact number returns 36 times the stake. Zero is green and loses every even-money bet. After a successful spin, everyone in that Discord server must wait 120 seconds before the next spin; the timer survives bot restarts. Rejected commands do not start the timer.
- `!coinflip <heads|tails> <points>` returns twice the stake for a correct choice.
- `!duel @player <points>` offers an equal-stake challenge. The named player accepts using `!duel accept <challenge message ID>` shown in the bot response. Challenges expire after two minutes, do not reserve points, and require both players to have sufficient available points on acceptance. The winner is selected at random and gains the opponent's stake.

Set `POINT_GAMES_ENABLED=1` to enable games independently, or `POINT_GAMES_ENABLED=0` to disable them. If unset, it follows `PREDICTIONS_ENABLED` (which defaults off). Set `ROULETTE_COOLDOWN_SECONDS` to a whole number from 0 to 86400; the default is 120. The existing `!pred pause` also stops new game plays and duel acceptances until resumed. Point transfers, payouts, house funding and collections are recorded atomically in the prediction ledger. Operation IDs prevent repeat processing of the same Discord message.
