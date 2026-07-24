import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const config = readFileSync(new URL('./wrangler.jsonc', import.meta.url), 'utf8');

describe('Worker deployment configuration', () => {
  test('routes API and health requests through the Worker before SPA assets', () => {
    expect(config).toMatch(/"run_worker_first"\s*:\s*\[\s*"\/api\/\*"\s*,\s*"\/health"\s*\]/);
  });

  test('keeps the declarative SQLite Durable Object export without migrations', () => {
    expect(config).toMatch(/"exports"\s*:/);
    expect(config).toMatch(
      /"RoomDurableObject"\s*:\s*\{\s*"type"\s*:\s*"durable-object"\s*,\s*"storage"\s*:\s*"sqlite"/,
    );
    expect(config).not.toMatch(/"migrations"\s*:/);
  });
});
