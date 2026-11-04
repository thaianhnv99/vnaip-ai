import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createQdrantCandidateFinder,
  groupChunksIntoCandidates,
} from "../candidate-source.js";
import { DedupError, type DedupInput } from "../dedup.js";
import {
  InMemoryVectorStore,
  pointId,
  type IdeaChunkPayload,
  type StoredChunk,
  type VectorPoint,
} from "../vector-store.js";

const DIMENSIONS = 3;
const input: DedupInput = { type: "solution", title: "t", content: "c" };

function payload(overrides: Partial<IdeaChunkPayload> & { ideaId: string }): IdeaChunkPayload {
  return {
    type: "solution",
    title: `Tiêu đề ${overrides.ideaId}`,
    chunkIndex: 0,
    chunkCount: 1,
    content: `Nội dung ${overrides.ideaId}`,
    metadata: {},
    embeddingModel: "test-model",
    indexedAt: "2026-11-04T00:00:00.000Z",
    ...overrides,
  };
}

function point(overrides: Partial<IdeaChunkPayload> & { ideaId: string }): VectorPoint {
  const body = payload(overrides);
  return { id: pointId(body.ideaId, body.chunkIndex), vector: [1, 0, 0], payload: body };
}

function stored(overrides: Partial<IdeaChunkPayload> & { ideaId: string }): StoredChunk {
  const body = payload(overrides);
  return { id: pointId(body.ideaId, body.chunkIndex), payload: body };
}

test("gom các chunk của một sáng kiến theo thứ tự chunkIndex, nối bằng dòng trống", () => {
  const candidates = groupChunksIntoCandidates(
    [
      stored({ ideaId: "a", chunkIndex: 2, chunkCount: 3, content: "ba" }),
      stored({ ideaId: "a", chunkIndex: 0, chunkCount: 3, content: "một" }),
      stored({ ideaId: "a", chunkIndex: 1, chunkCount: 3, content: "hai" }),
    ],
    "solution",
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.id, "a");
  assert.equal(candidates[0]!.content, "một\n\nhai\n\nba");
  assert.equal(candidates[0]!.title, "Tiêu đề a");
  assert.equal(candidates[0]!.type, "solution");
});

test("chỉ lấy sáng kiến cùng type với input; type khác (hoặc type lạ) bị bỏ qua", () => {
  const candidates = groupChunksIntoCandidates(
    [
      stored({ ideaId: "gp-1", type: "solution" }),
      stored({ ideaId: "yt-1", type: "idea" }),
      stored({ ideaId: "x-1", type: "" }),
    ],
    "solution",
  );

  assert.deepEqual(candidates.map((c) => c.id), ["gp-1"]);
});

test("kết quả sắp theo id để chia batch ổn định giữa các lần gọi", () => {
  const candidates = groupChunksIntoCandidates(
    [stored({ ideaId: "c" }), stored({ ideaId: "a" }), stored({ ideaId: "b" })],
    "solution",
  );

  assert.deepEqual(candidates.map((c) => c.id), ["a", "b", "c"]);
});

test("index lại với ít chunk hơn: chunk đuôi cũ chưa kịp xoá bị bỏ, tiêu đề lấy từ lần index mới nhất", () => {
  const candidates = groupChunksIntoCandidates(
    [
      // Lần index cũ: 3 chunk.
      stored({ ideaId: "a", chunkIndex: 0, chunkCount: 3, content: "cũ-0", title: "Tiêu đề cũ", indexedAt: "2026-11-01T00:00:00.000Z" }),
      stored({ ideaId: "a", chunkIndex: 1, chunkCount: 3, content: "cũ-1", title: "Tiêu đề cũ", indexedAt: "2026-11-01T00:00:00.000Z" }),
      stored({ ideaId: "a", chunkIndex: 2, chunkCount: 3, content: "cũ-2", title: "Tiêu đề cũ", indexedAt: "2026-11-01T00:00:00.000Z" }),
      // Lần index mới: 2 chunk, đã ghi đè 0 và 1; chunk 2 cũ còn sót.
      stored({ ideaId: "a", chunkIndex: 0, chunkCount: 2, content: "mới-0", title: "Tiêu đề mới", indexedAt: "2026-11-04T00:00:00.000Z" }),
      stored({ ideaId: "a", chunkIndex: 1, chunkCount: 2, content: "mới-1", title: "Tiêu đề mới", indexedAt: "2026-11-04T00:00:00.000Z" }),
    ],
    "solution",
  );

  assert.equal(candidates[0]!.content, "mới-0\n\nmới-1");
  assert.equal(candidates[0]!.title, "Tiêu đề mới");
});

