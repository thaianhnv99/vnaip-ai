import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryVectorStore,
  VectorStoreError,
  pointId,
  type VectorPoint,
} from "../vector-store.js";

const DIMS = 3;

function makePoint(
  ideaId: string,
  chunkIndex: number,
  chunkCount = 2,
  overrides: Partial<VectorPoint["payload"]> = {},
): VectorPoint {
  return {
    id: pointId(ideaId, chunkIndex),
    vector: [chunkIndex, 1, 0],
    payload: {
      ideaId,
      type: "solution",
      title: `Tiêu đề ${ideaId}`,
      chunkIndex,
      chunkCount,
      content: `Nội dung ${ideaId} #${chunkIndex}`,
      metadata: {},
      embeddingModel: "openai/text-embedding-3-small",
      indexedAt: "2026-11-04T00:00:00.000Z",
      ...overrides,
    },
  };
}

const label = (point: { payload: { ideaId: string; chunkIndex: number } }) =>
  `${point.payload.ideaId}#${point.payload.chunkIndex}`;

test("pointId là UUID v5 xác định, khác nhau theo idea và chunk", () => {
  const id = pointId("GP-1", 0);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, pointId("GP-1", 0));
  assert.notEqual(id, pointId("GP-2", 0));
  assert.notEqual(id, pointId("GP-1", 1));
  // Không va chạm khi ideaId chứa dấu hai chấm.
  assert.notEqual(pointId("a:1", 2), pointId("a", 12));
});

test("upsert cùng point là idempotent (ghi đè, không nhân đôi)", async () => {
  const store = new InMemoryVectorStore(DIMS);
  await store.upsertChunks([makePoint("GP-1", 0, 1, { content: "cũ" })]);
  await store.upsertChunks([makePoint("GP-1", 0, 1, { content: "mới" })]);

  const { points } = await store.scrollAll();
  assert.equal(points.length, 1);
  assert.equal(points[0]!.payload.content, "mới");
});

test("scrollAll trả mọi idea, sắp theo ideaId rồi chunkIndex và báo truncated khi chạm maxPoints", async () => {
  const store = new InMemoryVectorStore(DIMS);
  await store.upsertChunks([
    makePoint("GP-2", 0, 1),
    makePoint("GP-1", 1, 2),
    makePoint("GP-1", 0, 2),
  ]);

  const all = await store.scrollAll();
  assert.deepEqual(all.points.map(label), ["GP-1#0", "GP-1#1", "GP-2#0"]);
  assert.equal(all.truncated, false);

  const limited = await store.scrollAll({ maxPoints: 2 });
  assert.equal(limited.points.length, 2);
  assert.equal(limited.truncated, true);
});

test("deleteIdea chỉ xoá đúng idea, các idea khác còn nguyên", async () => {
  const store = new InMemoryVectorStore(DIMS);
  await store.upsertChunks([
    makePoint("GP-1", 0, 2),
    makePoint("GP-1", 1, 2),
    makePoint("GP-2", 0, 1),
  ]);

  await store.deleteIdea("GP-1");
  assert.deepEqual((await store.scrollAll()).points.map(label), ["GP-2#0"]);

  await assert.rejects(
    () => store.deleteIdea(""),
    (error: unknown) => error instanceof VectorStoreError && error.code === "INVALID_POINT",
  );
  assert.equal((await store.scrollAll()).points.length, 1);
});

test("deleteChunksFrom chỉ xoá chunk từ chỉ số cho trước của đúng idea", async () => {
  const store = new InMemoryVectorStore(DIMS);
  await store.upsertChunks([
    makePoint("GP-1", 0, 3),
    makePoint("GP-1", 1, 3),
    makePoint("GP-1", 2, 3),
    makePoint("GP-2", 2, 3),
  ]);

  await store.deleteChunksFrom("GP-1", 1);

  assert.deepEqual((await store.scrollAll()).points.map(label), ["GP-1#0", "GP-2#2"]);

  for (const [ideaId, from] of [["", 0], ["GP-1", -1], ["GP-1", 1.5]] as const) {
    await assert.rejects(
      () => store.deleteChunksFrom(ideaId, from),
      (error: unknown) => error instanceof VectorStoreError && error.code === "INVALID_POINT",
    );
  }
});

test("upsert từ chối point sai id, sai số chiều hoặc chunk không hợp lệ", async () => {
  const store = new InMemoryVectorStore(DIMS);
  const good = makePoint("GP-1", 0, 1);
  const bad: VectorPoint[] = [
    { ...good, id: pointId("GP-2", 0) },
    { ...good, vector: [1, 2] },
    { ...good, vector: [1, Number.NaN, 0] },
    makePoint("GP-1", 3, 2),
    makePoint("", 0, 1),
  ];
  for (const point of bad) {
    await assert.rejects(
      () => store.upsertChunks([point]),
      (error: unknown) => error instanceof VectorStoreError && error.code === "INVALID_POINT",
    );
  }
  assert.equal((await store.scrollAll()).points.length, 0);
});

test("một point sai làm cả lô bị từ chối, không ghi một phần", async () => {
  const store = new InMemoryVectorStore(DIMS);
  await assert.rejects(() =>
    store.upsertChunks([makePoint("GP-1", 0, 1), { ...makePoint("GP-2", 0, 1), vector: [1] }]),
  );
  assert.equal((await store.scrollAll()).points.length, 0);
});
