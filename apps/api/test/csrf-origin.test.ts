/**
 * #794 (#731 F-6, pen-test P-14) — cookie-credential CSRF origin check.
 *
 * A state-changing request authenticated by an admin/builder session
 * COOKIE (no Bearer header) must carry an allowlisted Origin (or Referer
 * origin); otherwise 403 FORBIDDEN + audit, before the handler runs.
 * Bearer-header auth and safe methods are unaffected.
 */
import { describe, expect, it, vi } from 'vitest';
import { createComposition } from '../src/composition';
import { checkCookieCsrf, requestOrigin } from '../src/middleware/csrf';
import { ErrorCodes, isProblemDetails } from '../src/middleware/errors';
import { createRateLimiter } from '../src/middleware/rate-limit';
import {
  createRequestPipeline,
  type CsrfDenial,
  type LogEntry,
  type PipelineRequest,
} from '../src/middleware/pipeline';
import type { AdminAuditStore } from '../src/services/admin-audit.store';

const ALLOWED = 'https://app.feasly.test';
const EVIL = 'https://evil.example';
const ALLOWLIST = [ALLOWED];
const ADMIN_COOKIE = 'feasly_admin_session=admintoken';
const BUILDER_COOKIE = 'feasly_builder_session=buildertoken';

describe('checkCookieCsrf', () => {
  it('allows an allowlisted Origin on a cookie-authenticated POST', () => {
    expect(
      checkCookieCsrf({
        method: 'POST',
        headers: { cookie: ADMIN_COOKIE, origin: ALLOWED },
        allowlist: ALLOWLIST,
      }),
    ).toEqual({ allowed: true });
  });

  it('matches the allowlist case-insensitively', () => {
    expect(
      checkCookieCsrf({
        method: 'post',
        headers: { cookie: ADMIN_COOKIE, origin: 'HTTPS://APP.FEASLY.TEST' },
        allowlist: ALLOWLIST,
      }).allowed,
    ).toBe(true);
  });

  it('denies an evil Origin (admin cookie)', () => {
    expect(
      checkCookieCsrf({
        method: 'POST',
        headers: { cookie: ADMIN_COOKIE, origin: EVIL },
        allowlist: ALLOWLIST,
      }),
    ).toEqual({ allowed: false, reason: 'origin_not_allowed', cookie: 'admin' });
  });

  it('denies a missing Origin and Referer (builder cookie)', () => {
    expect(
      checkCookieCsrf({
        method: 'POST',
        headers: { cookie: BUILDER_COOKIE },
        allowlist: ALLOWLIST,
      }),
    ).toEqual({ allowed: false, reason: 'origin_missing', cookie: 'builder' });
  });

  it('denies an opaque `Origin: null`', () => {
    expect(
      checkCookieCsrf({
        method: 'POST',
        headers: { cookie: BUILDER_COOKIE, origin: 'null' },
        allowlist: ALLOWLIST,
      }).allowed,
    ).toBe(false);
  });

  it('falls back to the Referer origin when Origin is absent', () => {
    expect(
      checkCookieCsrf({
        method: 'DELETE',
        headers: { cookie: BUILDER_COOKIE, referer: `${ALLOWED}/builder/users?x=1` },
        allowlist: ALLOWLIST,
      }).allowed,
    ).toBe(true);
    expect(
      checkCookieCsrf({
        method: 'DELETE',
        headers: { cookie: BUILDER_COOKIE, referer: `${EVIL}/${ALLOWED}` },
        allowlist: ALLOWLIST,
      }),
    ).toEqual({ allowed: false, reason: 'origin_not_allowed', cookie: 'builder' });
  });

  it('does not accept an allowlisted origin as a prefix of another host', () => {
    expect(
      checkCookieCsrf({
        method: 'POST',
        headers: { cookie: ADMIN_COOKIE, origin: `${ALLOWED}.evil.example` },
        allowlist: ALLOWLIST,
      }).allowed,
    ).toBe(false);
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('allows safe method %s from any origin', (method) => {
    expect(
      checkCookieCsrf({
        method,
        headers: { cookie: ADMIN_COOKIE, origin: EVIL },
        allowlist: ALLOWLIST,
      }).allowed,
    ).toBe(true);
  });

  it('treats an unknown (undefined) method as state-changing (fail closed)', () => {
    expect(
      checkCookieCsrf({
        method: undefined,
        headers: { cookie: ADMIN_COOKIE, origin: EVIL },
        allowlist: ALLOWLIST,
      }).allowed,
    ).toBe(false);
  });

  it('allows Bearer-authenticated requests from any origin (cookie never consulted)', () => {
    expect(
      checkCookieCsrf({
        method: 'POST',
        headers: { cookie: ADMIN_COOKIE, authorization: 'Bearer tok', origin: EVIL },
        allowlist: ALLOWLIST,
      }).allowed,
    ).toBe(true);
  });

  it('still checks when the Authorization header is not a Bearer token (cookie path)', () => {
    expect(
      checkCookieCsrf({
        method: 'POST',
        headers: { cookie: ADMIN_COOKIE, authorization: 'Basic abc', origin: EVIL },
        allowlist: ALLOWLIST,
      }).allowed,
    ).toBe(false);
  });

  it('allows requests with no session cookie (public / token / webhook routes)', () => {
    expect(
      checkCookieCsrf({
        method: 'POST',
        headers: { cookie: 'other=1', origin: EVIL },
        allowlist: ALLOWLIST,
      }).allowed,
    ).toBe(true);
    expect(
      checkCookieCsrf({ method: 'POST', headers: {}, allowlist: ALLOWLIST }).allowed,
    ).toBe(true);
  });

  it('denies everything cookie-authenticated when the allowlist is empty', () => {
    expect(
      checkCookieCsrf({
        method: 'POST',
        headers: { cookie: ADMIN_COOKIE, origin: ALLOWED },
        allowlist: [],
      }).allowed,
    ).toBe(false);
  });
});

describe('requestOrigin', () => {
  it('prefers Origin, else parses Referer, else undefined', () => {
    expect(requestOrigin({ origin: ALLOWED, referer: `${EVIL}/x` })).toBe(ALLOWED);
    expect(requestOrigin({ referer: `${ALLOWED}/a/b` })).toBe(ALLOWED);
    expect(requestOrigin({ referer: 'not a url' })).toBeUndefined();
    expect(requestOrigin({})).toBeUndefined();
  });
});

function csrfPipeline(onDenied?: (d: CsrfDenial) => Promise<void>) {
  const logs: LogEntry[] = [];
  const pipeline = createRequestPipeline({
    rateLimiter: createRateLimiter({ windowMs: 60_000, maxRequests: 1000, maxTrackedKeys: 1000 }),
    logger: (entry) => {
      logs.push(entry);
    },
    csrf: { allowlist: ALLOWLIST, onDenied },
  });
  return { pipeline, logs };
}

function req(headers: PipelineRequest['headers'], method = 'POST'): PipelineRequest {
  return { headers, clientIp: '1.2.3.4', method };
}

describe('createRequestPipeline — csrf (#794)', () => {
  it('runs the handler for an allowlisted origin', async () => {
    const onDenied = vi.fn(async () => {});
    const { pipeline } = csrfPipeline(onDenied);
    const handler = vi.fn(async () => ({ ok: true }));
    const result = await pipeline.run(req({ cookie: BUILDER_COOKIE, origin: ALLOWED }), handler);
    expect(result).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
    expect(onDenied).not.toHaveBeenCalled();
  });

  it.each([
    ['evil origin', { cookie: BUILDER_COOKIE, origin: EVIL }, 'origin_not_allowed', 'builder'],
    ['missing origin', { cookie: ADMIN_COOKIE }, 'origin_missing', 'admin'],
  ] as const)('403 + audit for %s, handler never runs', async (_label, headers, reason, cookie) => {
    const onDenied = vi.fn(async (_d: CsrfDenial) => {});
    const { pipeline, logs } = csrfPipeline(onDenied);
    const handler = vi.fn(async () => ({ ok: true }));
    const result = await pipeline.run(
      req({ ...headers, 'x-correlation-id': 'corr-1' }),
      handler,
    );
    expect(handler).not.toHaveBeenCalled();
    expect(isProblemDetails(result)).toBe(true);
    if (!isProblemDetails(result)) return;
    expect(result.status).toBe(403);
    expect(result.code).toBe(ErrorCodes.FORBIDDEN);
    expect(onDenied).toHaveBeenCalledWith({
      correlationId: 'corr-1',
      method: 'POST',
      reason,
      cookie,
    });
    const warn = logs.find((l) => l.message.startsWith('csrf-denied'));
    expect(warn?.level).toBe('warn');
    // The attacker-controlled origin never reaches the logs.
    expect(logs.some((l) => l.message.includes('evil.example'))).toBe(false);
  });

  it('still returns 403 (not 500) when the audit write fails', async () => {
    const { pipeline, logs } = csrfPipeline(async () => {
      throw new Error('db down');
    });
    const handler = vi.fn(async () => ({ ok: true }));
    const result = await pipeline.run(req({ cookie: ADMIN_COOKIE, origin: EVIL }), handler);
    expect(handler).not.toHaveBeenCalled();
    expect(isProblemDetails(result) && result.status).toBe(403);
    expect(logs.some((l) => l.level === 'error' && l.message.includes('audit failed'))).toBe(true);
  });

  it('lets Bearer-authenticated and GET requests through from any origin', async () => {
    const { pipeline } = csrfPipeline();
    const handler = vi.fn(async () => 'ok');
    await expect(
      pipeline.run(req({ cookie: ADMIN_COOKIE, authorization: 'Bearer t', origin: EVIL }), handler),
    ).resolves.toBe('ok');
    await expect(
      pipeline.run(req({ cookie: ADMIN_COOKIE, origin: EVIL }, 'GET'), handler),
    ).resolves.toBe('ok');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when the pipeline has no csrf config', async () => {
    const pipeline = createRequestPipeline({
      rateLimiter: createRateLimiter({ windowMs: 60_000, maxRequests: 1000, maxTrackedKeys: 1000 }),
      logger: () => {},
    });
    await expect(
      pipeline.run(req({ cookie: ADMIN_COOKIE, origin: EVIL }), async () => 'ok'),
    ).resolves.toBe('ok');
  });
});

describe('composition — every pipeline enforces the csrf check (#794)', () => {
  const PIPELINES = [
    'requestPipeline',
    'leadPipeline',
    'estimatePipeline',
    'analyticsPipeline',
    'webTelemetryPipeline',
    'entraCallbackPipeline',
    'builderEntraCallbackPipeline',
    'adminSearchPipeline',
    'webhookPipeline',
  ] as const;

  function compose() {
    const logged: Array<{ action: string; actorEmail: string | null; detail?: string }> = [];
    const adminAuditStore = {
      append: vi.fn(),
      recent: vi.fn(async () => []),
      log: vi.fn(async (entry: { action: string; actorEmail: string | null; detail?: string }) => {
        logged.push(entry);
      }),
    } as unknown as AdminAuditStore;
    const app = createComposition(
      {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
        CORS_ORIGINS: ALLOWED,
      } as NodeJS.ProcessEnv,
      { adminAuditStore, logger: () => {} },
    );
    return { app, logged };
  }

  it.each(PIPELINES)('%s: evil origin → 403 + csrf.denied audit row', async (name) => {
    const { app, logged } = compose();
    const handler = vi.fn(async () => 'ok');
    const result = await app[name].run(
      { headers: { cookie: BUILDER_COOKIE, origin: EVIL }, clientIp: '9.9.9.9', method: 'POST' },
      handler,
    );
    expect(handler).not.toHaveBeenCalled();
    expect(isProblemDetails(result) && result.status).toBe(403);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.action).toBe('csrf.denied');
    expect(logged[0]?.actorEmail).toBeNull();
    expect(logged[0]?.detail).toContain('method=POST cookie=builder reason=origin_not_allowed');
    expect(logged[0]?.detail).not.toContain('evil');
  });

  it.each(PIPELINES)('%s: allowlisted origin → handler runs', async (name) => {
    const { app, logged } = compose();
    const result = await app[name].run(
      { headers: { cookie: BUILDER_COOKIE, origin: ALLOWED }, clientIp: '9.9.9.8', method: 'POST' },
      async () => 'ok',
    );
    expect(result).toBe('ok');
    expect(logged).toHaveLength(0);
  });
});

describe('adapters — every pipeline run passes the HTTP method (#794)', () => {
  it('each `.run({ ... })` call in src/functions carries `method: req.method`', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(__dirname, '../src/functions');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) files.push(full);
      }
    };
    walk(root);
    const offenders: string[] = [];
    let calls = 0;
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const re = /[Pp]ipeline\.run\(\s*\{([^}]*)\}/g;
      for (const m of src.matchAll(re)) {
        calls += 1;
        if (!/\bmethod:\s*req\.method\b/.test(m[1] ?? '')) offenders.push(file);
      }
    }
    expect(calls).toBeGreaterThan(30);
    expect(offenders).toEqual([]);
  });
});
