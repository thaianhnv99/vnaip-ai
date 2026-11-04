import { test } from "node:test";
import assert from "node:assert/strict";
import { createQdrantCandidateFinder } from "../candidate-source.js";
import { checkDuplicates, DedupError, type DedupDependencies, type DedupInput } from "../dedup.js";
import { processIndexJob, type IndexJob } from "../index-job.js";
import { createLlmScorer } from "../llm-scorer.js";
import { createMockEmbedder } from "../openrouter-embeddings.js";
import { InMemoryVectorStore } from "../vector-store.js";
import { assertValidDedupOutput } from "../validate-output.js";
import { startFakeServer, type RecordedRequest } from "./helpers/fake-http-server.js";

/**
 * Mốc MVP của kế hoạch: một sáng kiến được duyệt → được index → kiểm tra trùng tìm
 * thấy nó. Ghép các mảnh THẬT (processIndexJob, store, finder, scorer qua HTTP,
 * checkDuplicates, validate output); chỉ embedding là mock và OpenRouter là server giả.
 */

const DIMS = 16;
const options = { candidateLimit: 100, deadlineMs: 5000 };

function job(ideaId: string, title: string, content: string, type = "solution"): IndexJob {
  return {
    jobId: `job-${ideaId}`,
    ideaId,
    type,
    title,
    content,
    metadata: {},
    receivedAt: "2026-11-04T00:00:00.000Z",
  };
}

async function seed(store: InMemoryVectorStore, jobs: IndexJob[], chunkChars = 2000) {
  for (const item of jobs) {
    await processIndexJob(item, {
      embed: createMockEmbedder(DIMS),
      store,
      embeddingModel: "mock-embedding",
      chunkChars,
    });
  }
}

/** OpenRouter giả: chấm cao khi ứng viên chứa từ khoá "sự cố", thấp nếu không. */
function fakeScoring(request: RecordedRequest) {
  const payload = JSON.parse(request.body.messages[1].content) as {
    candidates: Array<{ candidateId: string; title: string; content: string }>;
  };
  const matches = payload.candidates.map((candidate) => ({
    id: candidate.candidateId,
    percent: /sự cố/i.test(`${candidate.title} ${candidate.content}`) ? 88 : 7,
    reason: "Đánh giá giả cho test",
  }));
  return { status: 200, json: { choices: [{ message: { content: JSON.stringify({ matches }) } }] } };
}

function buildDeps(store: InMemoryVectorStore, origin: string): DedupDependencies {
  return {
    findCandidates: createQdrantCandidateFinder(store),
    scoreCandidates: createLlmScorer({
      baseUrl: `${origin}/api/v1`,
      apiKey: "sk-test",
      model: "test/model",
      timeoutMs: 5000,
      batchSize: 10,
      concurrency: 10,
      maxCandidateChars: 4000,
    }),
  };
}

const input: DedupInput = {
  type: "solution",
  title: "Báo cáo sự cố mặt đất bằng điện thoại",
  content: "Nhân viên báo cáo sự cố ngay tại hiện trường.",
};

test("sáng kiến đã index được tìm thấy; output đúng schema; sắp theo điểm giảm dần", async () => {
  const store = new InMemoryVectorStore(DIMS);
  await seed(store, [
    job("GP-1", "Ứng dụng báo cáo sự cố mặt đất", "Báo cáo sự cố mặt đất theo thời gian thực."),
    job("GP-2", "Nền tảng dữ liệu dùng chung", "Lưu trữ và chia sẻ dữ liệu giữa các khối."),
  ]);
  const server = await startFakeServer((request) => fakeScoring(request));
  try {
    const output = await checkDuplicates(input, buildDeps(store, server.origin), options);

    assertValidDedupOutput(output);
    assert.deepEqual(
      output.matches.map((m) => [m.id, m.percent]),
      [
        ["GP-1", 88],
        ["GP-2", 7],
      ],
    );
    assert.equal(output.matches[0]!.score, 0.88);
    assert.equal(output.matches[0]!.type, "solution");
  } finally {
    await server.close();
  }
});

test("excludeIds loại sáng kiến khỏi kết quả và khỏi prompt gửi model", async () => {
  const store = new InMemoryVectorStore(DIMS);
  await seed(store, [
    job("GP-1", "Ứng dụng báo cáo sự cố mặt đất", "Báo cáo sự cố."),
    job("GP-2", "Báo cáo sự cố bằng QR", "Quét QR để báo sự cố."),
  ]);
  const server = await startFakeServer((request) => fakeScoring(request));
  try {
    const output = await checkDuplicates(
      { ...input, excludeIds: ["GP-1"] },
      buildDeps(store, server.origin),
      options,
    );

    assert.deepEqual(output.matches.map((m) => m.id), ["GP-2"]);
    assert.doesNotMatch(JSON.stringify(server.requests.map((r) => r.body)), /GP-1/);
  } finally {
    await server.close();
  }
});

