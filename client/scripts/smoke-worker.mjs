import { spawn } from 'node:child_process';

const port = process.env.WORKER_PORT ?? '5173';
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn('pnpm', ['dev:worker', '--host', '127.0.0.1', '--port', port], {
  cwd: new URL('..', import.meta.url),
  detached: true,
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? '/tmp/speed-wiki-wrangler.log',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let diagnostics = '';
server.stdout.on('data', (chunk) => {
  diagnostics = `${diagnostics}${String(chunk)}`.slice(-8_000);
});
server.stderr.on('data', (chunk) => {
  diagnostics = `${diagnostics}${String(chunk)}`.slice(-8_000);
});

try {
  await waitUntilReady(baseUrl, server);
  const probe = await runProbe(baseUrl);
  if (probe.code !== 0) {
    throw new Error(`${probe.stderr}\n${diagnostics}`.trim());
  }
  process.stdout.write(probe.stdout);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (server.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      // The process group already exited.
    }
  }
}

async function waitUntilReady(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Worker development server exited early (${child.exitCode}).\n${diagnostics}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The local server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Worker development server did not become ready.\n${diagnostics}`);
}

function runProbe(url) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/probe-worker.mjs'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, BASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
