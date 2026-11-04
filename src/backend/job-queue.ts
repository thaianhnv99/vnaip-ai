/**
 * Giao diện hàng đợi job và chính sách retry, độc lập với broker.
 *
 * Handler trả về kết quả thay vì ném lỗi: queue chỉ cần biết ack (done), thử
 * lại sau một khoảng (retry) hay đưa vào hàng chờ lỗi (dead). Bản trong bộ
 * nhớ dùng cho dev/test và QUEUE_MOCK_MODE; nó mất job khi tiến trình tắt nên
 * KHÔNG dùng ở môi trường hosted. Bản BullMQ (Redis) cài cùng giao diện này.
 */

export type JobOutcome =
  | { status: "done" }
  | { status: "retry"; delayMs: number; reason: string }
  | { status: "dead"; reason: string };

export interface JobContext {
  /** Lần xử lý hiện tại, bắt đầu từ 1. */
  attempt: number;
}

export type JobHandler<T> = (job: T, context: JobContext) => Promise<JobOutcome>;

export interface JobQueue<T> {
  /** Chỉ resolve khi job đã được lưu bền vững; ném lỗi nếu không nhận được. */
  publish(job: T): Promise<void>;
  /** Xử lý tuần tự, từng job một. Chỉ tiến trình worker gọi hàm này. */
  startConsuming(handler: JobHandler<T>): Promise<{ stop(): Promise<void> }>;
  /**
   * Mở kết nối phía gửi ngay, không chờ kết quả. Tiến trình web gọi lúc khởi
   * động để lỗi kết nối hiện sớm trong log thay vì chờ event đầu tiên.
   */
  warmUp?(): void;
  /** Giải phóng kết nối (nếu có) khi tắt app. */
  close?(): Promise<void>;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 10_000,
  maxDelayMs: 300_000,
};

export function loadRetryPolicy(env: NodeJS.ProcessEnv = process.env): RetryPolicy {
  const positive = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    maxAttempts: positive(env.INDEX_MAX_ATTEMPTS, DEFAULT_RETRY_POLICY.maxAttempts),
    baseDelayMs: positive(env.INDEX_RETRY_BASE_MS, DEFAULT_RETRY_POLICY.baseDelayMs),
    maxDelayMs: positive(env.INDEX_RETRY_MAX_MS, DEFAULT_RETRY_POLICY.maxDelayMs),
  };
}

/**
 * Lỗi có `retryable === true` được thử lại với độ trễ tăng gấp đôi mỗi lần,
 * tới `maxAttempts`; mọi lỗi khác (kể cả lỗi không xác định) vào hàng chờ lỗi.
 */
export function decideOutcome(
  error: unknown,
  attempt: number,
  policy: RetryPolicy,
): JobOutcome {
  const code = (error as { code?: string } | null)?.code ?? "UNKNOWN";
  if ((error as { retryable?: boolean } | null)?.retryable !== true) {
    return { status: "dead", reason: `non_retryable:${code}` };
  }
  if (attempt >= policy.maxAttempts) {
    return { status: "dead", reason: `max_attempts:${code}` };
  }
  const delayMs = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** (attempt - 1),
  );
  return { status: "retry", delayMs, reason: `retryable:${code}` };
}

export interface DeadLetter<T> {
  job: T;
  reason: string;
  attempt: number;
}

export class InMemoryJobQueue<T> implements JobQueue<T> {
  readonly deadLetters: Array<DeadLetter<T>> = [];
  private pending: Array<{ job: T; attempt: number }> = [];
  private handler: JobHandler<T> | undefined;
  private running = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  private idleWaiters: Array<() => void> = [];

  async publish(job: T): Promise<void> {
    this.pending.push({ job, attempt: 1 });
    void this.pump();
  }

  async startConsuming(handler: JobHandler<T>): Promise<{ stop(): Promise<void> }> {
    this.handler = handler;
    void this.pump();
    return {
      stop: async () => {
        this.handler = undefined;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        this.notifyIfIdle();
      },
    };
  }

  /** Chờ tới khi không còn job đang chờ, đang chạy hay đang đợi retry (cho test). */
  async drain(): Promise<void> {
    if (this.isIdle()) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private async pump(): Promise<void> {
    if (this.running || !this.handler) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        // Đọc lại mỗi vòng: stop() có thể đã gỡ handler trong lúc job trước chạy.
        const handler = this.handler;
        if (!handler) break;
        const item = this.pending.shift()!;
        let outcome: JobOutcome;
        try {
          outcome = await handler(item.job, { attempt: item.attempt });
        } catch {
          outcome = { status: "dead", reason: "handler_threw" };
        }
        if (outcome.status === "retry") {
          const timer = setTimeout(() => {
            this.timers.delete(timer);
            this.pending.push({ job: item.job, attempt: item.attempt + 1 });
            void this.pump();
          }, outcome.delayMs);
          this.timers.add(timer);
        } else if (outcome.status === "dead") {
          this.deadLetters.push({
            job: item.job,
            reason: outcome.reason,
            attempt: item.attempt,
          });
        }
      }
    } finally {
      this.running = false;
      this.notifyIfIdle();
    }
  }

  private isIdle(): boolean {
    return !this.running && this.pending.length === 0 && this.timers.size === 0;
  }

  private notifyIfIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
