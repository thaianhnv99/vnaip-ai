import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import type { JobHandler, JobOutcome, JobQueue, RetryPolicy } from "./job-queue.js";
import type { Logger } from "../../shared/logger.js";

/**
 * Hàng đợi job trên BullMQ (Redis), cài giao diện JobQueue.
 *
 * - Hai vai ở hai tiến trình: web chỉ `publish` (producer), worker chỉ
 *   `startConsuming`. Cả hai phải dùng cùng REDIS_URL, prefix và tên queue.
 * - Tuần tự: worker `concurrency = 1`, cộng thêm giới hạn toàn cục = 1 trong
 *   Redis để nhiều tiến trình worker vẫn chỉ chạy một job tại một thời điểm.
 * - Retry do BullMQ giữ (`attempts` + backoff tuỳ chỉnh): handler trả "retry"
 *   thì adapter ném RetryRequested mang độ trễ đúng như handler muốn; trả
 *   "dead" thì ném UnrecoverableError và job vào tập `failed` ngay (đây là
 *   hàng chờ lỗi; lý do nằm ở `failedReason`).
 * - Job chứa nội dung sáng kiến nên cả job hoàn tất lẫn job lỗi đều bị xoá
 *   theo tuổi (xem removeOnComplete/removeOnFail).
 * - Giao hàng ít nhất một lần (job "stalled" khi worker chết được xếp lại):
 *   handler phải idempotent, index job đã vậy.
 *
 * Redis tự host phải đặt maxmemory-policy = noeviction (BullMQ yêu cầu). Không
 * dùng chung instance với Redis cache của BE (cache cần eviction). AOF đang TẮT
 * (quyết định 2026-11-04, bật khi cần): Redis khởi động lại thì job đang chờ bị
 * mất, nên BE phải gửi lại event chưa thấy trong Qdrant (gửi lại an toàn vì
 * index idempotent theo id).
 */

export type BullMqErrorCode = "NOT_CONFIGURED" | "UNAVAILABLE" | "JOB_TOO_LARGE";

export class BullMqError extends Error {
  readonly code: BullMqErrorCode;

  constructor(code: BullMqErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "BullMqError";
  }
}

/** Handler yêu cầu thử lại sau `delayMs`; backoffStrategy đọc giá trị này. */
class RetryRequested extends Error {
  readonly delayMs: number;

  constructor(reason: string, delayMs: number) {
    super(reason);
    this.name = "RetryRequested";
    this.delayMs = delayMs;
  }
}

export interface RedisConnection {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
}

export interface BullMqConfig {
  connection: RedisConnection;
  queueName: string;
  /** Tiền tố khoá trong Redis; mỗi môi trường một tiền tố nếu dùng chung Redis. */
  prefix: string;
  retry: RetryPolicy;
  failedTtlDays: number;
  completedTtlSeconds: number;
  /** Thời gian tối đa chờ Redis xác nhận lưu job. */
  publishTimeoutMs: number;
  maxJobBytes: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
export const DEFAULT_QUEUE_NAME = "idea-index";
export const DEFAULT_QUEUE_PREFIX = "vnaip-dedup";
const JOB_NAME = "index";

export function loadBullMqConfig(
  env: NodeJS.ProcessEnv,
  retry: RetryPolicy,
): BullMqConfig {
  const raw = (env.REDIS_URL ?? "").trim();
  if (!raw) {
    throw new BullMqError(
      "NOT_CONFIGURED",
      "Thiếu REDIS_URL (hoặc đặt QUEUE_MOCK_MODE=true để chạy cục bộ)",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Không đưa giá trị vào lỗi: nó có thể chứa mật khẩu.
    throw new BullMqError("NOT_CONFIGURED", "REDIS_URL không hợp lệ");
  }
  const isLocal = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "rediss:" && !(isLocal && url.protocol === "redis:")) {
    throw new BullMqError(
      "NOT_CONFIGURED",
      "REDIS_URL phải dùng rediss (TLS); chỉ localhost được dùng redis",
    );
  }

  const queueName = env.QUEUE_NAME || DEFAULT_QUEUE_NAME;
  const prefix = env.QUEUE_PREFIX || DEFAULT_QUEUE_PREFIX;
  if (!NAME_PATTERN.test(queueName) || !NAME_PATTERN.test(prefix)) {
    throw new BullMqError(
      "NOT_CONFIGURED",
      "QUEUE_NAME và QUEUE_PREFIX chỉ gồm chữ, số, dấu chấm, gạch ngang và gạch dưới",
    );
  }

  const positive = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  const db = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  if (!Number.isInteger(db) || db < 0) {
    throw new BullMqError("NOT_CONFIGURED", "REDIS_URL có số database không hợp lệ");
  }

  return {
    connection: {
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port ? Number(url.port) : 6379,
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
      db,
      ...(url.protocol === "rediss:" ? { tls: {} } : {}),
    },
    queueName,
    prefix,
    retry,
    failedTtlDays: positive(env.QUEUE_FAILED_TTL_DAYS, 14),
    completedTtlSeconds: positive(env.QUEUE_COMPLETED_TTL_SECONDS, 3600),
    publishTimeoutMs: positive(env.QUEUE_PUBLISH_TIMEOUT_MS, 10_000),
    maxJobBytes: positive(env.QUEUE_MAX_JOB_BYTES, 2_000_000),
  };
}

export class BullMqJobQueue<T> implements JobQueue<T> {
  private readonly config: BullMqConfig;
  private readonly log: Logger;
  private readonly secrets: string[];
  private queue: Queue | undefined;
  private worker: Worker | undefined;

