import type { ApiErrorResponse } from '@wikispeedrun/shared';
import { SELF } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import worker from './index.js';

describe('Worker routing', () => {
  test('GET /health returns the exact uncached JSON health contract', async () => {
    const response = await SELF.fetch('https://example.test/health');

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await response.text()).toBe('{"ok":true}');
  });

  test.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    '%s /health is a bounded method error',
    async (method) => {
      const response = await SELF.fetch('https://example.test/health', { method });

      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json<ApiErrorResponse>()).toEqual({
        error: {
          code: 'invalid-request',
          message: 'Health accepts GET only.',
        },
      });
    },
  );

  test('HEAD /health returns the same bounded method metadata without a body', async () => {
    const response = await SELF.fetch('https://example.test/health', { method: 'HEAD' });

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });

  test('an unknown API route remains an uncached JSON 404', async () => {
    const response = await SELF.fetch('https://example.test/api/not-a-route');

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json<ApiErrorResponse>()).toEqual({
      error: { code: 'room-not-found', message: 'No API route found.' },
    });
  });

  test.each(['/race/example', '/health/'])(
    '%s remains on the SPA asset route',
    async (pathname) => {
      const assetResponse = new Response('<div id="root"></div>', {
        headers: { 'Content-Type': 'text/html' },
      });
      const fetch = vi.fn().mockResolvedValue(assetResponse);
      const request = new Request(`https://example.test${pathname}`) as unknown as Parameters<
        typeof worker.fetch
      >[0];
      const response = await worker.fetch(request, { ASSETS: { fetch } } as unknown as Env);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');
      expect(await response.text()).toContain('<div id="root"></div>');
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
});
