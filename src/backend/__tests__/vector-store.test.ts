import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryVectorStore,
  VectorStoreError,
  VectorStoreSet,
  createInMemoryVectorStores,
  lazyEnsureCollections,
  pointId,
  type VectorPoint,
  type VectorStore,
} from "../vector-store.js";
import { RECORD_TYPES, type RecordType } from "../record-type.js";

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
      type: "solutions",
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
  const store = new InMemoryVectorStore(DIMS, "solutions");
  await store.upsertChunks([makePoint("GP-1", 0, 1, { content: "cũ" })]);
  await store.upsertChunks([makePoint("GP-1", 0, 1, { content: "mới" })]);

  const { points } = await store.scrollAll();
  assert.equal(points.length, 1);
  assert.equal(points[0]!.payload.content, "mới");
});

test("scrollAll trả mọi idea, sắp theo ideaId rồi chunkIndex và báo truncated khi chạm maxPoints", async () => {
  const store = new InMemoryVectorStore(DIMS, "solutions");
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
  const store = new InMemoryVectorStore(DIMS, "solutions");
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
  const store = new InMemoryVectorStore(DIMS, "solutions");
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
  const store = new InMemoryVectorStore(DIMS, "solutions");
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
  const store = new InMemoryVectorStore(DIMS, "solutions");
  await assert.rejects(() =>
    store.upsertChunks([makePoint("GP-1", 0, 1), { ...makePoint("GP-2", 0, 1), vector: [1] }]),
  );
  assert.equal((await store.scrollAll()).points.length, 0);
});

// --- Tách collection theo type (ideas / solutions / initiatives) ---

const scrollIds = async (store: VectorStore) =>
  (await store.scrollAll()).points.map((point) => `${point.payload.ideaId}#${point.payload.chunkIndex}`);

test("mỗi store chỉ nhận point đúng type của nó; point type khác bị từ chối và không ghi gì", async () => {
  for (const storeType of RECORD_TYPES) {
    const store = new InMemoryVectorStore(DIMS, storeType);
    for (const pointType of RECORD_TYPES.filter((type) => type !== storeType)) {
      await assert.rejects(
        () => store.upsertChunks([makePoint("GP-1", 0, 1, { type: pointType })]),
        (error: unknown) => error instanceof VectorStoreError && error.code === "INVALID_POINT",
        `store ${storeType} phải từ chối point ${pointType}`,
      );
    }
    // Type ngoài danh sách (kể cả giá trị cũ "solution") cũng bị từ chối.
    for (const bogus of ["solution", "idea", "initiative", "", "SOLUTIONS"]) {
      await assert.rejects(
        () => store.upsertChunks([makePoint("GP-1", 0, 1, { type: bogus as RecordType })]),
        (error: unknown) => error instanceof VectorStoreError && error.code === "INVALID_POINT",
      );
    }
    assert.equal((await store.scrollAll()).points.length, 0);
    await store.upsertChunks([makePoint("GP-1", 0, 1, { type: storeType })]);
    assert.deepEqual(await scrollIds(store), ["GP-1#0"]);
  }
});

test("lô có một point sai type thì cả lô bị từ chối, không ghi một phần vào collection", async () => {
  const store = new InMemoryVectorStore(DIMS, "ideas");
  await assert.rejects(() =>
    store.upsertChunks([
      makePoint("GP-1", 0, 1, { type: "ideas" }),
      makePoint("GP-2", 0, 1, { type: "initiatives" }),
    ]),
  );
  assert.equal((await store.scrollAll()).points.length, 0);
});

test("forType trả đúng store của từng type; type lạ bị từ chối INVALID_TYPE (không retry)", () => {
  const stores = createInMemoryVectorStores(DIMS);
  for (const type of RECORD_TYPES) assert.equal(stores.forType(type).recordType, type);
  assert.equal(new Set(RECORD_TYPES.map((type) => stores.forType(type))).size, RECORD_TYPES.length, "ba store phải là ba đối tượng khác nhau");

  for (const bogus of ["solution", "idea", "initiative", "Ideas", " ideas", "", "__proto__", "constructor", "toString"]) {
    assert.throws(
      () => stores.forType(bogus),
      (error: unknown) =>
        error instanceof VectorStoreError && error.code === "INVALID_TYPE" && error.retryable === false,
      `type "${bogus}" phải bị từ chối`,
    );
  }

  // Thông báo liệt kê giá trị hợp lệ nhưng không lặp lại giá trị đã gửi.
  assert.throws(
    () => stores.forType("GIA-TRI-NHAY-CAM"),
    (error: unknown) =>
      error instanceof VectorStoreError &&
      !error.message.includes("GIA-TRI-NHAY-CAM") &&
      /ideas, solutions, initiatives/.test(error.message),
  );
});

