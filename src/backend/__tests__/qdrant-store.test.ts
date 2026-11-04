import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QdrantVectorStore,
  createVectorStoreFromEnv,
  loadQdrantConfig,
  type QdrantConfig,
} from "../qdrant-store.js";
import {
  InMemoryVectorStore,
  VectorStoreError,
  pointId,
  type VectorPoint,
} from "../vector-store.js";
import { startFakeServer, type FakeResponse, type RecordedRequest } from "./helpers/fake-http-server.js";

const API_KEY = "qdrant-test-secret-key";
const DIMS = 3;

function configFor(origin: string, overrides: Partial<QdrantConfig> = {}): QdrantConfig {
  return {
    url: origin,
    apiKey: API_KEY,
    collection: "vnaip_dedup_test",
    dimensions: DIMS,
    timeoutMs: 2000,
    ...overrides,
  };
}

const collectionInfo = (size: number, distance = "Cosine") => ({
  status: 200,
  json: { result: { config: { params: { vectors: { size, distance } } } } },
});

function makePoint(ideaId = "GP-1", chunkIndex = 0): VectorPoint {
  return {
    id: pointId(ideaId, chunkIndex),
    vector: [1, 0, 0],
    payload: {
      ideaId,
      type: "solution",
      title: "Tiêu đề",
      chunkIndex,
      chunkCount: 1,
      content: "Nội dung",
      metadata: { owner: "x" },
      embeddingModel: "openai/text-embedding-3-small",
      indexedAt: "2026-11-04T00:00:00.000Z",
    },
  };
}

const storedPayload = (ideaId = "GP-1", chunkIndex = 0) => makePoint(ideaId, chunkIndex).payload;

test("ensureCollection tạo collection khi chưa có, rồi tạo payload index", async () => {
  let created = false;
  const server = await startFakeServer((request: RecordedRequest): FakeResponse => {
    if (request.method === "GET") return created ? collectionInfo(DIMS) : { status: 404 };
    if (request.method === "PUT" && request.url === "/collections/vnaip_dedup_test") {
      created = true;
    }
    return { status: 200, json: { result: true } };
  });
  try {
    await new QdrantVectorStore(configFor(server.origin)).ensureCollection();

    const create = server.requests.find((request) => request.method === "PUT" && !request.url.includes("/index"));
    assert.deepEqual(create!.body, { vectors: { size: DIMS, distance: "Cosine" } });
    assert.equal(create!.headers["api-key"], API_KEY);

    const indexes = server.requests.filter((request) => request.url.includes("/index"));
    assert.deepEqual(
      indexes.map((request) => request.body),
      [
        { field_name: "ideaId", field_schema: "keyword" },
        // deleteChunksFrom lọc range trên chunkIndex; Qdrant Cloud đòi có index.
        { field_name: "chunkIndex", field_schema: "integer" },
      ],
    );
  } finally {
    await server.close();
  }
});

test("ensureCollection không tạo lại collection đã có đúng cấu hình", async () => {
  const server = await startFakeServer((request) =>
    request.method === "GET" ? collectionInfo(DIMS) : { status: 200, json: { result: true } },
  );
  try {
    await new QdrantVectorStore(configFor(server.origin)).ensureCollection();
    assert.equal(
      server.requests.some((request) => request.method === "PUT" && request.url === "/collections/vnaip_dedup_test"),
      false,
    );
  } finally {
    await server.close();
  }
});

test("ensureCollection báo COLLECTION_MISMATCH khi sai số chiều hoặc sai khoảng cách", async () => {
  for (const info of [collectionInfo(1536), collectionInfo(DIMS, "Dot")]) {
    const server = await startFakeServer(() => info);
    try {
      await assert.rejects(
        () => new QdrantVectorStore(configFor(server.origin)).ensureCollection(),
        (error: unknown) => error instanceof VectorStoreError && error.code === "COLLECTION_MISMATCH",
      );
    } finally {
      await server.close();
    }
  }
});

