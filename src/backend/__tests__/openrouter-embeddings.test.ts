import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EmbeddingError,
  createEmbedderFromEnv,
  createMockEmbedder,
  createOpenRouterEmbedder,
  loadEmbeddingConfig,
  type EmbeddingConfig,
} from "../openrouter-embeddings.js";
import { startFakeServer } from "./helpers/fake-http-server.js";

const DIMS = 4;
const API_KEY = "sk-or-test-secret-key";

function configFor(origin: string, overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    baseUrl: `${origin}/api/v1`,
    apiKey: API_KEY,
    model: "openai/text-embedding-3-small",
    dimensions: DIMS,
    timeoutMs: 2000,
    batchSize: 64,
    ...overrides,
  };
}

function vectorFor(seed: number): number[] {
  return [seed, seed + 0.5, seed + 1, seed + 1.5];
}

function okBody(count: number, order: number[] = [...Array(count).keys()]) {
  return {
    object: "list",
    model: "openai/text-embedding-3-small",
    data: order.map((index) => ({
      object: "embedding",
      index,
      embedding: vectorFor(index),
    })),
  };
}

test("gửi đúng endpoint, header, model và trả vector theo thứ tự đầu vào", async () => {
  const server = await startFakeServer((request) => ({
    status: 200,
    // Trả đảo thứ tự để chắc chắn client sắp xếp lại theo `index`.
    json: okBody(request.body.input.length, [2, 0, 1]),
  }));
  try {
    const embed = createOpenRouterEmbedder(configFor(server.origin));
    const vectors = await embed(["a", "b", "c"]);

    assert.deepEqual(vectors, [vectorFor(0), vectorFor(1), vectorFor(2)]);
    const [request] = server.requests;
    assert.equal(request!.method, "POST");
    assert.equal(request!.url, "/api/v1/embeddings");
    assert.equal(request!.headers.authorization, `Bearer ${API_KEY}`);
    assert.deepEqual(request!.body, {
      model: "openai/text-embedding-3-small",
      input: ["a", "b", "c"],
      encoding_format: "float",
    });
  } finally {
    await server.close();
  }
});

test("chia batch theo batchSize và ghép kết quả đúng thứ tự", async () => {
  const server = await startFakeServer((request) => ({
    status: 200,
    json: {
      data: request.body.input.map((text: string, index: number) => ({
        index,
        embedding: vectorFor(Number(text)),
      })),
    },
  }));
  try {
    const embed = createOpenRouterEmbedder(configFor(server.origin, { batchSize: 2 }));
    const vectors = await embed(["0", "1", "2", "3", "4"]);

    assert.equal(server.requests.length, 3);
    assert.deepEqual(
      server.requests.map((request) => request.body.input),
      [["0", "1"], ["2", "3"], ["4"]],
    );
    assert.deepEqual(vectors, [0, 1, 2, 3, 4].map(vectorFor));
  } finally {
    await server.close();
  }
});

