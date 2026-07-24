# Wiki Speedrun

Wiki Speedrun is a small multiplayer race through Wikipedia. One Cloudflare Worker
serves the React application and same-origin HTTP/WebSocket API, while one
SQLite-backed Durable Object owns each ephemeral Room.

## Local development

Install dependencies with `pnpm install`, then start the complete local product:

```sh
pnpm dev
```

Vite prints the local URL. The browser fetches Wikipedia article content directly,
so normal race play needs network access even though Room state stays in the local
Worker runtime.

## Verification

Run the repository checks and production build:

```sh
pnpm check
pnpm build
```

`pnpm smoke` boots the local application and drives the two-browser create, join,
reconnect, prepare, race, results, replay, replacement, and kick journey. With an
already running local application, `pnpm probe` drives the same public browser path
without starting another server.

## Deployment packaging

This command builds the application and asks Wrangler to compile the deployment
locally without uploading it:

```sh
pnpm deploy:dry-run
```

`pnpm deploy` is the production deployment command. It changes Cloudflare state and
must not be run until the user separately authorizes that exact external action.
Cloudflare login, account lookup, route discovery, DNS, and deployed-URL checks are
also outside local verification.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the runtime and state model.
