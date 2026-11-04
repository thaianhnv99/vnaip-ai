import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { createErrorHandler } from "../error-handler.js";
import { createIndexJobHandler, type IndexJob } from "../index-job.js";
import { InMemoryJobQueue, type JobQueue } from "../job-queue.js";
import { createMockEmbedder } from "../openrouter-embeddings.js";
import { InMemoryVectorStore } from "../vector-store.js";
import {
  WebhookConfigError,
  loadWebhookApiKeys,
  registerWebhookRoutes,
  type WebhookDependencies,
} from "../webhook-routes.js";

const DIMS = 16;
const KEY_1 = "webhook-key-number-one-0001";
const KEY_2 = "webhook-key-number-two-0002";

const validEvent = {
  id: "GP-1",
  type: "solution",
  title: "MARKER-TITLE ứng dụng báo cáo sự cố",
  content: "MARKER-CONTENT nội dung sáng kiến cần được index.",
};

async function setup(overrides: { queue?: JobQueue<IndexJob>; unconfigured?: boolean } = {}) {
  const logs: Array<Record<string, unknown>> = [];
  const log = (level: string, event: string, details: Record<string, unknown>) => {
    logs.push({ level, event, ...details });
  };
  const store = new InMemoryVectorStore(DIMS);
  const queue = new InMemoryJobQueue<IndexJob>();
  await queue.startConsuming(
    createIndexJobHandler(
      { embed: createMockEmbedder(DIMS), store, embeddingModel: "mock", chunkChars: 100 },
      { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 10 },
      log as never,
    ),
  );

  const deps: WebhookDependencies = {
    queue: overrides.queue ?? queue,
    apiKeys: [KEY_1, KEY_2],
    log: log as never,
  };
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerWebhookRoutes(app, overrides.unconfigured ? null : deps);
  app.use(createErrorHandler(log as never));

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("không bind được server");

  const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${KEY_1}` }, raw = false) =>
    fetch(`http://127.0.0.1:${address.port}/webhooks/idea-approved`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: raw ? (body as string) : JSON.stringify(body),
    });

  return {
    store,
    queue,
    logs,
    post,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test("event hợp lệ: 202, job được xử lý và chunk nằm trong store", async () => {
  const t = await setup();
  try {
    const response = await t.post(validEvent);
    const body = (await response.json()) as { status: string; jobId: string };

    assert.equal(response.status, 202);
    assert.equal(body.status, "accepted");
    assert.ok(body.jobId.length > 0);

    await t.queue.drain();
    const { points } = await t.store.scrollAll();
    assert.ok(points.length >= 1);
    assert.ok(points.every((point) => point.payload.ideaId === "GP-1"));
  } finally {
    await t.close();
  }
});

test("chấp nhận cả header x-api-key và key thứ hai khi đang đổi key", async () => {
  const t = await setup();
  try {
    assert.equal((await t.post(validEvent, { "x-api-key": KEY_1 })).status, 202);
    assert.equal((await t.post({ ...validEvent, id: "GP-2" }, { authorization: `Bearer ${KEY_2}` })).status, 202);
  } finally {
    await t.close();
  }
});

test("thiếu hoặc sai API key trả 401, không enqueue và không lộ key", async () => {
  const t = await setup();
  try {
    const missing = await t.post(validEvent, {});
    const wrong = await t.post(validEvent, { authorization: "Bearer sai-key-nhung-du-dai-0000" });

    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(((await wrong.json()) as { code: string }).code, "AUTH_ERROR");

    await t.queue.drain();
    assert.equal((await t.store.scrollAll()).points.length, 0);
    assert.deepEqual(
      t.logs.filter((entry) => entry.event === "webhook_rejected").map((entry) => entry.reason),
      ["missing_key", "invalid_key"],
    );
    assert.equal(JSON.stringify(t.logs).includes("sai-key-nhung-du-dai-0000"), false);
  } finally {
    await t.close();
  }
});

test("event sai định dạng trả 400 và không enqueue", async () => {
  const t = await setup();
  try {
    const noTitle = await t.post({ ...validEvent, title: "" });
    assert.equal(noTitle.status, 400);
    assert.equal(((await noTitle.json()) as { code: string }).code, "INVALID_EVENT");

    const { id: _omitted, ...withoutId } = validEvent;
    assert.equal((await t.post(withoutId)).status, 400);
    assert.equal((await t.post([validEvent])).status, 400);

    await t.queue.drain();
    assert.equal(t.logs.some((entry) => entry.event === "webhook_accepted"), false);
  } finally {
    await t.close();
  }
});

test("JSON hỏng trả 400 và body quá lớn trả 413 (không phải 500)", async () => {
  const t = await setup();
  try {
    const broken = await t.post("{không phải json", undefined, true);
    assert.equal(broken.status, 400);
    assert.equal(((await broken.json()) as { code: string }).code, "BAD_REQUEST");

    const huge = await t.post({ ...validEvent, content: "x".repeat(1_100_000) });
    assert.equal(huge.status, 413);
  } finally {
    await t.close();
  }
});

test("gửi lại cùng event không nhân đôi; datasetKey do BE còn gửi thì bị bỏ qua", async () => {
  const t = await setup();
  try {
    await t.post({ ...validEvent, datasetKey: "workspace-7", content: "Bản của GP-1." });
    await t.post({ ...validEvent, id: "GP-2", content: "Bản của GP-2." });
    await t.queue.drain();
    const before = (await t.store.scrollAll()).points.length;

    await t.post({ ...validEvent, content: "Bản của GP-1." });
    await t.queue.drain();

    const { points } = await t.store.scrollAll();
    assert.equal(points.length, before);
    assert.deepEqual(
      points.map((point) => `${point.payload.ideaId}:${point.payload.content}`),
      ["GP-1:Bản của GP-1.", "GP-2:Bản của GP-2."],
    );
    assert.equal(JSON.stringify(points).includes("workspace-7"), false);
  } finally {
    await t.close();
  }
});

test("queue không nhận được job thì trả 503, không bao giờ trả 202", async () => {
  const failingQueue: JobQueue<IndexJob> = {
    publish: async () => {
      throw new Error("broker mất kết nối chứa MARKER-SECRET");
    },
    startConsuming: async () => ({ stop: async () => undefined }),
  };
  const t = await setup({ queue: failingQueue });
  try {
    const response = await t.post(validEvent);
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { code: string }).code, "QUEUE_UNAVAILABLE");
    assert.equal(JSON.stringify(t.logs).includes("MARKER-SECRET"), false);
  } finally {
    await t.close();
  }
});

