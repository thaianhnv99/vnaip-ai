import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createQdrantCandidateFinder,
  groupChunksIntoCandidates,
} from "../candidate-source.js";
import { DedupError, type DedupInput } from "../dedup.js";
import { RECORD_TYPES, type RecordType } from "../record-type.js";
import {
  VectorStoreError,
  createInMemoryVectorStores,
  pointId,
  type IdeaChunkPayload,
  type StoredChunk,
  type VectorPoint,
  type VectorStoreSet,
} from "../vector-store.js";

const DIMENSIONS = 3;
const input: DedupInput = { type: "solutions", title: "t", content: "c" };

function payload(overrides: Partial<IdeaChunkPayload> & { ideaId: string }): IdeaChunkPayload {
  return {
    type: "solutions",
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

/** Bộ ba kho; `solutions` (type của `input`) là kho được test nạp dữ liệu mặc định. */
function makeStores(): VectorStoreSet {
  return createInMemoryVectorStores(DIMENSIONS);
}

/** Đếm số lần mỗi collection bị đọc (scrollAll) và bị tạo/kiểm (ensureCollection). */
function spyOnStores(stores: VectorStoreSet) {
  const scrolled: RecordType[] = [];
  for (const type of RECORD_TYPES) {
    const store = stores.forType(type);
    const original = store.scrollAll.bind(store);
    store.scrollAll = async (options) => {
      scrolled.push(type);
      return original(options);
    };
  }
  return { scrolled };
}

test("gom các chunk của một sáng kiến theo thứ tự chunkIndex, nối bằng dòng trống", () => {
  const candidates = groupChunksIntoCandidates(
    [
      stored({ ideaId: "a", chunkIndex: 2, chunkCount: 3, content: "ba" }),
      stored({ ideaId: "a", chunkIndex: 0, chunkCount: 3, content: "một" }),
      stored({ ideaId: "a", chunkIndex: 1, chunkCount: 3, content: "hai" }),
    ],
    "solutions",
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.id, "a");
  assert.equal(candidates[0]!.content, "một\n\nhai\n\nba");
  assert.equal(candidates[0]!.title, "Tiêu đề a");
  assert.equal(candidates[0]!.type, "solutions");
});

test("chốt chặn thứ hai: chunk mang type khác (hoặc type cũ/lạ) lọt vào không bao giờ thành ứng viên", () => {
  const candidates = groupChunksIntoCandidates(
    [
      stored({ ideaId: "gp-1", type: "solutions" }),
      stored({ ideaId: "yt-1", type: "ideas" }),
      stored({ ideaId: "sk-1", type: "initiatives" }),
      // Dữ liệu hỏng/cũ: giá trị ngoài danh sách (ví dụ type số ít của bản trước).
      stored({ ideaId: "old-1", type: "solution" as RecordType }),
      stored({ ideaId: "x-1", type: "" as RecordType }),
    ],
    "solutions",
  );

  assert.deepEqual(candidates.map((c) => c.id), ["gp-1"]);
  assert.ok(candidates.every((c) => c.type === "solutions"));
});

test("kết quả sắp theo id để chia batch ổn định giữa các lần gọi", () => {
  const candidates = groupChunksIntoCandidates(
    [stored({ ideaId: "c" }), stored({ ideaId: "a" }), stored({ ideaId: "b" })],
    "solutions",
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
    "solutions",
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
    "solutions",
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.content, "một\n\nba");
});

test("finder đọc từ store thật: gom nhiều sáng kiến nhiều chunk", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([
    point({ ideaId: "a", chunkIndex: 0, chunkCount: 2, content: "a0" }),
    point({ ideaId: "a", chunkIndex: 1, chunkCount: 2, content: "a1" }),
    point({ ideaId: "b", content: "b0" }),
  ]);

  const candidates = await createQdrantCandidateFinder(stores)(input);

  assert.deepEqual(
    candidates.map((c) => [c.id, c.content]),
    [
      ["a", "a0\n\na1"],
      ["b", "b0"],
    ],
  );
});

test("kho rỗng trả danh sách rỗng", async () => {
  assert.deepEqual(await createQdrantCandidateFinder(makeStores())(input), []);
});

// --- Tách collection theo type: luồng check chỉ đọc collection của type được hỏi ---

test("chỉ đọc collection của type được hỏi; hai collection còn lại không bị mở ra", async () => {
  for (const asked of RECORD_TYPES) {
    const stores = makeStores();
    const { scrolled } = spyOnStores(stores);

    await createQdrantCandidateFinder(stores)({ ...input, type: asked });

    assert.deepEqual(scrolled, [asked], `hỏi ${asked} thì chỉ scroll collection ${asked}`);
  }
});

test("ba type chứa CÙNG ideaId và cùng nội dung vẫn không lẫn: mỗi type chỉ thấy bản của mình", async () => {
  const stores = makeStores();
  for (const type of RECORD_TYPES) {
    await stores.forType(type).upsertChunks([
      point({ ideaId: "X-1", type, title: `Tiêu đề ${type}`, content: `Nội dung riêng của ${type}` }),
    ]);
  }
  // Mỗi type có thêm một sáng kiến duy nhất của riêng nó.
  for (const type of RECORD_TYPES) {
    await stores.forType(type).upsertChunks([point({ ideaId: `ONLY-${type}`, type })]);
  }

  for (const asked of RECORD_TYPES) {
    const candidates = await createQdrantCandidateFinder(stores)({ ...input, type: asked });

    assert.deepEqual(candidates.map((c) => c.id), [`ONLY-${asked}`, "X-1"]);
    assert.ok(candidates.every((c) => c.type === asked));
    const shared = candidates.find((c) => c.id === "X-1")!;
    assert.equal(shared.title, `Tiêu đề ${asked}`);
    assert.equal(shared.content, `Nội dung riêng của ${asked}`);
  }
});

test("dữ liệu chỉ có ở collection khác thì type được hỏi thấy kho rỗng (không so chéo)", async () => {
  const stores = makeStores();
  await stores.forType("ideas").upsertChunks([point({ ideaId: "I-1", type: "ideas", content: "Báo cáo sự cố." })]);
  await stores.forType("initiatives").upsertChunks([point({ ideaId: "N-1", type: "initiatives", content: "Báo cáo sự cố." })]);

  const finder = createQdrantCandidateFinder(stores);
  assert.deepEqual(await finder({ ...input, type: "solutions" }), []);
  assert.deepEqual((await finder({ ...input, type: "ideas" })).map((c) => c.id), ["I-1"]);
  assert.deepEqual((await finder({ ...input, type: "initiatives" })).map((c) => c.id), ["N-1"]);
});

test("chunk lạc type nằm trong collection thì bị bỏ qua và để lại dấu vết trong log, không im lặng", async () => {
  const stores = makeStores();
  const solutions = stores.forType("solutions");
  await solutions.upsertChunks([point({ ideaId: "gp-1", content: "NỘI DUNG BÍ MẬT" })]);
  // Giả lập dữ liệu bị ghi lệch (store thật từ chối ghi kiểu này nên phải chèn ở tầng đọc).
  const original = solutions.scrollAll.bind(solutions);
  solutions.scrollAll = async (options) => {
    const result = await original(options);
    return { ...result, points: [...result.points, stored({ ideaId: "lac-1", type: "ideas" })] };
  };
  const logged: Array<[string, Record<string, unknown>]> = [];

  const candidates = await createQdrantCandidateFinder(stores, {
    log: (event, details) => logged.push([event, details]),
  })(input);

  assert.deepEqual(candidates.map((c) => c.id), ["gp-1"]);
  const warning = logged.find(([event]) => event === "candidates_foreign_type_ignored");
  assert.deepEqual(warning?.[1], { type: "solutions", chunks: 1 });
  assert.doesNotMatch(JSON.stringify(logged), /BÍ MẬT|lac-1/);
});

test("type lạ (kể cả \"solution\" cũ) bị từ chối INVALID_TYPE trước khi tạo collection hay đọc bất cứ gì", async () => {
  const stores = makeStores();
  const { scrolled } = spyOnStores(stores);
  let ensured = 0;

  for (const bogus of ["solution", "idea", "other", ""]) {
    await assert.rejects(
      () =>
        createQdrantCandidateFinder(stores, {
          ensureReady: async () => {
            ensured += 1;
          },
        })({ ...input, type: bogus as RecordType }),
      (error: unknown) => error instanceof VectorStoreError && error.code === "INVALID_TYPE",
    );
  }
  assert.equal(ensured, 0);
  assert.deepEqual(scrolled, []);
});

test("scroll bị cắt (chạm maxPoints) thì ném CANDIDATE_LIMIT_EXCEEDED, không trả dữ liệu thiếu", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([point({ ideaId: "a" }), point({ ideaId: "b" }), point({ ideaId: "c" })]);

  await assert.rejects(
    () => createQdrantCandidateFinder(stores, { maxPoints: 2 })(input),
    (error: unknown) => {
      assert.ok(error instanceof DedupError);
      assert.equal(error.code, "CANDIDATE_LIMIT_EXCEEDED");
      return true;
    },
  );
});

