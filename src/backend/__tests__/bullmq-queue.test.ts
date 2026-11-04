import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { Queue } from "bullmq";
import {
  BullMqError,
  BullMqJobQueue,
  DEFAULT_QUEUE_NAME,
  DEFAULT_QUEUE_PREFIX,
  loadBullMqConfig,
} from "../bullmq-queue.js";
import { DEFAULT_RETRY_POLICY, type JobOutcome, type RetryPolicy } from "../job-queue.js";

/**
 * Phần đầu không cần Redis. Phần "tích hợp" chạy trên Redis thật và chỉ bật khi
 * đặt REDIS_TEST_URL (cố tình KHÔNG dùng REDIS_URL, để chạy `npm test` với .env
 * thật không vô tình đụng vào Redis thật). Mỗi test dùng tiền tố khoá riêng và
 * xoá sạch khi xong. Test "mất kết nối" tự bật một redis-server tạm nếu có sẵn
 * trên máy.
 */
const TEST_URL = process.env.REDIS_TEST_URL;
const noop = () => undefined;
const SECRET_URL = "rediss://nguoi-dung-bi-mat:mat-khau-bi-mat-123@redis.example.com:6380/2";
const fastPolicy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 1000 };

type Job = { id: string };

// ------------------------------------------------------------ không cần Redis

test("loadBullMqConfig: mặc định, TLS, database và thông tin đăng nhập", () => {
  const config = loadBullMqConfig({ REDIS_URL: SECRET_URL }, DEFAULT_RETRY_POLICY);
  assert.deepEqual(config.connection, {
    host: "redis.example.com",
    port: 6380,
    username: "nguoi-dung-bi-mat",
    password: "mat-khau-bi-mat-123",
    db: 2,
    tls: {},
  });
  assert.equal(config.queueName, DEFAULT_QUEUE_NAME);
  assert.equal(config.prefix, DEFAULT_QUEUE_PREFIX);
  assert.equal(config.failedTtlDays, 14);
  assert.equal(config.retry, DEFAULT_RETRY_POLICY);

  const local = loadBullMqConfig(
    { REDIS_URL: "redis://localhost", QUEUE_NAME: "q.1", QUEUE_PREFIX: "vnaip-dedup-stg", QUEUE_FAILED_TTL_DAYS: "3" },
    DEFAULT_RETRY_POLICY,
  );
  assert.deepEqual(local.connection, { host: "localhost", port: 6379, db: 0 });
  assert.equal(local.prefix, "vnaip-dedup-stg");
  assert.equal(local.failedTtlDays, 3);
});

test("loadBullMqConfig: thiếu, sai giao thức, tên lạ đều bị từ chối và lỗi không lộ mật khẩu", () => {
  const bad: NodeJS.ProcessEnv[] = [
    {},
    { REDIS_URL: "khong-phai-url" },
    { REDIS_URL: "redis://nguoi:mat-khau-bi-mat-123@redis.example.com:6379" },
    { REDIS_URL: "https://nguoi:mat-khau-bi-mat-123@redis.example.com" },
    { REDIS_URL: SECRET_URL.replace("/2", "/abc") },
    { REDIS_URL: SECRET_URL, QUEUE_NAME: "ten co khoang trang" },
    { REDIS_URL: SECRET_URL, QUEUE_PREFIX: "co:dau:hai:cham" },
  ];
  for (const env of bad) {
    assert.throws(
      () => loadBullMqConfig(env, DEFAULT_RETRY_POLICY),
      (error: unknown) =>
        error instanceof BullMqError &&
        error.code === "NOT_CONFIGURED" &&
        !error.message.includes("mat-khau-bi-mat") &&
        !error.message.includes("nguoi"),
    );
  }
});

test("job quá lớn bị từ chối trước khi kết nối tới Redis", async () => {
  const queue = new BullMqJobQueue<{ blob: string }>(
    { ...loadBullMqConfig({ REDIS_URL: "redis://127.0.0.1:1" }, fastPolicy), maxJobBytes: 100 },
    noop,
  );
  await assert.rejects(
    () => queue.publish({ blob: "x".repeat(500) }),
    (error: unknown) => error instanceof BullMqError && error.code === "JOB_TOO_LARGE",
  );
  await queue.close();
});

