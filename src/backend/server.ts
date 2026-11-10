import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { requireSotaInvocation } from './sota-auth.js';
import { registerToolRoutes } from './tool-routes.js';
import { createErrorHandler } from './error-handler.js';
import { startWebhookService } from './index-service.js';
import { installBodyParsers } from './webhook-routes.js';
import { defaultLog as log } from './shared/logger.js';

const appId = 'vnaip-dedup';
const app = express();
app.disable('x-powered-by');
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

// Webhook index do VNAIP BE gọi thẳng (không qua Core, không có invocation JWT):
// tự xác thực bằng chữ ký HMAC-SHA256 trên raw body và chỉ đẩy job vào hàng đợi.
// Worker index chạy ở tiến trình riêng (worker.ts), trừ QUEUE_MOCK_MODE=true khi
// cục bộ. Thiếu cấu hình thì startWebhookService trả null và webhook trả 503,
// app vẫn khởi động bình thường.
const webhookService = await startWebhookService();
// Route webhook được mount TRƯỚC parser JSON chung (installBodyParsers) để nó tự
// đọc raw body cho chữ ký HMAC; Express tự quyết path nào khớp nên không cần
// loại trừ path thủ công. Mọi route cần req.body phải đăng ký SAU dòng này.
installBodyParsers(app, webhookService?.webhook ?? null);

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

app.use(createErrorHandler(log));

const defaultLocalPort = 8787;
const port = Number(process.env.PORT ?? defaultLocalPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  log('error', 'server_failed', { appId, message: 'PORT must be an integer from 1 to 65535' });
  process.exitCode = 1;
  // Đóng kết nối Redis để tiến trình thoát thay vì treo.
  void webhookService?.stop();
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
    void webhookService?.stop();
  });

  // Tắt êm khi nền tảng gửi SIGTERM (ví dụ lúc deploy): ngừng nhận request rồi
  // đóng kết nối Redis. Job đang xử lý là việc của worker, không phải của web.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'shutdown_started', { signal });
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    const queueClosed = (webhookService?.stop() ?? Promise.resolve()).catch(() => undefined);
    void Promise.all([httpClosed, queueClosed]).then(() => {
      log('info', 'shutdown_done', { signal });
      process.exit(0);
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
