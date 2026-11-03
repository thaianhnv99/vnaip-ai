import type { RequestHandler } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export type InvocationClaims = JWTPayload & {
  iid: string;
  oid: string;
  wid: string;
  scp: string[];
};

const coreOrigin = new URL(process.env.SOTA_CORE_ORIGIN ?? 'https://api.v4.stg.sotaagents.ai');
const jwks = createRemoteJWKSet(new URL('/.well-known/jwks.json', coreOrigin));

export function requireSotaInvocation(appId: string, scope: string): RequestHandler {
  return async (request, response, next) => {
    const token = /^Bearer\s+(.+)$/i.exec(request.header('authorization') ?? '')?.[1];
    if (!token) {
      response.status(401).json({ code: 'AUTH_ERROR', message: 'Missing invocation token' });
      return;
    }
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: 'sota/invocation-token',
        audience: appId,
        algorithms: ['EdDSA'],
        typ: 'sota-invocation+jwt',
        clockTolerance: 30,
      });
      assertClaims(payload, scope);
      response.locals.sota = payload;
      next();
    } catch (error) {
      // Say WHY. A bare "Invalid invocation token" hides the difference between
      // a wrong audience, a missing scope, a clock skew and a runtime that has
      // no global WebCrypto — and the caller sees the same dead end for all of
      // them. The reason goes to your logs together with the token's own header
      // and claims; the HTTP body carries the reason but never the token.
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(JSON.stringify({
        event: 'invocation_token_rejected',
        reason,
        received: describeToken(token),
        expected: { issuer: 'sota/invocation-token', audience: appId, scope },
      }));
      response.status(401).json({ code: 'AUTH_ERROR', message: `Invalid invocation token — ${reason}` });
    }
  };
}

/** Header and claims of an UNVERIFIED token, for diagnosis only. */
function describeToken(token: string) {
  const [header, claims] = token.split('.', 2).map((segment) => {
    try {
      return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as JsonRecord;
    } catch {
      return null;
    }
  });
  return {
    alg: header?.alg ?? null,
    typ: header?.typ ?? null,
    kid: header?.kid ?? null,
    iss: claims?.iss ?? null,
    aud: claims?.aud ?? null,
    scp: claims?.scp ?? null,
    ae: claims?.ae ?? null,
    exp: claims?.exp ?? null,
  };
}

type JsonRecord = Record<string, unknown>;

function assertClaims(payload: JWTPayload, scope: string): asserts payload is InvocationClaims {
  if (![payload.iid, payload.oid, payload.wid].every(
    (value) => typeof value === 'string' && value.length > 0,
  )) throw new Error('Token is missing tenant claims (iid, oid, wid must all be non-empty)');
  if (!Array.isArray(payload.scp) || !payload.scp.includes(scope)) {
    throw new Error(`Token scopes ${JSON.stringify(payload.scp ?? null)} do not include the required "${scope}"`);
  }
}
