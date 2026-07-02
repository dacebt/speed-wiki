# CLAUDE.md

Wiki Speedrun — a multiplayer party game where friends join a room by code and
race each other from the same Wikipedia article to the same goal article,
clicking only links on the page. Fastest path wins the round; points accumulate
across rounds for the session. Light, fast, funny — a game you play on a call
with friends, not a competitive platform.

## Ground rules

- Solo project (David). No co-author trailers on commits, ever — no
  "Co-Authored-By", no "Generated with" footers.
- Read ARCHITECTURE.md before writing code. It defines the shape and the
  never-allowed list; it explains, the code is the source of truth for contents.
- `prototype/` is write-only spike territory. Production code never imports
  from it.

## Hard external constraints

- Wikipedia cannot be iframed (X-Frame-Options / frame-ancestors). Articles are
  fetched from its REST API and rendered by us. Do not re-attempt embedding.