test("chưa cấu hình thì trả 503 WEBHOOK_NOT_CONFIGURED kể cả khi có key", async () => {
  const t = await setup({ unconfigured: true });
  try {
    const response = await t.post(validEvent);
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { code: string }).code, "WEBHOOK_NOT_CONFIGURED");
  } finally {
    await t.close();
  }
});

test("fileRef được chấp nhận, mang theo trong job và bỏ qua ở worker (#TODO MinIO); không lộ trong log", async () => {
  const t = await setup();
  try {
    const response = await t.post({ ...validEvent, fileRef: "MARKER-FILEREF/ideas/GP-1.pdf" });
    assert.equal(response.status, 202);
    await t.queue.drain();

    const accepted = t.logs.find((entry) => entry.event === "webhook_accepted");
    assert.equal(accepted?.hasFileRef, true);
    assert.equal(t.logs.find((entry) => entry.event === "index_job_done")?.fileSkipped, true);
    assert.equal(JSON.stringify(t.logs).includes("MARKER-FILEREF"), false);
    // Sáng kiến vẫn được index bằng title + content.
    assert.ok((await t.store.scrollAll()).points.length >= 1);

    assert.equal((await t.post({ ...validEvent, fileRef: 123 })).status, 400);
  } finally {
    await t.close();
  }
});

test("log của luồng webhook và worker không chứa nội dung hay API key", async () => {
  const t = await setup();
  try {
    await t.post(validEvent);
    await t.post({ ...validEvent, title: "" });
    await t.post(validEvent, { authorization: "Bearer sai-key-nhung-du-dai-0000" });
    await t.queue.drain();

    const serialized = JSON.stringify(t.logs);
    for (const secret of ["MARKER-TITLE", "MARKER-CONTENT", KEY_1, KEY_2]) {
      assert.equal(serialized.includes(secret), false, `log lộ ${secret.slice(0, 12)}`);
    }
    assert.ok(t.logs.some((entry) => entry.event === "index_job_done"));
  } finally {
    await t.close();
  }
});

test("loadWebhookApiKeys: tách dấu phẩy, yêu cầu có key và đủ dài", () => {
  assert.deepEqual(loadWebhookApiKeys({ WEBHOOK_API_KEYS: ` ${KEY_1} , ${KEY_2} ,` }), [KEY_1, KEY_2]);
  for (const env of [{}, { WEBHOOK_API_KEYS: "" }, { WEBHOOK_API_KEYS: " , " }, { WEBHOOK_API_KEYS: `${KEY_1},ngan` }]) {
    assert.throws(() => loadWebhookApiKeys(env), WebhookConfigError);
  }
});
