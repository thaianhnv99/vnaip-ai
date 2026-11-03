import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { requireSotaInvocation } from './sota-auth.js';
import { registerToolRoutes } from './tool-routes.js';

const appId = 'vnaip-dedup';
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((request, response, next) => {
  const startedAt = performance.now();
  const requestId = request.header('x-request-id') ?? randomUUID();
  response.setHeader('x-request-id', requestId);
  response.on('finish', () => log('info', 'http_request', {
    requestId,
    method: request.method,
    path: request.originalUrl,
    status: response.statusCode,
    durationMs: Math.round(performance.now() - startedAt),
  }));
  next();
});

app.get('/health', (_request, response) => {
  response.json({ status: 'ok', appId });
});

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

registerToolRoutes(app, appId);

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  log('error', 'request_failed', {
    message: error instanceof Error ? error.message : String(error),
  });
  response.status(500).json({ code: 'APP_ERROR', message: 'Request failed' });
});

const defaultLocalPort = 8787;
const port = Number(process.env.PORT ?? defaultLocalPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  log('error', 'server_failed', { appId, message: 'PORT must be an integer from 1 to 65535' });
  process.exitCode = 1;
} else {
  // Bind 0.0.0.0 so hosting platforms (e.g. Render) can detect the open port.
  // The manifest's environments.local.service.baseUrl still points at
  // localhost:8787 for local dev; in hosted environments the platform sets
  // PORT and that value is what we must honor.
  const server = app.listen(port, '0.0.0.0');
  server.once('listening', () => {
    log('info', 'server_started', { appId, url: `http://0.0.0.0:${port}` });
  });
  server.once('error', (error: NodeJS.ErrnoException) => {
    log('error', 'server_failed', {
      appId,
      code: error.code,
      message: error.message,
      url: `http://0.0.0.0:${port}`,
    });
    process.exitCode = 1;
  });
}

function log(level: 'info' | 'error', event: string, details: Record<string, unknown>) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details }));
}