test("sáng kiến nhiều chunk được ghép lại: model nhìn thấy nội dung của chunk cuối", async () => {
  const store = new InMemoryVectorStore(DIMS);
  const paragraphs = Array.from({ length: 5 }, (_, i) => `Đoạn ${i + 1}: ${"chi tiết ".repeat(8).trim()}.`);
  await seed(store, [job("GP-LONG", "Sáng kiến dài", paragraphs.join("\n\n") + "\n\nĐoạn cuối nhắc tới sự cố hiện trường.")], 120);
  assert.ok((await store.scrollAll()).points.length > 1, "phải được chia thành nhiều chunk");
  const server = await startFakeServer((request) => fakeScoring(request));
  try {
    const output = await checkDuplicates(input, buildDeps(store, server.origin), options);

    assert.equal(server.requests.length, 1);
    const sent = JSON.parse(server.requests[0]!.body.messages[1].content).candidates;
    assert.equal(sent.length, 1, "nhiều chunk của một sáng kiến chỉ là MỘT ứng viên");
    assert.match(sent[0].content, /Đoạn cuối nhắc tới sự cố hiện trường/);
    assert.deepEqual(output.matches.map((m) => m.id), ["GP-LONG"]);
  } finally {
    await server.close();
  }
});

test("sáng kiến khác type không được so sánh", async () => {
  const store = new InMemoryVectorStore(DIMS);
  await seed(store, [
    job("YT-1", "Ý tưởng báo cáo sự cố", "Báo cáo sự cố.", "idea"),
    job("GP-1", "Giải pháp báo cáo sự cố", "Báo cáo sự cố.", "solution"),
  ]);
  const server = await startFakeServer((request) => fakeScoring(request));
  try {
    const output = await checkDuplicates(input, buildDeps(store, server.origin), options);
    assert.deepEqual(output.matches.map((m) => m.id), ["GP-1"]);
  } finally {
    await server.close();
  }
});

test("kho rỗng trả matches rỗng và không gọi model", async () => {
  const store = new InMemoryVectorStore(DIMS);
  const server = await startFakeServer((request) => fakeScoring(request));
  try {
    const output = await checkDuplicates(input, buildDeps(store, server.origin), options);
    assert.deepEqual(output.matches, []);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("index lại một sáng kiến (nội dung mới) thì lần kiểm tra sau thấy bản mới, không nhân đôi", async () => {
  const store = new InMemoryVectorStore(DIMS);
  await seed(store, [job("GP-1", "Nền tảng dữ liệu", "Lưu trữ dữ liệu dùng chung.")]);
  await seed(store, [job("GP-1", "Báo cáo sự cố", "Đã đổi hướng sang báo cáo sự cố.")]);
  const server = await startFakeServer((request) => fakeScoring(request));
  try {
    const output = await checkDuplicates(input, buildDeps(store, server.origin), options);

    assert.equal(output.matches.length, 1);
    assert.equal(output.matches[0]!.percent, 88);
  } finally {
    await server.close();
  }
});

test("vượt trần: DedupError CANDIDATE_LIMIT_EXCEEDED và không gọi model", async () => {
  const store = new InMemoryVectorStore(DIMS);
  await seed(store, Array.from({ length: 4 }, (_, i) => job(`GP-${i}`, `Sáng kiến ${i}`, "Nội dung.")));
  const server = await startFakeServer((request) => fakeScoring(request));
  try {
    await assert.rejects(
      () => checkDuplicates(input, buildDeps(store, server.origin), { candidateLimit: 3, deadlineMs: 5000 }),
      (error: unknown) => error instanceof DedupError && error.code === "CANDIDATE_LIMIT_EXCEEDED",
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("model lỗi giữa chừng: SCORING_UNAVAILABLE, không trả kết quả một phần", async () => {
  const store = new InMemoryVectorStore(DIMS);
  await seed(store, Array.from({ length: 25 }, (_, i) => job(`GP-${String(i).padStart(2, "0")}`, `Sáng kiến sự cố ${i}`, "Nội dung.")));
  const server = await startFakeServer((request, index) => (index === 1 ? { status: 500 } : fakeScoring(request)));
  try {
    await assert.rejects(
      () => checkDuplicates(input, buildDeps(store, server.origin), options),
      (error: unknown) => error instanceof DedupError && error.code === "SCORING_UNAVAILABLE",
    );
  } finally {
    await server.close();
  }
});

test("100 sáng kiến (đúng trần mặc định) chấm xong nhanh nhờ chạy song song", async () => {
  const store = new InMemoryVectorStore(DIMS);
  await seed(store, Array.from({ length: 100 }, (_, i) => job(`GP-${String(i).padStart(3, "0")}`, `Sáng kiến ${i}`, i % 2 ? "Có sự cố." : "Không.")));
  // Mỗi lần gọi model mất 200ms: nếu tuần tự thì 10 batch = 2s, song song chỉ ~200ms.
  const server = await startFakeServer((request) => ({ ...fakeScoring(request), delayMs: 200 }));
  try {
    const startedAt = Date.now();
    const output = await checkDuplicates(input, buildDeps(store, server.origin), options);
    const elapsed = Date.now() - startedAt;

    assert.equal(server.requests.length, 10);
    assert.equal(output.matches.length, 30, "cắt theo maxItems của schema");
    assert.ok(elapsed < 1200, `10 batch phải chạy song song, thực tế ${elapsed}ms`);
  } finally {
    await server.close();
  }
});
