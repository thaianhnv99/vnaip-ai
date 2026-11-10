import type { Express } from 'express';
import { requireSotaInvocation, type InvocationClaims } from '../platform/sota-auth.js';
import { unwrapToolInput } from '../platform/tool-envelope.js';

/**
 * Route mẫu do scaffold `sota init` sinh ra: `GET /api/hello` (scope `app:http`) và
 * `POST /tools/example` (scope `tool:example`). Cả hai KHÔNG có trong manifest.yaml nên Core
 * không định tuyến tới; giữ lại để không đổi bề mặt HTTP trong đợt tái cấu trúc. Xoá file
 * này và một dòng gọi ở app.ts khi không cần nữa.
 */
export function registerScaffoldRoutes(app: Express, appId: string): void {
  app.get('/api/hello', requireSotaInvocation(appId, 'app:http'), (_request, response) => {
    const claims = response.locals.sota;
    response.json({
      message: 'Frontend and backend are connected.',
      appId,
      context: {
        organizationId: claims.oid,
        workspaceId: claims.wid,
        userId: claims.sub,
      },
    });
  });

  app.post('/tools/example', requireSotaInvocation(appId, 'tool:example'), async (request, response) => {
    response.json(await handleExampleTool(unwrapToolInput(request.body), response.locals.sota));
  });
}

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