test("trần maxPoints chỉ tính trong collection của type được hỏi, không cộng dồn type khác", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([point({ ideaId: "a" }), point({ ideaId: "b" })]);
  // Nhiều dữ liệu ở type khác không được làm solutions chạm trần.
  await stores.forType("ideas").upsertChunks(
    Array.from({ length: 10 }, (_, i) => point({ ideaId: `i-${i}`, type: "ideas" })),
  );

  const candidates = await createQdrantCandidateFinder(stores, { maxPoints: 2 })(input);
  assert.deepEqual(candidates.map((c) => c.id), ["a", "b"]);
});

test("đúng bằng maxPoints (không bị cắt) thì vẫn đọc được", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([point({ ideaId: "a" }), point({ ideaId: "b" })]);

  const candidates = await createQdrantCandidateFinder(stores, { maxPoints: 2 })(input);
  assert.equal(candidates.length, 2);
});

test("ensureReady nhận đúng type và chạy trước lần đọc; lỗi của nó làm lời gọi lỗi", async () => {
  const stores = makeStores();
  const order: string[] = [];
  const solutions = stores.forType("solutions");
  const originalScroll = solutions.scrollAll.bind(solutions);
  solutions.scrollAll = async (options) => {
    order.push("scroll");
    return originalScroll(options);
  };

  await createQdrantCandidateFinder(stores, {
    ensureReady: async (type) => {
      order.push(`ready:${type}`);
    },
  })(input);
  assert.deepEqual(order, ["ready:solutions", "scroll"]);

  await assert.rejects(
    () =>
      createQdrantCandidateFinder(stores, {
        ensureReady: async () => {
          throw new Error("collection lệch cấu hình");
        },
      })(input),
    /collection lệch cấu hình/,
  );
});