test("upsertChunks gửi đúng points và chia lô 100", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: { result: { status: "completed" } } }));
  try {
    const store = new QdrantVectorStore(configFor(server.origin));
    const points = Array.from({ length: 250 }, (_, i) => makePoint(`GP-${i}`));
    await store.upsertChunks(points);

    assert.equal(server.requests.length, 3);
    assert.deepEqual(server.requests.map((request) => request.body.points.length), [100, 100, 50]);
    assert.equal(server.requests[0]!.method, "PUT");
    assert.equal(server.requests[0]!.url, "/collections/vnaip_dedup_test/points?wait=true");
    assert.deepEqual(server.requests[0]!.body.points[0], {
      id: points[0]!.id,
      vector: points[0]!.vector,
      payload: points[0]!.payload,
    });
  } finally {
    await server.close();
  }
});

test("upsertChunks từ chối point sai trước khi gọi mạng", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: { result: true } }));
  try {
    const store = new QdrantVectorStore(configFor(server.origin));
    await assert.rejects(
      () => store.upsertChunks([{ ...makePoint(), vector: [1] }]),
      (error: unknown) => error instanceof VectorStoreError && error.code === "INVALID_POINT",
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("scrollAll không gửi filter và phân trang đến hết", async () => {
  const pages = [
    { points: [{ id: "p1", payload: storedPayload("GP-1") }], next_page_offset: "p2" },
    { points: [{ id: "p2", payload: storedPayload("GP-2") }], next_page_offset: null },
  ];
  const server = await startFakeServer((_request, index) => ({ status: 200, json: { result: pages[index] } }));
  try {
    const result = await new QdrantVectorStore(configFor(server.origin)).scrollAll();

    assert.deepEqual(result.points.map((point) => point.payload.ideaId), ["GP-1", "GP-2"]);
    assert.equal(result.truncated, false);
    for (const request of server.requests) {
      assert.equal(request.url, "/collections/vnaip_dedup_test/points/scroll");
      assert.equal("filter" in request.body, false);
      assert.equal(request.body.with_vector, false);
    }
    assert.equal(server.requests[0]!.body.offset, undefined);
    assert.equal(server.requests[1]!.body.offset, "p2");
  } finally {
    await server.close();
  }
});

test("scrollAll báo truncated khi chạm maxPoints mà vẫn còn dữ liệu", async () => {
  const server = await startFakeServer(() => ({
    status: 200,
    json: { result: { points: [{ id: "p1", payload: storedPayload() }], next_page_offset: "p2" } },
  }));
  try {
    const result = await new QdrantVectorStore(configFor(server.origin)).scrollAll({ maxPoints: 1 });
    assert.equal(result.points.length, 1);
    assert.equal(result.truncated, true);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]!.body.limit, 1);
  } finally {
    await server.close();
  }
});

test("scrollAll từ chối point thiếu trường bắt buộc trong payload", async () => {
  const { title: _omitted, ...incomplete } = storedPayload();
  const server = await startFakeServer(() => ({
    status: 200,
    json: { result: { points: [{ id: "p1", payload: incomplete }], next_page_offset: null } },
  }));
  try {
    await assert.rejects(
      () => new QdrantVectorStore(configFor(server.origin)).scrollAll(),
      (error: unknown) => error instanceof VectorStoreError && error.code === "BAD_RESPONSE",
    );
  } finally {
    await server.close();
  }
});

test("scrollAll từ chối trang rỗng nhưng còn offset (tránh lặp vô hạn)", async () => {
  const server = await startFakeServer(() => ({
    status: 200,
    json: { result: { points: [], next_page_offset: "p9" } },
  }));
  try {
    await assert.rejects(
      () => new QdrantVectorStore(configFor(server.origin)).scrollAll(),
      (error: unknown) => error instanceof VectorStoreError && error.code === "BAD_RESPONSE",
    );
  } finally {
    await server.close();
  }
});

test("deleteIdea luôn gửi filter có ideaId (không có đường xoá cả collection)", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: { result: { status: "completed" } } }));
  try {
    const store = new QdrantVectorStore(configFor(server.origin));
    await store.deleteIdea("GP-1");

    assert.equal(server.requests[0]!.url, "/collections/vnaip_dedup_test/points/delete?wait=true");
    assert.deepEqual(server.requests[0]!.body.filter, {
      must: [{ key: "ideaId", match: { value: "GP-1" } }],
    });
    await assert.rejects(
      () => store.deleteIdea(""),
      (error: unknown) => error instanceof VectorStoreError && error.code === "INVALID_POINT",
    );
  } finally {
    await server.close();
  }
});