test("thiếu một chunk giữa chừng thì vẫn giữ sáng kiến (không che mất ứng viên có thể trùng)", () => {
  const candidates = groupChunksIntoCandidates(
    [
      stored({ ideaId: "a", chunkIndex: 0, chunkCount: 3, content: "một" }),
      stored({ ideaId: "a", chunkIndex: 2, chunkCount: 3, content: "ba" }),
    ],
    "solution",
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.content, "một\n\nba");
});

test("finder đọc từ store thật: gom nhiều sáng kiến nhiều chunk", async () => {
  const store = new InMemoryVectorStore(DIMENSIONS);
  await store.upsertChunks([
    point({ ideaId: "a", chunkIndex: 0, chunkCount: 2, content: "a0" }),
    point({ ideaId: "a", chunkIndex: 1, chunkCount: 2, content: "a1" }),
    point({ ideaId: "b", content: "b0" }),
  ]);

  const candidates = await createQdrantCandidateFinder(store)(input);

  assert.deepEqual(
    candidates.map((c) => [c.id, c.content]),
    [
      ["a", "a0\n\na1"],
      ["b", "b0"],
    ],
  );
});

test("kho rỗng trả danh sách rỗng", async () => {
  assert.deepEqual(await createQdrantCandidateFinder(new InMemoryVectorStore(DIMENSIONS))(input), []);
});

test("scroll bị cắt (chạm maxPoints) thì ném CANDIDATE_LIMIT_EXCEEDED, không trả dữ liệu thiếu", async () => {
  const store = new InMemoryVectorStore(DIMENSIONS);
  await store.upsertChunks([point({ ideaId: "a" }), point({ ideaId: "b" }), point({ ideaId: "c" })]);

  await assert.rejects(
    () => createQdrantCandidateFinder(store, { maxPoints: 2 })(input),
    (error: unknown) => {
      assert.ok(error instanceof DedupError);
      assert.equal(error.code, "CANDIDATE_LIMIT_EXCEEDED");
      return true;
    },
  );
});

test("đúng bằng maxPoints (không bị cắt) thì vẫn đọc được", async () => {
  const store = new InMemoryVectorStore(DIMENSIONS);
  await store.upsertChunks([point({ ideaId: "a" }), point({ ideaId: "b" })]);

  const candidates = await createQdrantCandidateFinder(store, { maxPoints: 2 })(input);
  assert.equal(candidates.length, 2);
});

test("ensureReady chạy trước lần đọc; lỗi của nó làm lời gọi lỗi", async () => {
  const store = new InMemoryVectorStore(DIMENSIONS);
  const order: string[] = [];
  const originalScroll = store.scrollAll.bind(store);
  store.scrollAll = async (options) => {
    order.push("scroll");
    return originalScroll(options);
  };

  await createQdrantCandidateFinder(store, {
    ensureReady: async () => {
      order.push("ready");
    },
  })(input);
  assert.deepEqual(order, ["ready", "scroll"]);

  await assert.rejects(
    () =>
      createQdrantCandidateFinder(store, {
        ensureReady: async () => {
          throw new Error("collection lệch cấu hình");
        },
      })(input),
    /collection lệch cấu hình/,
  );
});

test("lỗi của store propagate (không bị nuốt thành danh sách rỗng)", async () => {
  const store = new InMemoryVectorStore(DIMENSIONS);
  store.scrollAll = async () => {
    throw new Error("Qdrant down");
  };

  await assert.rejects(() => createQdrantCandidateFinder(store)(input), /Qdrant down/);
});

test("log số chunk và số sáng kiến, không có nội dung", async () => {
  const store = new InMemoryVectorStore(DIMENSIONS);
  await store.upsertChunks([point({ ideaId: "a", content: "NỘI DUNG BÍ MẬT" })]);
  const logged: Array<[string, Record<string, unknown>]> = [];

  await createQdrantCandidateFinder(store, {
    log: (event, details) => logged.push([event, details]),
  })(input);

  assert.equal(logged[0]![0], "candidates_loaded");
  assert.equal(logged[0]![1].chunks, 1);
  assert.equal(logged[0]![1].ideas, 1);
  assert.doesNotMatch(JSON.stringify(logged), /BÍ MẬT/);
});
