import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

/**
 * Core giả cho test xác thực: phục vụ JWKS và ký token invocation bằng khoá
 * EdDSA tạo tại chỗ. sota-auth.ts đọc SOTA_CORE_ORIGIN lúc import, nên test phải
 * đặt biến này (và import module) SAU khi gọi setupFakeCore().
 */
export async function setupFakeCore() {
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

export async function signToken(
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
