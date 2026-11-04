import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IndexJobError,
  createIndexJobHandler,
  processIndexJob,
  type IndexDependencies,
  type IndexJob,
} from "../index-job.js";
import { EmbeddingError, createMockEmbedder, type Embedder } from "../openrouter-embeddings.js";
import { InMemoryVectorStore, pointId } from "../vector-store.js";

const DIMS = 16;
const policy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 };

const paragraphs = Array.from({ length: 4 }, (_, i) => `Đoạn ${i + 1}: ${"nội dung ".repeat(10).trim()}.`);
const LONG = paragraphs.join("\n\n");

function makeJob(overrides: Partial<IndexJob> = {}): IndexJob {
  return {
    jobId: "job-1",
    ideaId: "GP-1",
    type: "solution",
    title: "Tiêu đề sáng kiến",
    content: LONG,
    metadata: { owner: "x" },
    receivedAt: "2026-11-04T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<IndexDependencies> = {}) {
  const store = new InMemoryVectorStore(DIMS);
  const deps: IndexDependencies = {
    embed: createMockEmbedder(DIMS),
    store,
    embeddingModel: "mock-embedding",
    chunkChars: 100,
    now: () => new Date("2026-11-04T01:00:00.000Z"),
    ...overrides,
  };
  return { store, deps };
}

test("index một sáng kiến: ghi đủ chunk với payload đúng và point ID xác định", async () => {
  const { store, deps } = makeDeps();
  const { chunks } = await processIndexJob(makeJob(), deps);

  const { points } = await store.scrollAll();
  assert.ok(chunks > 1);
  assert.equal(points.length, chunks);
  points.forEach((point, index) => {
    assert.equal(point.id, pointId("GP-1", index));
    assert.equal(point.payload.chunkIndex, index);
    assert.equal(point.payload.chunkCount, chunks);
    assert.equal(point.payload.ideaId, "GP-1");
    assert.equal(point.payload.type, "solution");
    assert.equal(point.payload.title, "Tiêu đề sáng kiến");
    assert.equal(point.payload.embeddingModel, "mock-embedding");
    assert.equal(point.payload.indexedAt, "2026-11-04T01:00:00.000Z");
    assert.deepEqual(point.payload.metadata, { owner: "x" });
  });
  assert.equal(points.map((point) => point.payload.content).join("\n\n"), LONG);
});

test("mỗi đầu vào embedding đều bắt đầu bằng tiêu đề", async () => {
  const seen: string[] = [];
  const embed: Embedder = async (texts) => {
    seen.push(...texts);
    return createMockEmbedder(DIMS)(texts);
  };
  const { deps } = makeDeps({ embed });
  await processIndexJob(makeJob(), deps);

  assert.ok(seen.length > 1);
  assert.ok(seen.every((text) => text.startsWith("Tiêu đề sáng kiến\n\n")));
});

test("index lại là idempotent và index lại với ít chunk hơn thì dọn chunk thừa", async () => {
  const { store, deps } = makeDeps();
  const first = await processIndexJob(makeJob(), deps);
  await processIndexJob(makeJob(), deps);
  assert.equal((await store.scrollAll()).points.length, first.chunks);

  const second = await processIndexJob(makeJob({ content: "Chỉ còn một đoạn ngắn." }), deps);
  const { points } = await store.scrollAll();
  assert.equal(second.chunks, 1);
  assert.equal(points.length, 1);
  assert.equal(points[0]!.payload.content, "Chỉ còn một đoạn ngắn.");
});

test("hai sáng kiến khác id không ghi đè hay xoá chunk của nhau", async () => {
  const { store, deps } = makeDeps();
  await processIndexJob(makeJob(), deps);
  await processIndexJob(makeJob({ ideaId: "GP-2", content: "Bản của GP-2." }), deps);
  await processIndexJob(makeJob({ content: "Bản mới của GP-1." }), deps);

  const { points } = await store.scrollAll();
  assert.deepEqual(
    points.map((point) => `${point.payload.ideaId}:${point.payload.content}`),
    ["GP-1:Bản mới của GP-1.", "GP-2:Bản của GP-2."],
  );
});

test("embedding lỗi thì dữ liệu cũ của sáng kiến vẫn còn nguyên", async () => {
  const { store, deps } = makeDeps();
  await processIndexJob(makeJob({ content: "Bản cũ." }), deps);

  const failing: Embedder = async () => {
    throw new EmbeddingError("RATE_LIMITED", "giới hạn");
  };
  await assert.rejects(
    () => processIndexJob(makeJob({ content: "Bản mới." }), { ...deps, embed: failing }),
    (error: unknown) => error instanceof EmbeddingError && error.retryable,
  );

  const { points } = await store.scrollAll();
  assert.deepEqual(points.map((point) => point.payload.content), ["Bản cũ."]);
});

test("sáng kiến quá dài bị từ chối không retry và không ghi gì", async () => {
  const { store, deps } = makeDeps({ maxChunks: 2 });
  await assert.rejects(
    () => processIndexJob(makeJob(), deps),
    (error: unknown) => error instanceof IndexJobError && error.retryable === false,
  );
  assert.equal((await store.scrollAll()).points.length, 0);
});

test("ensureReady chạy trước embedding; lỗi của nó làm job thất bại", async () => {
  const order: string[] = [];
  const embed: Embedder = async (texts) => {
    order.push("embed");
    return createMockEmbedder(DIMS)(texts);
  };
  const { deps } = makeDeps({
    embed,
    ensureReady: async () => {
      order.push("ready");
    },
  });
  await processIndexJob(makeJob(), deps);
  assert.deepEqual(order, ["ready", "embed"]);

  const { deps: broken } = makeDeps({
    ensureReady: async () => {
      throw new EmbeddingError("NETWORK_ERROR", "x");
    },
  });
  await assert.rejects(() => processIndexJob(makeJob(), broken));
});

test("handler: thành công trả done và log không chứa nội dung hay fileRef", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const { deps } = makeDeps();
  const handler = createIndexJobHandler(deps, policy, (level, event, details) => {
    logs.push({ level, event, ...details });
  });

  const outcome = await handler(makeJob({ fileRef: "MARKER-FILEREF/GP-1.pdf" }), { attempt: 1 });

  assert.deepEqual(outcome, { status: "done" });
  assert.equal(logs[0]!.event, "index_job_done");
  assert.equal(logs[0]!.jobId, "job-1");
  assert.equal(logs[0]!.ideaId, "GP-1");
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes("Tiêu đề sáng kiến"), false);
  assert.equal(serialized.includes("Đoạn 1"), false);
  assert.equal(serialized.includes("MARKER-FILEREF"), false);
  assert.equal(logs[0]!.fileSkipped, true);
});