test("lỗi của store propagate (không bị nuốt thành danh sách rỗng)", async () => {
  const stores = makeStores();
  stores.forType("solutions").scrollAll = async () => {
    throw new Error("Qdrant down");
  };

  await assert.rejects(() => createQdrantCandidateFinder(stores)(input), /Qdrant down/);
});

test("lỗi đọc ở collection khác không ảnh hưởng type được hỏi", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([point({ ideaId: "a" })]);
  stores.forType("ideas").scrollAll = async () => {
    throw new Error("collection ideas hỏng");
  };

  assert.deepEqual((await createQdrantCandidateFinder(stores)(input)).map((c) => c.id), ["a"]);
});

test("log type, số chunk và số sáng kiến, không có nội dung", async () => {
  const stores = makeStores();
  await stores.forType("solutions").upsertChunks([point({ ideaId: "a", content: "NỘI DUNG BÍ MẬT" })]);
  const logged: Array<[string, Record<string, unknown>]> = [];

  await createQdrantCandidateFinder(stores, {
    log: (event, details) => logged.push([event, details]),
  })(input);

  assert.equal(logged[0]![0], "candidates_loaded");
  assert.equal(logged[0]![1].type, "solutions");
  assert.equal(logged[0]![1].chunks, 1);
  assert.equal(logged[0]![1].ideas, 1);
  assert.doesNotMatch(JSON.stringify(logged), /BÍ MẬT/);
});