  constructor(config: BullMqConfig, log: Logger) {
    this.config = config;
    this.log = log;
    const { password, username } = config.connection;
    this.secrets = [password, username].filter(
      (secret): secret is string => typeof secret === "string" && secret.length >= 4,
    );
  }

  warmUp(): void {
    this.ensureQueue();
  }

  /** Chỉ resolve khi Redis đã xác nhận lưu job. */
  async publish(job: T): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(job), "utf8") > this.config.maxJobBytes) {
      throw new BullMqError("JOB_TOO_LARGE", "Job vượt kích thước tối đa");
    }
    const queue = this.ensureQueue();
    let timer: NodeJS.Timeout | undefined;
    try {
      // BullMQ chờ vô hạn nếu Redis chưa từng kết nối được, nên cần timeout riêng.
      await Promise.race([
        queue.add(JOB_NAME, job, {
          attempts: this.config.retry.maxAttempts,
          backoff: { type: "custom" },
          removeOnComplete: { age: this.config.completedTtlSeconds },
          removeOnFail: { age: this.config.failedTtlDays * 86_400 },
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new BullMqError("UNAVAILABLE", "Redis không xác nhận job kịp thời")),
            this.config.publishTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof BullMqError) throw error;
      throw new BullMqError("UNAVAILABLE", "Không lưu được job vào Redis", { cause: error });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async startConsuming(handler: JobHandler<T>): Promise<{ stop(): Promise<void> }> {
    if (this.worker) throw new Error("Đã có consumer đang chạy");

    const worker = new Worker(
      this.config.queueName,
      async (job: Job) => {
        const attempt = job.attemptsMade + 1;
        let outcome: JobOutcome;
        try {
          outcome = await handler(job.data as T, { attempt });
        } catch {
          outcome = { status: "dead", reason: "handler_threw" };
        }
        if (outcome.status === "done") return;
        if (outcome.status === "retry") {
          throw new RetryRequested(outcome.reason, Math.max(1, Math.round(outcome.delayMs)));
        }
        throw new UnrecoverableError(outcome.reason);
      },
      {
        connection: { ...this.config.connection, maxRetriesPerRequest: null },
        prefix: this.config.prefix,
        concurrency: 1,
        settings: {
          backoffStrategy: (_attemptsMade, _type, error) =>
            error instanceof RetryRequested ? error.delayMs : this.config.retry.baseDelayMs,
        },
      },
    );
    worker.on("error", (error: Error) => this.logError("bullmq_worker_error", error));
    worker.on("stalled", (jobId: string) =>
      this.log("error", "bullmq_job_stalled", { queue: this.config.queueName, jobId }),
    );
    this.worker = worker;

    // Giới hạn toàn cục trong Redis để nhiều worker không chạy song song. Làm
    // nền và chỉ ghi log nếu lỗi: Redis chưa sẵn sàng thì concurrency = 1 của
    // từng worker vẫn đảm bảo tuần tự khi chỉ có một worker.
    void this.applyGlobalConcurrency();

    return { stop: () => this.stopWorker() };
  }

  async close(): Promise<void> {
    await this.stopWorker();
    const queue = this.queue;
    this.queue = undefined;
    await queue?.close().catch(() => undefined);
  }

  // ------------------------------------------------------------------ nội bộ

  private ensureQueue(): Queue {
    if (!this.queue) {
      const queue = new Queue(this.config.queueName, {
        // enableOfflineQueue = false: mất kết nối giữa chừng thì publish lỗi ngay
        // (để webhook trả 503) thay vì xếp hàng chờ trong bộ nhớ.
        connection: { ...this.config.connection, enableOfflineQueue: false },
        prefix: this.config.prefix,
      });
      queue.on("error", (error: Error) => this.logError("bullmq_queue_error", error));
      this.queue = queue;
    }
    return this.queue;
  }

  private async applyGlobalConcurrency(): Promise<void> {
    try {
      await Promise.race([
        this.ensureQueue().setGlobalConcurrency(1),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("quá thời gian")), 10_000).unref(),
        ),
      ]);
    } catch (error) {
      this.logError("bullmq_global_concurrency_failed", error);
    }
  }

  private async stopWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;

    // Worker chưa từng kết nối được tới Redis: close() mềm treo vô hạn, và gọi
    // close(true) sau đó trả về đúng promise đang treo ấy, nên phải chọn chế độ
    // một lần duy nhất ngay từ đầu.
    const connected = await Promise.race([
      worker.waitUntilReady().then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500).unref()),
    ]);
    if (!connected) {
      await worker.close(true).catch(() => undefined);
      return;
    }

    // Đóng mềm: chờ job đang chạy xong để ack. Quá 20 giây thì bỏ chờ; job dở
    // dang được BullMQ xếp lại (stalled) cho lần chạy sau.
    await Promise.race([
      worker.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 20_000).unref()),
    ]);
  }

  private logError(event: string, error: unknown): void {
    this.log("error", event, {
      queue: this.config.queueName,
      errorName: error instanceof Error ? error.name : "unknown",
      errorCode: (error as { code?: string } | null)?.code ?? "UNKNOWN",
      message: this.redact(error instanceof Error ? error.message : String(error)),
    });
  }

  /** Xoá user/mật khẩu của Redis khỏi mọi chuỗi trước khi ghi log. */
  private redact(text: string): string {
    return this.secrets.reduce((result, secret) => result.split(secret).join("***"), text).slice(0, 300);
  }
}
