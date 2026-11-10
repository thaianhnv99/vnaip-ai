import type { InvocationClaims } from '../platform/sota-auth.js';

export async function handleExampleTool(input: unknown, claims: InvocationClaims) {
  return {
    ok: true,
    input,
    context: {
      organizationId: claims.oid,
      workspaceId: claims.wid,
      userId: claims.sub,
    },
  };
}
