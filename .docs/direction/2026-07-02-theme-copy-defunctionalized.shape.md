# Shape: theme-copy-defunctionalized — pull Grand Salon copy out of the functional layer

**Declared:** 2026-07-02
**Cadence:** Tight
**Git strategy:** commit to main

## In scope

- Every functional label — anything a player clicks, types into, or reads to
  understand their standing — says exactly what it is in plain words, per the
  backlog ticket's agreed replacements (Create a Room, Join Room, CODE,
  Room Code, Your name, Start Game, Give Up, Standings, Points, Total,
  Play Again).
- One vocabulary term per concept across all screens: room code is "code",
  clicks are "clicks", score is "points"/"total" — no seals, livres, fortunes,
  leaps, wagers, or philosophes in functional text.
- All thy/thee/thou register removed everywhere, including flavor lines;
  remaining flavor reads as plain modern English with a wink.
- Files: client/src/features/{home,lobby,countdown,race,results}/*.tsx,
  client/src/app/store.tsx, and the viewer slice's two user-facing strings
  (ArticlePane.tsx loading/error text).

## Out of scope (deliberately)

- Cosmetic labels in shared/src/cosmetics.ts ("The Scholar", "Mortarboard", …)
  — decorative, gate no action; they stay themed.
- The visual theme itself — parchment, gold rules, wax-seal chip, portraits,
  candle medals. No CSS or layout changes.
- The other three backlog tickets (copyable code / kick / player cap), even
  where the same files are touched.
- Renaming internal identifiers (e.g. the `WagerBoard` component) — code
  vocabulary cleanup is not user-facing copy and stays put unless free.

## Known risks

- No test suite exists; behavior verification is typecheck + driving the app
  in a browser via Playwright MCP. Copy regressions are only caught by eyes.
- "Functional vs decorative" is a judgment line; the ticket's audit is the
  ruling — where a string is ambiguous, prefer plain words.
- The lobby seat-count copy ("N of 8 seats taken") collides with the
  remove-player-cap ticket; this session rewords, that ticket changes meaning.

## Success signal

A first-time user can operate every screen without decoding a metaphor: home,
lobby, countdown, race, and results render plain functional labels
(verified by driving the running app through a full round in the browser),
and grep finds no seal/livres/fortune/leaps/wager/thy-register strings in
functional copy.

## Notes

Cadence, git strategy, and the two scope calls (viewer strings in, cosmetics
out) were the recommended defaults, taken after the user was away at the
prompt — override by redeclaring. Single capability; no capability map
warranted. No domain model: the ticket's acceptance list is the vocabulary
ruling.
