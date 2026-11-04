import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Request, Response } from 'express';

/**
 * sota-auth.ts đọc SOTA_CORE_ORIGIN và tạo remote JWKS set TẠI THỜI ĐIỂM
 * import module. Test này phải set env var và khởi động JWKS server giả
 * TRƯỚC khi import '../sota-auth.js', nên dùng dynamic import.
 */

/**
 * sota-auth.ts resolves SOTA_CORE_ORIGIN once at import time, so each test
 * case needs its own fresh module instance. The `?case=` query-string
 * cache-buster is not a real file path, which `tsc` cannot statically
 * resolve — so this import is routed through an untyped indirection to
 * keep the build's module resolution clean while the Node ESM loader still
 * re-evaluates the module per distinct specifier at runtime.
 */
async function importFreshSotaAuth(cacheBustKey: string): Promise<typeof import('../sota-auth.js')> {
  const dynamicImport: (specifier: string) => Promise<typeof import('../sota-auth.js')> = (
    new Function('specifier', 'return import(specifier)') as any
  );
  return dynamicImport(`../sota-auth.js?case=${cacheBustKey}`);
}

async function setupFakeCore() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'EdDSA';
  jwk.use = 'sig';

  const server = createServer((request, response) => {
    if (request.url === '/.well-known/jwks.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake core server');
  const origin = `http://127.0.0.1:${address.port}`;

  return { server, origin, privateKey, kid: 'test-key-1' as const };
}

async function signToken(
  privateKey: CryptoKey,
  kid: string,
  overrides: Partial<{
    issuer: string;
    audience: string;
    typ: string;
    scp: string[];
    oid: string;
    wid: string;
    iid: string;
    expiresInSeconds: number;
    sub: string;
  }> = {},
) {
  const {
    issuer = 'sota/invocation-token',
    audience = 'vnaip-dedup',
    typ = 'sota-invocation+jwt',
    scp = ['tool:check-duplicates'],
    oid = 'org-1',
    wid = 'ws-1',
    iid = 'install-1',
    expiresInSeconds = 60,
    sub,
  } = overrides;

  return new SignJWT({ oid, wid, iid, scp, ...(sub ? { sub } : {}) })
    .setProtectedHeader({ alg: 'EdDSA', kid, typ })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
    .sign(privateKey);
}

function fakeRequestResponse(token?: string) {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const request = { header: (name: string) => headers[name.toLowerCase()] } as unknown as Request;

  const state: { status?: number; body?: unknown } = {};
  const response = {
    locals: {} as Record<string, unknown>,
    status(code: number) {
      state.status = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
  } as unknown as Response;

  return { request, response, state };
}

test('JWT hợp lệ với scope đúng đi qua middleware và set response.locals.sota', async () => {
  const core = await setupFakeCore();
  process.env.SOTA_CORE_ORIGIN = core.origin;
  const { requireSotaInvocation } = await importFreshSotaAuth('valid');

  try {
    const token = await signToken(core.privateKey, core.kid);
    const { request, response, state } = fakeRequestResponse(token);
    let nextCalled = false;

    await requireSotaInvocation('vnaip-dedup', 'tool:check-duplicates')(request, response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(state.status, undefined);
    assert.equal((response.locals.sota as any).oid, 'org-1');
  } finally {
    core.server.close();
  }
});

async function runAcceptedCall(cacheBustKey: string, logFlag: string | undefined) {
  const core = await setupFakeCore();
  process.env.SOTA_CORE_ORIGIN = core.origin;
  const { requireSotaInvocation } = await importFreshSotaAuth(cacheBustKey);
  const token = await signToken(core.privateKey, core.kid, { sub: 'svc-account-1' });
  const { request, response } = fakeRequestResponse(token);

  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: unknown) => {
    lines.push(String(line));
  };
  if (logFlag === undefined) delete process.env.LOG_VERIFIED_CLAIMS;
  else process.env.LOG_VERIFIED_CLAIMS = logFlag;

  try {
    await requireSotaInvocation('vnaip-dedup', 'tool:check-duplicates')(request, response, () => {});
  } finally {
    console.log = originalLog;
    delete process.env.LOG_VERIFIED_CLAIMS;
    core.server.close();
  }
  return { lines, token };
}

test('LOG_VERIFIED_CLAIMS=true ghi claims đã xác thực và không ghi token', async () => {
  const { lines, token } = await runAcceptedCall('log-claims-on', 'true');

  const record = JSON.parse(lines.find((line) => line.includes('invocation_accepted')) ?? 'null');
  assert.equal(record.claims.sub, 'svc-account-1');
  assert.equal(record.claims.oid, 'org-1');
  assert.equal(record.claims.wid, 'ws-1');
  assert.deepEqual(record.claims.scp, ['tool:check-duplicates']);
  assert.equal(lines.join('\n').includes(token), false);
});

test('không đặt LOG_VERIFIED_CLAIMS thì không ghi claims của lời gọi hợp lệ', async () => {
  const { lines } = await runAcceptedCall('log-claims-off', undefined);

  assert.equal(lines.some((line) => line.includes('invocation_accepted')), false);
});

test('thiếu Bearer token trả 401 AUTH_ERROR', async () => {
  const core = await setupFakeCore();
  process.env.SOTA_CORE_ORIGIN = core.origin;
  const { requireSotaInvocation } = await importFreshSotaAuth('missing-token');

  try {
    const { request, response, state } = fakeRequestResponse(undefined);
    await requireSotaInvocation('vnaip-dedup', 'tool:check-duplicates')(request, response, () => {
      throw new Error('next() không nên được gọi');
    });

    assert.equal(state.status, 401);
    assert.equal((state.body as any).code, 'AUTH_ERROR');
  } finally {
    core.server.close();
  }
});

test('JWT hết hạn bị từ chối với 401', async () => {
  const core = await setupFakeCore();
  process.env.SOTA_CORE_ORIGIN = core.origin;
  const { requireSotaInvocation } = await importFreshSotaAuth('expired');

  try {
    const token = await signToken(core.privateKey, core.kid, { expiresInSeconds: -60 });
    const { request, response, state } = fakeRequestResponse(token);
    await requireSotaInvocation('vnaip-dedup', 'tool:check-duplicates')(request, response, () => {
      throw new Error('next() không nên được gọi');
    });

    assert.equal(state.status, 401);
    assert.equal((state.body as any).code, 'AUTH_ERROR');
  } finally {
    core.server.close();
  }
});

test('audience sai bị từ chối với 401', async () => {
  const core = await setupFakeCore();
  process.env.SOTA_CORE_ORIGIN = core.origin;
  const { requireSotaInvocation } = await importFreshSotaAuth('wrong-aud');

  try {
    const token = await signToken(core.privateKey, core.kid, { audience: 'some-other-app' });
    const { request, response, state } = fakeRequestResponse(token);
    await requireSotaInvocation('vnaip-dedup', 'tool:check-duplicates')(request, response, () => {
      throw new Error('next() không nên được gọi');
    });

    assert.equal(state.status, 401);
  } finally {
    core.server.close();
  }
});

test('thiếu scope yêu cầu bị từ chối với 401', async () => {
  const core = await setupFakeCore();
  process.env.SOTA_CORE_ORIGIN = core.origin;
  const { requireSotaInvocation } = await importFreshSotaAuth('wrong-scope');

  try {
    const token = await signToken(core.privateKey, core.kid, { scp: ['tool:example'] });
    const { request, response, state } = fakeRequestResponse(token);
    await requireSotaInvocation('vnaip-dedup', 'tool:check-duplicates')(request, response, () => {
      throw new Error('next() không nên được gọi');
    });

    assert.equal(state.status, 401);
  } finally {
    core.server.close();
  }
});
