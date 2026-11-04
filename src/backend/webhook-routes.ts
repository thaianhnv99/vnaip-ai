import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Express, Request, RequestHandler } from "express";
import { IndexEventError, parseIndexEvent } from "./index-event.js";
import type { IndexJob, JobLogger } from "./index-job.js";
import type { JobQueue } from "./job-queue.js";

/**
 * Webhook index: VNAIP BE gọi thẳng, KHÔNG đi qua SotaAgents Core nên không có
 * invocation JWT và không có claims tenant (xem docs/ke-hoach-phat-trien.md,
 * mục 3.1). Route này không được khai báo trong manifest và tự xác thực bằng
 * API key.
 *
 * Không có tenant: mọi sáng kiến vào chung một tập dữ liệu (bỏ `datasetKey`,
 * 2026-11-04). Route chỉ đẩy job vào hàng đợi rồi trả 202; việc index do worker
 * (tiến trình riêng) làm, nên tiến trình web không cần khoá OpenRouter/Qdrant.
 */

export const MIN_API_KEY_LENGTH = 16;

export class WebhookConfigError extends Error {
  readonly code = "NOT_CONFIGURED" as const;

  constructor(message: string) {
    super(message);
    this.name = "WebhookConfigError";
  }
}

/**
 * WEBHOOK_API_KEYS gồm một hoặc nhiều key phân tách bằng dấu phẩy. Hai key
 * cùng hợp lệ trong lúc đổi key, nên không cần ngừng nhận event.
 */
export function loadWebhookApiKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys = (env.WEBHOOK_API_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  if (keys.length === 0) {
    throw new WebhookConfigError("Thiếu WEBHOOK_API_KEYS");
  }
  if (keys.some((key) => key.length < MIN_API_KEY_LENGTH)) {
    throw new WebhookConfigError(
      `Mỗi key trong WEBHOOK_API_KEYS phải dài tối thiểu ${MIN_API_KEY_LENGTH} ký tự`,
    );
  }
  return keys;
}

export interface WebhookDependencies {
  queue: JobQueue<IndexJob>;
  apiKeys: string[];
  log?: JobLogger;
  newJobId?: () => string;
  now?: () => Date;
}

export function registerWebhookRoutes(
  app: Express,
  deps: WebhookDependencies | null,
): void {
  app.post(
    "/webhooks/idea-approved",
    deps ? createIdeaApprovedHandler(deps) : webhookNotConfigured,
  );
}

const webhookNotConfigured: RequestHandler = (_request, response) => {
  response.status(503).json({
    code: "WEBHOOK_NOT_CONFIGURED",
    message: "Webhook index chưa được cấu hình. Vui lòng thử lại sau.",
  });
};

export function createIdeaApprovedHandler(deps: WebhookDependencies): RequestHandler {
  const log = deps.log ?? defaultLog;
  const keyDigests = deps.apiKeys.map(digest);

  return async (request, response) => {
    const requestId = response.getHeader("x-request-id") ?? null;

    const presented = presentedApiKey(request);
    if (!presented || !matchesAnyKey(presented, keyDigests)) {
      log("error", "webhook_rejected", {
        requestId,
        reason: presented ? "invalid_key" : "missing_key",
      });
      response.status(401).json({ code: "AUTH_ERROR", message: "API key không hợp lệ" });
      return;
    }

    let job: IndexJob;
    try {
      const event = parseIndexEvent(request.body);
      job = {
        jobId: (deps.newJobId ?? randomUUID)(),
        ideaId: event.ideaId,
        type: event.type,
        title: event.title,
        content: event.content,
        metadata: event.metadata,
        receivedAt: (deps.now?.() ?? new Date()).toISOString(),
        ...(event.fileRef !== undefined ? { fileRef: event.fileRef } : {}),
      };
    } catch (error) {
      if (error instanceof IndexEventError) {
        response.status(400).json({ code: error.code, message: error.message });
        return;
      }
      throw error;
    }

    try {
      await deps.queue.publish(job);
    } catch (error) {
      log("error", "webhook_enqueue_failed", {
        requestId,
        jobId: job.jobId,
        ideaId: job.ideaId,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      response.status(503).json({
        code: "QUEUE_UNAVAILABLE",
        message: "Chưa nhận được event. Vui lòng gửi lại sau.",
      });
      return;
    }

    log("info", "webhook_accepted", {
      requestId,
      jobId: job.jobId,
      ideaId: job.ideaId,
      hasFileRef: job.fileRef !== undefined,
    });
    response.status(202).json({ status: "accepted", jobId: job.jobId });
  };
}

/** Bearer token hoặc header x-api-key. */
function presentedApiKey(request: Request): string | undefined {
  const bearer = /^Bearer\s+(.+)$/i.exec(request.header("authorization") ?? "")?.[1];
  const key = bearer ?? request.header("x-api-key");
  return key && key.trim().length > 0 ? key.trim() : undefined;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** So sánh hằng thời gian qua hash độ dài cố định; luôn duyệt hết các key. */
function matchesAnyKey(presented: string, keyDigests: Buffer[]): boolean {
  const presentedDigest = digest(presented);
  let matched = false;
  for (const keyDigest of keyDigests) {
    if (timingSafeEqual(presentedDigest, keyDigest)) matched = true;
  }
  return matched;
}

function defaultLog(
  level: "info" | "error",
  event: string,
  details: Record<string, unknown>,
) {
  console.log(
    JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details }),
  );
}
