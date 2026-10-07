# Sentry metrics

`trackSentries` consumes upstream events after round culling and upstream player round statistics. It returns one row per Steam ID and team for engineers or players with observed sentry activity. Events are processed by game time, then source line number; input arrays are not mutated.

- `builds` counts logged builds. `upgrades` and `repairs` count events on the owner's gun, including actions performed by teammates; the teammate event's target identifies the owner.
- `totalKills` and `killsByLevel` count enemy **player** victims. `teamKills` is separate and excluded from those totals. Victims with unknown teams are excluded with a warning. `destroyed` counts the owner's guns destroyed by another player; it does not count players killed by the gun.
- `uptimeSeconds` sums the bounded standing lifetimes. A logged build starts a level-one gun. When build history is missing, the lifetime starts at its first observed evidence and the level stays unknown until a logged upgrade establishes it. No earlier uptime is invented.
- `levelSeconds` divides standing time into levels one, two, three and unknown. A jump from level one directly to level three makes the preceding segment and its kills unknown because the intermediate upgrade's time is missing. A decreasing level indicates an unlogged replacement and marks both lifetimes incomplete.
- Gun destruction, dismantling, detonation, owner disconnect and team departure close a lifetime. A new build closes any remaining prior gun with an incomplete replacement warning. Owner death does not close a gun. Class changes preserve standing history but mark removal time uncertain; they do close the engineer interval. Round end bounds any remaining gun.
- Sentry projectile kills appearing after removal in the **same log second** are attached to the just-ended lifetime at its last level, without adding standing time. Later evidence without a build starts a new incomplete lifetime; the log cannot establish whether it came from a delayed projectile or an unlogged gun.
- `uptimePercentRound` is standing time divided by round duration, multiplied by 100. It is null for a zero-length or unavailable round.
- `engineerSeconds` uses upstream class totals when available; otherwise it uses reconstructed class intervals only when initial class evidence reaches round start. It is null when the denominator is unknown.
- `uptimePercentEngineer` intersects gun lifetimes with reconstructed engineer intervals, then divides by engineer seconds. It is null when the denominator is zero/unknown or class totals do not match reconstructible intervals. Standing time outside engineer intervals never inflates this percentage.

Each `lives` entry contains `startSeconds`, `endSeconds`, `endReason`, `levelSeconds`, `killsByLevel`, `confidence` (`observed` or `incomplete`) and `levelSegments` (`startSeconds`, `endSeconds`, `level`). `round-end` is a censored endpoint, not a claim that the gun was destroyed. Warnings expose missing evidence and ambiguous class transitions. Prematch metadata can establish initial class; prematch/postmatch gun activity never contributes to metrics.

All durations use the upstream measured round boundary. They are not rounded up to a configured server time limit. Unknown history means these metrics describe observed evidence rather than guaranteed complete server history.