test("danh sách rỗng không gọi mạng", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: okBody(0) }));
  try {
    const embed = createOpenRouterEmbedder(configFor(server.origin));
    assert.deepEqual(await embed([]), []);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("văn bản rỗng bị từ chối trước khi gọi mạng", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: okBody(1) }));
  try {
    const embed = createOpenRouterEmbedder(configFor(server.origin));
    await assert.rejects(
      () => embed(["ok", "   "]),
      (error: unknown) => error instanceof EmbeddingError && error.code === "INVALID_INPUT",
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("response sai số chiều hoặc sai số lượng bị coi là BAD_RESPONSE", async () => {
  const wrongDimension = await startFakeServer(() => ({
    status: 200,
    json: { data: [{ index: 0, embedding: [1, 2] }] },
  }));
  const wrongCount = await startFakeServer(() => ({ status: 200, json: okBody(1) }));
  try {
    await assert.rejects(
      () => createOpenRouterEmbedder(configFor(wrongDimension.origin))(["a"]),
      (error: unknown) => error instanceof EmbeddingError && error.code === "BAD_RESPONSE",
    );
    await assert.rejects(
      () => createOpenRouterEmbedder(configFor(wrongCount.origin))(["a", "b"]),
      (error: unknown) => error instanceof EmbeddingError && error.code === "BAD_RESPONSE",
    );
  } finally {
    await wrongDimension.close();
    await wrongCount.close();
  }
});

test("map mã HTTP sang mã lỗi và cờ retryable đúng, không lộ API key", async () => {
  const cases: Array<[number, string, boolean]> = [
    [401, "AUTH_ERROR", false],
    [402, "QUOTA_EXCEEDED", false],
    [400, "BAD_REQUEST", false],
    [429, "RATE_LIMITED", true],
    [503, "UPSTREAM_ERROR", true],
  ];
  for (const [status, code, retryable] of cases) {
    const server = await startFakeServer(() => ({
      status,
      json: { error: { message: `echo ${API_KEY} và nội dung nhạy cảm` } },
    }));
    try {
      const embed = createOpenRouterEmbedder(configFor(server.origin));
      await assert.rejects(
        () => embed(["nội dung hồ sơ nhạy cảm"]),
        (error: unknown) => {
          assert.ok(error instanceof EmbeddingError);
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
});

test("quá thời gian trả TIMEOUT và cho phép retry", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: okBody(1), delayMs: 300 }));
  try {
    const embed = createOpenRouterEmbedder(configFor(server.origin, { timeoutMs: 50 }));
    await assert.rejects(
      () => embed(["a"]),
      (error: unknown) =>
        error instanceof EmbeddingError && error.code === "TIMEOUT" && error.retryable,
    );
  } finally {
    await server.close();
  }
});

test("không kết nối được trả NETWORK_ERROR", async () => {
  const server = await startFakeServer(() => ({ status: 200, json: okBody(1) }));
  const origin = server.origin;
  await server.close();
  const embed = createOpenRouterEmbedder(configFor(origin));
  await assert.rejects(
    () => embed(["a"]),
    (error: unknown) =>
      error instanceof EmbeddingError && error.code === "NETWORK_ERROR" && error.retryable,
  );
});

test("thiếu OPENROUTER_API_KEY báo NOT_CONFIGURED; mock chỉ bật khi EMBEDDING_MOCK_MODE=true", () => {
  assert.throws(
    () => createEmbedderFromEnv({}),
    (error: unknown) => error instanceof EmbeddingError && error.code === "NOT_CONFIGURED",
  );
  assert.doesNotThrow(() => createEmbedderFromEnv({ EMBEDDING_MOCK_MODE: "true" }));
});

test("loadEmbeddingConfig dùng mặc định đã chốt ở GĐ0", () => {
  const config = loadEmbeddingConfig({ OPENROUTER_API_KEY: "k" });
  assert.equal(config.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(config.model, "openai/text-embedding-3-small");
  assert.equal(config.dimensions, 1536);
  assert.equal(config.batchSize, 64);
});

test("embedder giả: xác định, chuẩn hoá L2, văn bản giống nhau thì gần nhau hơn", async () => {
  const embed = createMockEmbedder(128);
  const [a1, a2, similar, different] = await embed([
    "ứng dụng báo cáo sự cố mặt đất",
    "ứng dụng báo cáo sự cố mặt đất",
    "ứng dụng báo cáo sự cố mặt đất theo thời gian thực",
    "quy trình tuyển dụng nhân sự mới",
  ]);

  assert.deepEqual(a1, a2);
  assert.equal(a1!.length, 128);
  const norm = Math.sqrt(a1!.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9);

  const dot = (x: number[], y: number[]) => x.reduce((sum, value, i) => sum + value * y[i]!, 0);
  assert.ok(dot(a1!, similar!) > dot(a1!, different!));
});