test("deleteChunksFrom gửi filter có ideaId và chunkIndex >= chỉ số", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: { result: { status: "completed" } } }));
  try {
    const store = new QdrantVectorStore(configFor(server.origin));
    await store.deleteChunksFrom("GP-1", 3);

    assert.equal(server.requests[0]!.url, "/collections/vnaip_dedup_test/points/delete?wait=true");
    assert.deepEqual(server.requests[0]!.body.filter, {
      must: [
        { key: "ideaId", match: { value: "GP-1" } },
        { key: "chunkIndex", range: { gte: 3 } },
      ],
    });
    await assert.rejects(
      () => store.deleteChunksFrom("GP-1", -1),
      (error: unknown) => error instanceof VectorStoreError && error.code === "INVALID_POINT",
    );
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("map lỗi HTTP, timeout, mất kết nối và không lộ API key hay payload", async () => {
  const cases: Array<[number, string, boolean]> = [
    [401, "AUTH_ERROR", false],
    [400, "BAD_REQUEST", false],
    [429, "UPSTREAM_ERROR", true],
    [503, "UPSTREAM_ERROR", true],
  ];
  for (const [status, code, retryable] of cases) {
    const server = await startFakeServer(() => ({
      status,
      json: { status: { error: `echo ${API_KEY} nội dung nhạy cảm` } },
    }));
    try {
      await assert.rejects(
        () => new QdrantVectorStore(configFor(server.origin)).scrollAll(),
        (error: unknown) => {
          assert.ok(error instanceof VectorStoreError);
          assert.equal(error.code, code);
          assert.equal(error.retryable, retryable);
          assert.equal(error.message.includes(API_KEY), false);
          assert.equal(error.message.includes("nhạy cảm"), false);
          return true;
        },
      );
    } finally {
      await server.close();
    }
  }

  const slow = await startFakeServer(() => ({ status: 200, json: { result: {} }, delayMs: 300 }));
  try {
    await assert.rejects(
      () => new QdrantVectorStore(configFor(slow.origin, { timeoutMs: 50 })).scrollAll(),
      (error: unknown) => error instanceof VectorStoreError && error.code === "TIMEOUT" && error.retryable,
    );
  } finally {
    await slow.close();
  }

  const closed = await startFakeServer(() => ({ status: 200 }));
  const deadOrigin = closed.origin;
  await closed.close();
  await assert.rejects(
    () => new QdrantVectorStore(configFor(deadOrigin)).scrollAll(),
    (error: unknown) => error instanceof VectorStoreError && error.code === "NETWORK_ERROR" && error.retryable,
  );
});

test("loadQdrantConfig kiểm tra URL, tên collection và API key", () => {
  const good = { QDRANT_URL: "https://x.cloud.qdrant.io:6333/", QDRANT_API_KEY: "k", QDRANT_COLLECTION: "vnaip_dedup_stg" };
  assert.equal(loadQdrantConfig(good, DIMS).url, "https://x.cloud.qdrant.io:6333");
  assert.equal(loadQdrantConfig({ QDRANT_URL: "http://localhost:6333", QDRANT_COLLECTION: "c" }, DIMS).apiKey, "");

  const bad = [
    {},
    { ...good, QDRANT_COLLECTION: "" },
    { ...good, QDRANT_COLLECTION: "../etc" },
    { ...good, QDRANT_URL: "khong-phai-url" },
    { ...good, QDRANT_URL: "http://qdrant.example.com:6333" },
    { ...good, QDRANT_API_KEY: "" },
  ];
  for (const env of bad) {
    assert.throws(
      () => loadQdrantConfig(env, DIMS),
      (error: unknown) => error instanceof VectorStoreError && error.code === "NOT_CONFIGURED",
    );
  }
});

test("QDRANT_MOCK_MODE=true dùng store trong bộ nhớ; không đặt thì cần cấu hình thật", () => {
  assert.ok(createVectorStoreFromEnv({ QDRANT_MOCK_MODE: "true" }, DIMS) instanceof InMemoryVectorStore);
  assert.throws(
    () => createVectorStoreFromEnv({}, DIMS),
    (error: unknown) => error instanceof VectorStoreError && error.code === "NOT_CONFIGURED",
  );
});