test("Redis không với tới: publish báo UNAVAILABLE đúng hạn (không treo), startConsuming không ném lỗi, close() thoát sạch, log không lộ mật khẩu", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const queue = new BullMqJobQueue<Job>(
    { ...loadBullMqConfig({ REDIS_URL: "redis://nguoi-dung:mat-khau-bi-mat-123@127.0.0.1:1" }, fastPolicy), publishTimeoutMs: 400 },
    (level, event, details) => logs.push({ level, event, ...details }),
  );

  const consumer = await queue.startConsuming(async () => ({ status: "done" }));
  const startedAt = Date.now();
  await assert.rejects(
    () => queue.publish({ id: "a" }),
    (error: unknown) => error instanceof BullMqError && error.code === "UNAVAILABLE",
  );
  assert.ok(Date.now() - startedAt < 3000, "publish phải thất bại theo publishTimeoutMs");
  await consumer.stop();
  await queue.close();

  assert.equal(JSON.stringify(logs).includes("mat-khau-bi-mat"), false);
  assert.equal(JSON.stringify(logs).includes("nguoi-dung"), false);
});

// ------------------------------------------------------------- tích hợp (Redis thật)

const integration = { skip: TEST_URL ? false : "đặt REDIS_TEST_URL để chạy thử trên Redis thật" };

async function withQueue(
  redisUrl: string,
  policy: RetryPolicy,
  body: (ctx: {
    queue: BullMqJobQueue<Job>;
    inspect: Queue;
    logs: Array<Record<string, unknown>>;
  }) => Promise<void>,
) {
  const prefix = `vnaip-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const logs: Array<Record<string, unknown>> = [];
  const config = loadBullMqConfig({ REDIS_URL: redisUrl, QUEUE_PREFIX: prefix, QUEUE_FAILED_TTL_DAYS: "1" }, policy);
  const queue = new BullMqJobQueue<Job>(config, (level, event, details) => logs.push({ level, event, ...details }));
  const inspect = new Queue(config.queueName, { connection: { ...config.connection }, prefix });
  inspect.on("error", noop);
  try {
    await body({ queue, inspect, logs });
  } finally {
    await queue.close();
    await inspect.obliterate({ force: true }).catch(noop);
    await inspect.close().catch(noop);
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 15_000, what = "điều kiện") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Hết ${timeoutMs} ms chờ ${what}`);
}

test("[redis] publish → consume → done, xử lý tuần tự đúng thứ tự", integration, async () => {
  await withQueue(TEST_URL!, fastPolicy, async ({ queue }) => {
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    await queue.startConsuming(async (job) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push(job.id);
      concurrent--;
      return { status: "done" };
    });

    for (const id of ["1", "2", "3", "4"]) await queue.publish({ id });
    await waitFor(() => order.length === 4, 15_000, "4 job hoàn tất");

    assert.deepEqual(order, ["1", "2", "3", "4"]);
    assert.equal(maxConcurrent, 1);
  });
});

test("[redis] retry: handler trả retry thì job chạy lại sau đúng độ trễ với attempt tăng dần", integration, async () => {
  await withQueue(TEST_URL!, fastPolicy, async ({ queue }) => {
    const attempts: number[] = [];
    const startedAt = Date.now();
    await queue.startConsuming(async (_job, { attempt }): Promise<JobOutcome> => {
      attempts.push(attempt);
      return attempt < 3 ? { status: "retry", delayMs: 250, reason: "thử lại" } : { status: "done" };
    });

    await queue.publish({ id: "retry-me" });
    await waitFor(() => attempts.length === 3, 15_000, "3 lần xử lý");

    assert.deepEqual(attempts, [1, 2, 3]);
    assert.ok(Date.now() - startedAt >= 450, "hai lần retry phải chờ ít nhất 2 x 250 ms");
  });
});

test("[redis] dead: job vào tập failed ngay với lý do, không bị thử lại", integration, async () => {
  await withQueue(TEST_URL!, fastPolicy, async ({ queue, inspect }) => {
    let calls = 0;
    await queue.startConsuming(async () => {
      calls++;
      return { status: "dead", reason: "non_retryable:TEST" };
    });

    await queue.publish({ id: "bad-job" });
    await waitFor(async () => (await inspect.getFailedCount()) === 1, 15_000, "job vào failed");
    await new Promise((resolve) => setTimeout(resolve, 600)); // chắc chắn không có lần thử lại

    const [failed] = await inspect.getFailed();
    assert.equal(calls, 1);
    assert.deepEqual(failed!.data, { id: "bad-job" });
    assert.equal(failed!.failedReason, "non_retryable:TEST");
    assert.equal(failed!.attemptsMade, 1);
  });
});