test("VectorStoreSet từ chối lắp store gắn nhầm type (sẽ ghi sai collection một cách im lặng)", () => {
  const ideas = new InMemoryVectorStore(DIMS, "ideas");
  const solutions = new InMemoryVectorStore(DIMS, "solutions");
  const initiatives = new InMemoryVectorStore(DIMS, "initiatives");
  assert.doesNotThrow(() => new VectorStoreSet({ ideas, solutions, initiatives }));
  assert.throws(
    () => new VectorStoreSet({ ideas: solutions, solutions, initiatives }),
    (error: unknown) => error instanceof VectorStoreError && error.code === "NOT_CONFIGURED",
  );
});

test("dữ liệu của một type không bao giờ xuất hiện ở collection của type khác, kể cả khi trùng ideaId", async () => {
  const stores = createInMemoryVectorStores(DIMS);
  // Cùng ideaId "X-1" ở cả ba type: ba sáng kiến độc lập, mỗi cái ở collection của nó.
  for (const type of RECORD_TYPES) {
    await stores.forType(type).upsertChunks([makePoint("X-1", 0, 1, { type, content: `nội dung ${type}` })]);
  }
  await stores.forType("ideas").upsertChunks([makePoint("ONLY-IDEAS", 0, 1, { type: "ideas" })]);

  for (const type of RECORD_TYPES) {
    const { points } = await stores.forType(type).scrollAll();
    assert.ok(points.every((point) => point.payload.type === type), `collection ${type} chỉ chứa ${type}`);
    assert.ok(points.some((point) => point.payload.content === `nội dung ${type}`));
  }
  assert.deepEqual(await scrollIds(stores.forType("ideas")), ["ONLY-IDEAS#0", "X-1#0"]);
  assert.deepEqual(await scrollIds(stores.forType("solutions")), ["X-1#0"]);
  assert.deepEqual(await scrollIds(stores.forType("initiatives")), ["X-1#0"]);
});

test("xoá và dọn chunk thừa chỉ tác động collection của type được chọn", async () => {
  const stores = createInMemoryVectorStores(DIMS);
  for (const type of RECORD_TYPES) {
    await stores.forType(type).upsertChunks([
      makePoint("X-1", 0, 3, { type }),
      makePoint("X-1", 1, 3, { type }),
      makePoint("X-1", 2, 3, { type }),
    ]);
  }

  // Dọn chunk thừa ở solutions: ideas và initiatives giữ nguyên cả 3 chunk.
  await stores.forType("solutions").deleteChunksFrom("X-1", 1);
  assert.deepEqual(await scrollIds(stores.forType("solutions")), ["X-1#0"]);
  assert.equal((await stores.forType("ideas").scrollAll()).points.length, 3);
  assert.equal((await stores.forType("initiatives").scrollAll()).points.length, 3);

  // Xoá cả sáng kiến ở ideas: solutions (còn 1 chunk) và initiatives (còn 3) không đổi.
  await stores.forType("ideas").deleteIdea("X-1");
  assert.equal((await stores.forType("ideas").scrollAll()).points.length, 0);
  assert.deepEqual(await scrollIds(stores.forType("solutions")), ["X-1#0"]);
  assert.equal((await stores.forType("initiatives").scrollAll()).points.length, 3);
});

test("lazyEnsureCollections: mỗi type chỉ tạo collection một lần, lỗi thì lần sau thử lại, type lạ bị từ chối", async () => {
  const calls: RecordType[] = [];
  let failNext = true;
  const make = (recordType: RecordType): VectorStore => ({
    ...new InMemoryVectorStore(DIMS, recordType),
    recordType,
    ensureCollection: async () => {
      calls.push(recordType);
      if (recordType === "initiatives" && failNext) {
        failNext = false;
        throw new VectorStoreError("NETWORK_ERROR", "x");
      }
    },
  } as VectorStore);
  const stores = new VectorStoreSet({
    ideas: make("ideas"),
    solutions: make("solutions"),
    initiatives: make("initiatives"),
  });
  const ensure = lazyEnsureCollections(stores);

  await Promise.all([ensure("ideas"), ensure("ideas"), ensure("solutions")]);
  await ensure("ideas");
  assert.deepEqual([...calls].sort(), ["ideas", "solutions"], "mỗi type đúng một lần, không đụng initiatives");

  await assert.rejects(() => ensure("initiatives"), (error: unknown) => error instanceof VectorStoreError);
  await ensure("initiatives"); // thử lại sau lỗi
  assert.equal(calls.filter((type) => type === "initiatives").length, 2);

  assert.throws(
    () => ensure("solution"),
    (error: unknown) => error instanceof VectorStoreError && error.code === "INVALID_TYPE",
  );
});
