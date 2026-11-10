import express, { type Express } from 'express';
import { randomUUID } from 'node:crypto';
import { createErrorHandler } from './platform/error-handler.js';
import { installBodyParsers, type WebhookDependencies } from './indexing/webhook-routes.js';
import { registerScaffoldRoutes } from './scaffold/example-routes.js';
import { registerTools, type ToolRegistryOptions } from './tools/index.js';
import { defaultLog, type Logger } from './shared/logger.js';

export interface CreateAppOptions {
  appId: string;
  /**
   * Webhook index do VNAIP BE gọi thẳng (không qua Core, không có invocation JWT): tự xác thực
   * bằng chữ ký HMAC-SHA256 trên raw body và chỉ đẩy job vào hàng đợi. Thiếu cấu hình thì truyền
   * null: webhook trả 503, app vẫn khởi động bình thường (xem startWebhookService).
   */
  webhook: WebhookDependencies | null;
  log?: Logger;
  /** Chỉ test dùng để thay handler/chính sách người gọi của từng tool. */
  tools?: ToolRegistryOptions;
}

/**
 * Dựng ứng dụng Express: không lắng nghe cổng và không đọc `.env` (việc đó của server.ts).
 *
 * Thứ tự mount là hợp đồng, được khoá bởi __tests__/app-entrypoint.test.ts:
 *   1. log + x-request-id cho mọi request;
 *   2. route webhook, TRƯỚC parser JSON chung (installBodyParsers) để nó tự đọc raw body cho
 *      chữ ký HMAC; Express tự quyết path nào khớp nên không cần loại trừ path thủ công. Mọi
 *      route cần req.body phải đăng ký SAU bước này;
 *   3. /health (không cần xác thực), route scaffold, rồi các tool;
 *   4. error handler cuối cùng.
 */
export function createApp(options: CreateAppOptions): Express {
  const { appId, webhook, log = defaultLog } = options;

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

  installBodyParsers(app, webhook);

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', appId });
  });

  registerScaffoldRoutes(app, appId);
  registerTools(app, appId, options.tools);

  app.use(createErrorHandler(log));
  return app;
}
