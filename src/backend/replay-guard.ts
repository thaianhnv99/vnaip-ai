import { Redis } from "ioredis";
import type { RedisConnection } from "./bullmq-queue.js";

/**
 * Chống replay cho webhook: mỗi chữ ký hợp lệ chỉ được nhận MỘT lần trong cửa
 * sổ hiệu lực của timestamp. Dung sai timestamp một mình không đủ, vì request bị
 * chặn lại trong log/proxy vẫn gửi lại được nhiều lần trong 5 phút, và gửi lại
 * bản cũ sau bản mới sẽ ghi đè nội dung đã index bằng bản lỗi thời.
 *
 * Giới hạn: guard chỉ thấy request đã tới server. Request bị chặn trước khi tới
 * server rồi mới replay thì là lần đầu server thấy; muốn chặn trường hợp đó cần
 * thứ tự/version đơn điệu trong event do VNAIP BE gửi (chưa có trong hợp đồng).
 */
export interface ReplayGuard {
  /**
   * true nếu `key` chưa được thấy trong `ttlSeconds` gần đây và đã được giữ chỗ;
   * false nếu đã thấy. Phải nguyên tử: hai request đồng thời cùng key chỉ một
   * request nhận true.
   */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  /** Trả chỗ khi request không được xử lý (vd. enqueue lỗi) để gửi lại đúng request đó. */
  release(key: string): Promise<void>;
  /** Giải phóng kết nối (nếu có) khi tắt app. */
  close?(): Promise<void>;
}

/** Dùng cho QUEUE_MOCK_MODE và test: chỉ đúng trong một tiến trình. */
export class InMemoryReplayGuard implements ReplayGuard {
  private readonly expiresAt = new Map<string, number>();

  constructor(private readonly nowMs: () => number = Date.now) {}

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const now = this.nowMs();
    for (const [seenKey, expiry] of this.expiresAt) {
      if (expiry <= now) this.expiresAt.delete(seenKey);
    }
    if (this.expiresAt.has(key)) return false;
    this.expiresAt.set(key, now + ttlSeconds * 1000);
    return true;
  }

  async release(key: string): Promise<void> {
    this.expiresAt.delete(key);
  }
}

/** Phần của ioredis mà guard dùng; tách ra để test không cần Redis thật. */
export interface ReplayRedisClient {
  readonly status: string;
  set(
    key: string,
    value: string,
    expireToken: "EX",
    seconds: number,
    nx: "NX",
  ): Promise<"OK" | null>;
  del(key: string): Promise<number>;
  quit(): Promise<unknown>;
  disconnect(): void;
}

/** Guard dùng chung giữa nhiều instance web: `SET key 1 EX ttl NX` là nguyên tử. */
export class RedisReplayGuard implements ReplayGuard {
  constructor(
    private readonly redis: ReplayRedisClient,
    private readonly keyPrefix: string,
  ) {}

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(this.keyPrefix + key, "1", "EX", ttlSeconds, "NX");
    return result === "OK";
  }

  async release(key: string): Promise<void> {
    await this.redis.del(this.keyPrefix + key);
  }

  async close(): Promise<void> {
    // quit() trên kết nối chưa sẵn sàng sẽ treo, nên chỉ đóng mềm khi đã ready.
    if (this.redis.status === "ready") {
      await Promise.race([
        this.redis.quit().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1_500).unref()),
      ]);
    }
    this.redis.disconnect();
  }
}

type GuardLogger = (
  level: "info" | "error",
  event: string,
  details: Record<string, unknown>,
) => void;

/**
 * Lệnh lỗi sau tối đa vài giây thay vì chờ vô hạn: guard hỏng thì webhook trả 503
 * (bên gửi sẽ gửi lại) chứ không bao giờ bỏ qua kiểm tra replay.
 */
export function createRedisReplayGuard(
  connection: RedisConnection,
  keyPrefix: string,
  log: GuardLogger,
): RedisReplayGuard {
  const redis = new Redis({
    ...connection,
    commandTimeout: 3_000,
    maxRetriesPerRequest: 1,
  });
  // Chỉ ghi tên/mã lỗi: message của ioredis có thể kèm địa chỉ hay thông tin đăng nhập.
  redis.on("error", (error: Error & { code?: string }) =>
    log("error", "replay_guard_redis_error", {
      errorName: error.name,
      errorCode: error.code ?? "UNKNOWN",
    }),
  );
  return new RedisReplayGuard(redis as unknown as ReplayRedisClient, keyPrefix);
}
