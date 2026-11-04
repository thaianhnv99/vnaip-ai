/**
 * Nạp (hoặc xoá) sáng kiến mẫu vào Qdrant để phát triển và thử luồng kiểm tra
 * trùng mà không phải chờ VNAIP BE gửi webhook thật. Đi qua đúng đường index của
 * worker (`parseIndexEvent` rồi `processIndexJob`), nên dữ liệu giống hệt dữ liệu
 * webhook tạo ra.
 *
 *   npx tsx scripts/seed-ideas.ts --collection vnaip_dedup_dev           # nạp
 *   npx tsx scripts/seed-ideas.ts --collection vnaip_dedup_dev --clean   # xoá
 *
 * Cấu hình đọc từ .env như server: QDRANT_URL, QDRANT_API_KEY, QDRANT_COLLECTION,
 * và OPENROUTER_API_KEY (hoặc EMBEDDING_MOCK_MODE=true: hướng A không dùng vector
 * khi truy vấn nên vector giả đủ để thử luồng kiểm tra trùng).
 *
 * An toàn:
 * - `--collection` bắt buộc và phải TRÙNG `QDRANT_COLLECTION`: chống nạp nhầm vào
 *   collection khác vì quên đổi .env.
 * - Từ chối collection có chữ "prod": dữ liệu mẫu giả sẽ hiện ra như sáng kiến thật
 *   trong kết quả kiểm tra trùng.
 * - Mọi id mẫu bắt đầu bằng `SEED-`; `--clean` chỉ xoá đúng các id trong
 *   scripts/seed-ideas.json, không xoá gì khác.
 * - Từ chối QDRANT_MOCK_MODE=true: kho trong bộ nhớ mất ngay khi script thoát.
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseIndexEvent } from '../src/backend/index-event.js';
import { processIndexJob, type IndexJob } from '../src/backend/index-job.js';
import { createEmbedderFromEnv, loadEmbeddingConfig } from '../src/backend/openrouter-embeddings.js';
import { createVectorStoreFromEnv } from '../src/backend/qdrant-store.js';

const SEED_FILE = fileURLToPath(new URL('./seed-ideas.json', import.meta.url));
const SEED_PREFIX = 'SEED-';

async function loadSeedIdeas(): Promise<IndexJob[]> {
  const raw: unknown = JSON.parse(await readFile(SEED_FILE, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('seed-ideas.json phải là một mảng');

  const seen = new Set<string>();
  return raw.map((item, position) => {
    const event = parseIndexEvent(item); // cùng luật với webhook
    if (!event.ideaId.startsWith(SEED_PREFIX)) {
      throw new Error(`Mục ${position}: id phải bắt đầu bằng "${SEED_PREFIX}"`);
    }
    if (seen.has(event.ideaId)) throw new Error(`Mục ${position}: id bị trùng`);
    seen.add(event.ideaId);
    return {
      jobId: `seed-${event.ideaId}`,
      ideaId: event.ideaId,
      type: event.type,
      title: event.title,
      content: event.content,
      metadata: event.metadata,
      receivedAt: new Date().toISOString(),
    };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const clean = args.includes('--clean');
  const flagAt = args.indexOf('--collection');
  const requested = flagAt >= 0 ? args[flagAt + 1] : undefined;
  const collection = process.env.QDRANT_COLLECTION;

  if (process.env.QDRANT_MOCK_MODE === 'true') {
    fail('QDRANT_MOCK_MODE=true dùng kho trong bộ nhớ, dữ liệu mất ngay khi script thoát. Đặt QDRANT_MOCK_MODE=false (hoặc bỏ) và cấu hình Qdrant thật.');
  }
  if (!requested) {
    fail(`Thiếu --collection <tên>. Ví dụ: npx tsx scripts/seed-ideas.ts --collection ${collection || 'vnaip_dedup_dev'}`);
  }
  if (requested !== collection) {
    fail(`--collection "${requested}" không khớp QDRANT_COLLECTION trong môi trường ("${collection ?? ''}"). Sửa .env hoặc tên truyền vào để chắc chắn nạp đúng nơi.`);
  }
  if (/prod/i.test(requested)) {
    fail(`Từ chối collection "${requested}": dữ liệu mẫu giả không được nạp vào môi trường production.`);
  }

  const ideas = await loadSeedIdeas();
  const embeddingConfig = loadEmbeddingConfig();
  const mockEmbedding = process.env.EMBEDDING_MOCK_MODE === 'true';
  const store = createVectorStoreFromEnv(process.env, embeddingConfig.dimensions);
  await store.ensureCollection();

  if (clean) {
    for (const idea of ideas) await store.deleteIdea(idea.ideaId);
    console.log(`Đã xoá ${ideas.length} sáng kiến mẫu khỏi collection "${requested}".`);
    return;
  }

  const embed = createEmbedderFromEnv();
  let chunks = 0;
  for (const idea of ideas) {
    const result = await processIndexJob(idea, {
      embed,
      store,
      // Gắn nhãn đúng để sau này biết vector nào là giả (cần reindex khi chuyển sang hướng B).
      embeddingModel: mockEmbedding ? 'mock-embedding' : embeddingConfig.model,
    });
    chunks += result.chunks;
    console.log(`  ${idea.ideaId}: ${result.chunks} chunk`);
  }
  console.log(
    `Đã nạp ${ideas.length} sáng kiến mẫu (${chunks} chunk) vào collection "${requested}"` +
      `${mockEmbedding ? ' với vector GIẢ' : ''}. Xoá bằng --clean.`,
  );
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((error) => {
  // Chỉ in tên và mã lỗi: thông báo từ thư viện có thể chứa chi tiết không muốn lộ.
  console.error('Seed thất bại:', error instanceof Error ? error.name : 'unknown', (error as { code?: string })?.code ?? '');
  process.exit(1);
});