test("[redis] handler ném lỗi thì vào failed với handler_threw, job sau vẫn được xử lý", integration, async () => {
  await withQueue(TEST_URL!, fastPolicy, async ({ queue, inspect }) => {
    const done: string[] = [];
    await queue.startConsuming(async (job) => {
      if (job.id === "boom") throw new Error("bất ngờ chứa MARKER-SECRET");
      done.push(job.id);
      return { status: "done" };
    });

    await queue.publish({ id: "boom" });
    await queue.publish({ id: "ok" });
    await waitFor(() => done.length === 1, 15_000, "job hợp lệ hoàn tất");

    const [failed] = await inspect.getFailed();
    assert.equal(failed!.failedReason, "handler_threw");
    assert.equal(JSON.stringify(failed).includes("MARKER-SECRET"), false);
  });
});

test("[redis] hết số lần thử (attempts) thì job vào failed, không chạy vô hạn", integration, async () => {
  await withQueue(TEST_URL!, { ...fastPolicy, maxAttempts: 3 }, async ({ queue, inspect }) => {
    let calls = 0;
    await queue.startConsuming(async () => {
      calls++;
      return { status: "retry", delayMs: 50, reason: "luôn thử lại" };
    });

    await queue.publish({ id: "never-ok" });
    await waitFor(async () => (await inspect.getFailedCount()) === 1, 15_000, "job vào failed sau khi hết lượt");
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(calls, 3);
    assert.equal((await inspect.getFailed())[0]!.failedReason, "luôn thử lại");
  });
});

test("[redis] job được xoá theo tuổi: tuỳ chọn removeOnComplete và removeOnFail được đặt", integration, async () => {
  await withQueue(TEST_URL!, fastPolicy, async ({ queue, inspect }) => {
    await queue.publish({ id: "inspect-me" });
    const [job] = await inspect.getWaiting();
    assert.deepEqual(job!.opts.removeOnComplete, { age: 3600 });
    assert.deepEqual(job!.opts.removeOnFail, { age: 86_400 });
    assert.equal(job!.opts.attempts, 3);
  });
});

test("[redis] stop() chờ job đang chạy xong rồi mới dừng; sau đó không nhận job nữa", integration, async () => {
  await withQueue(TEST_URL!, fastPolicy, async ({ queue, inspect }) => {
    let finished = false;
    let started = false;
    const consumer = await queue.startConsuming(async () => {
      started = true;
      await new Promise((resolve) => setTimeout(resolve, 400));
      finished = true;
      return { status: "done" };
    });
    await queue.publish({ id: "slow" });
    await waitFor(() => started, 10_000, "job bắt đầu");

    await consumer.stop();
    assert.equal(finished, true, "stop() phải chờ job đang chạy");

    await queue.publish({ id: "after-stop" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await inspect.getWaitingCount(), 1, "job mới phải nằm chờ vì không còn consumer");
  });
});

// ------------------------------------------------------------- mất kết nối (redis-server tạm)

const hasRedisServer = spawnSync("redis-server", ["--version"], { stdio: "ignore" }).status === 0;

test("[redis-server] Redis chết giữa chừng: publish lỗi nhanh, Redis sống lại thì publish và consumer chạy tiếp", { skip: hasRedisServer ? false : "không có redis-server" }, async () => {
  const port = 6400 + Math.floor(Math.random() * 400);
  const start = () =>
    spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--maxmemory-policy", "noeviction"], { stdio: "ignore" });
  let server = start();
  await new Promise((resolve) => setTimeout(resolve, 800));

  try {
    await withQueue(`redis://127.0.0.1:${port}`, fastPolicy, async ({ queue }) => {
      const done: string[] = [];
      await queue.startConsuming(async (job) => {
        done.push(job.id);
        return { status: "done" };
      });
      await queue.publish({ id: "truoc" });
      await waitFor(() => done.includes("truoc"), 15_000, "job đầu hoàn tất");

      server.kill("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const startedAt = Date.now();
      await assert.rejects(
        () => queue.publish({ id: "khi-chet" }),
        (error: unknown) => error instanceof BullMqError && error.code === "UNAVAILABLE",
      );
      assert.ok(Date.now() - startedAt < 5000, "publish phải lỗi nhanh khi Redis chết");

      server = start();
      let published = false;
      await waitFor(async () => {
        try {
          await queue.publish({ id: "sau" });
          published = true;
        } catch {
          // chưa kết nối lại được, thử tiếp
        }
        return published;
      }, 20_000, "publish thành công sau khi Redis sống lại");
      await waitFor(() => done.includes("sau"), 20_000, "consumer xử lý job sau khi Redis sống lại");
    });
  } finally {
    server.kill("SIGKILL");
  }
});
