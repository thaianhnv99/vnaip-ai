import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RETRY_POLICY,
  InMemoryJobQueue,
  decideOutcome,
  loadRetryPolicy,
  type JobOutcome,
} from "../job-queue.js";

const policy = { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 35 };
const retryable = Object.assign(new Error("tạm thời"), { code: "UPSTREAM_ERROR", retryable: true });

test("decideOutcome: lỗi retryable thì retry với độ trễ tăng gấp đôi và bị chặn bởi maxDelayMs", () => {
  assert.deepEqual(decideOutcome(retryable, 1, policy), { status: "retry", delayMs: 10, reason: "retryable:UPSTREAM_ERROR" });
  assert.deepEqual(decideOutcome(retryable, 2, policy), { status: "retry", delayMs: 20, reason: "retryable:UPSTREAM_ERROR" });
  assert.equal((decideOutcome(retryable, 3, policy) as { delayMs: number }).delayMs, 35);
});

test("decideOutcome: hết số lần thử thì dead-letter", () => {
  assert.deepEqual(decideOutcome(retryable, 4, policy), { status: "dead", reason: "max_attempts:UPSTREAM_ERROR" });
});

test("decideOutcome: lỗi không retryable hoặc không xác định thì dead-letter ngay", () => {
  const permanent = Object.assign(new Error("x"), { code: "TOO_LARGE", retryable: false });
  assert.deepEqual(decideOutcome(permanent, 1, policy), { status: "dead", reason: "non_retryable:TOO_LARGE" });
  assert.deepEqual(decideOutcome(new Error("lạ"), 1, policy), { status: "dead", reason: "non_retryable:UNKNOWN" });
  assert.deepEqual(decideOutcome("chuỗi", 1, policy), { status: "dead", reason: "non_retryable:UNKNOWN" });
  assert.deepEqual(decideOutcome(null, 1, policy), { status: "dead", reason: "non_retryable:UNKNOWN" });
});

test("loadRetryPolicy dùng mặc định và chỉ nhận số nguyên dương", () => {
  assert.deepEqual(loadRetryPolicy({}), DEFAULT_RETRY_POLICY);
  assert.deepEqual(loadRetryPolicy({ INDEX_MAX_ATTEMPTS: "3", INDEX_RETRY_BASE_MS: "50", INDEX_RETRY_MAX_MS: "500" }), {
    maxAttempts: 3,
    baseDelayMs: 50,
    maxDelayMs: 500,
  });
  assert.deepEqual(loadRetryPolicy({ INDEX_MAX_ATTEMPTS: "0", INDEX_RETRY_BASE_MS: "abc" }), DEFAULT_RETRY_POLICY);
});

test("hàng đợi trong bộ nhớ xử lý tuần tự, từng job một, đúng thứ tự", async () => {
  const queue = new InMemoryJobQueue<number>();
  const order: number[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  await queue.startConsuming(async (job) => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(job);
    concurrent--;
    return { status: "done" };
  });

  await Promise.all([queue.publish(1), queue.publish(2), queue.publish(3)]);
  await queue.drain();

  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(maxConcurrent, 1);
});

test("job được publish trước khi có consumer sẽ được xử lý khi consumer bắt đầu", async () => {
  const queue = new InMemoryJobQueue<string>();
  await queue.publish("sớm");
  const seen: string[] = [];
  await queue.startConsuming(async (job) => {
    seen.push(job);
    return { status: "done" };
  });
  await queue.drain();
  assert.deepEqual(seen, ["sớm"]);
});

test("retry: job được xử lý lại với attempt tăng dần rồi thành công", async () => {
  const queue = new InMemoryJobQueue<string>();
  const attempts: number[] = [];
  await queue.startConsuming(async (_job, { attempt }): Promise<JobOutcome> => {
    attempts.push(attempt);
    return attempt < 3 ? { status: "retry", delayMs: 5, reason: "thử lại" } : { status: "done" };
  });

  await queue.publish("job");
  await queue.drain();

  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(queue.deadLetters.length, 0);
});

test("dead: job vào hàng chờ lỗi kèm lý do và số lần thử", async () => {
  const queue = new InMemoryJobQueue<string>();
  await queue.startConsuming(async () => ({ status: "dead", reason: "non_retryable:X" }));

  await queue.publish("hỏng");
  await queue.drain();

  assert.deepEqual(queue.deadLetters, [{ job: "hỏng", reason: "non_retryable:X", attempt: 1 }]);
});

test("handler ném lỗi thì job vào hàng chờ lỗi, các job sau vẫn chạy", async () => {
  const queue = new InMemoryJobQueue<string>();
  const done: string[] = [];
  await queue.startConsuming(async (job) => {
    if (job === "nổ") throw new Error("bất ngờ");
    done.push(job);
    return { status: "done" };
  });

  await queue.publish("nổ");
  await queue.publish("ổn");
  await queue.drain();

  assert.deepEqual(done, ["ổn"]);
  assert.equal(queue.deadLetters[0]?.reason, "handler_threw");
});

test("stop() huỷ job đang chờ retry và không gọi handler nữa", async () => {
  const queue = new InMemoryJobQueue<string>();
  let calls = 0;
  const consumer = await queue.startConsuming(async () => {
    calls++;
    return { status: "retry", delayMs: 60_000, reason: "chờ lâu" };
  });

  await queue.publish("job");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await consumer.stop();
  await queue.drain(); // không được treo vì timer đã bị huỷ

  assert.equal(calls, 1);
});
