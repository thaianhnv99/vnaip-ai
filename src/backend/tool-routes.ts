import type { Express } from 'express';
import { requireSotaInvocation } from './sota-auth.js';
import { handleExampleTool } from './tool.example.js';
import { createCheckDuplicatesHandler } from './check-duplicates-route.js';

export function registerToolRoutes(app: Express, appId: string) {
  app.post('/tools/example', requireSotaInvocation(appId, 'tool:example'), async (request, response) => {
    const body = isRecord(request.body?.body) ? request.body.body : request.body;
    response.json(await handleExampleTool(body?.input ?? body, response.locals.sota));
  });

  app.post(
    '/tools/check-duplicates',
    requireSotaInvocation(appId, 'tool:check-duplicates'),
    createCheckDuplicatesHandler(),
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