test("handler: lỗi retryable thì retry, hết số lần hoặc không retryable thì dead", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const failing: Embedder = async () => {
    throw new EmbeddingError("UPSTREAM_ERROR", "máy chủ lỗi");
  };
  const { deps } = makeDeps({ embed: failing });
  const handler = createIndexJobHandler(deps, policy, (level, event, details) => {
    logs.push({ level, event, ...details });
  });

  assert.deepEqual(await handler(makeJob(), { attempt: 1 }), {
    status: "retry",
    delayMs: 10,
    reason: "retryable:UPSTREAM_ERROR",
  });
  assert.deepEqual(await handler(makeJob(), { attempt: 3 }), {
    status: "dead",
    reason: "max_attempts:UPSTREAM_ERROR",
  });

  const { deps: tooLarge } = makeDeps({ maxChunks: 1 });
  const tooLargeHandler = createIndexJobHandler(tooLarge, policy, () => undefined);
  assert.deepEqual(await tooLargeHandler(makeJob(), { attempt: 1 }), {
    status: "dead",
    reason: "non_retryable:TOO_LARGE",
  });

  assert.equal(logs.every((entry) => entry.event === "index_job_failed"), true);
  assert.equal(JSON.stringify(logs).includes("Tiêu đề sáng kiến"), false);
});
