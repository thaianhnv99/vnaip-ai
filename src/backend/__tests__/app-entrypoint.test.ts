import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test hợp đồng của ENTRYPOINT THẬT (`src/backend/server.ts`), chạy như một tiến trình con
 * rồi gọi qua HTTP. Mục đích: giữ nguyên bộ route công khai và thứ tự mount khi cấu trúc mã
 * nguồn thay đổi. Chỉ dùng request KHÔNG có token/chữ ký nên không cần Core, Redis, Qdrant
 * hay khoá thật; mọi phụ thuộc chạy ở chế độ mock và `.env` thật không được nạp.
 *
 * Thứ tự mount được kiểm gián tiếp bằng body JSON hỏng:
 * - webhook phải đứng TRƯỚC parser JSON chung (tự đọc raw body cho HMAC), nên bị từ chối
 *   vì thiếu chữ ký (401) chứ không phải vì JSON hỏng (400);
 * - mọi route khác đứng SAU parser JSON chung, và error handler cuối cùng đổi lỗi của
 *   parser thành 400 `BAD_REQUEST`.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TSX_BIN = join(ROOT, 'node_modules', '.bin', 'tsx');
const SERVER_ENTRY = join(ROOT, 'src', 'backend', 'server.ts');

let child: ChildProcess;
let baseUrl: string;
let output = '';

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  child = spawn(TSX_BIN, [SERVER_ENTRY], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Env tối thiểu, KHÔNG kế thừa env của người chạy test: tránh vô tình dùng khoá thật.
    env: {
      PATH: process.env.PATH ?? '',
      PORT: String(port),
      DOTENV_CONFIG_PATH: join(ROOT, '.env.does-not-exist'),
      QUEUE_MOCK_MODE: 'true',
      EMBEDDING_MOCK_MODE: 'true',
      QDRANT_MOCK_MODE: 'true',
      LLM_MOCK_MODE: 'true',
      WEBHOOK_HMAC_SECRETS: 'test-only-secret-0123456789',
      // Không bao giờ được liên lạc: mọi request trong file này đều không có token.
      SOTA_CORE_ORIGIN: 'http://127.0.0.1:9',
    },
  });
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

  await waitFor(() => output.includes('"event":"server_started"'), 20_000, () => `server không khởi động được:\n${output}`);
}, { timeout: 30_000 });

after(async () => {
  if (!child?.pid) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      // đã thoát
    }
  }, 5_000);
  await exited;
  clearTimeout(timer);
});

async function call(
  method: string,
  path: string,
  options: { body?: string; headers?: Record<string, string> } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: options.headers,
    body: options.body,
  });
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, json };
}

const JSON_HEADERS = { 'content-type': 'application/json' };

test('GET /health trả 200 {status, appId} không cần xác thực, kèm x-request-id', async () => {
  const response = await call('GET', '/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { status: 'ok', appId: 'vnaip-dedup' });
  assert.ok(response.headers.get('x-request-id'));
});

test('x-request-id do caller gửi được giữ nguyên trong response', async () => {
  const response = await call('GET', '/health', { headers: { 'x-request-id': 'req-from-caller-1' } });
  assert.equal(response.headers.get('x-request-id'), 'req-from-caller-1');
});

test('không để lộ header x-powered-by', async () => {
  const response = await call('GET', '/health');
  assert.equal(response.headers.get('x-powered-by'), null);
});

for (const [method, path] of [
  ['GET', '/api/hello'],
  ['POST', '/tools/example'],
  ['POST', '/tools/check-duplicates'],
] as const) {
  test(`${method} ${path} không có token: 401 AUTH_ERROR`, async () => {
    const response = await call(method, path, method === 'POST' ? { body: '{}', headers: JSON_HEADERS } : {});
    assert.equal(response.status, 401);
    assert.equal(response.json?.code, 'AUTH_ERROR');
  });
}

test('POST /webhooks/idea-approved không có chữ ký: 401 AUTH_ERROR', async () => {
  const response = await call('POST', '/webhooks/idea-approved', { body: '{}', headers: JSON_HEADERS });
  assert.equal(response.status, 401);
  assert.equal(response.json?.code, 'AUTH_ERROR');
});

test('thứ tự mount: webhook đứng trước parser JSON chung (JSON hỏng vẫn bị từ chối vì thiếu chữ ký, không phải 400)', async () => {
  const response = await call('POST', '/webhooks/idea-approved', { body: '{bad', headers: JSON_HEADERS });
  assert.equal(response.status, 401);
  assert.equal(response.json?.code, 'AUTH_ERROR');
});

test('thứ tự mount: route tool đứng sau parser JSON chung và error handler đổi lỗi parser thành 400 BAD_REQUEST', async () => {
  const response = await call('POST', '/tools/check-duplicates', { body: '{bad', headers: JSON_HEADERS });
  assert.equal(response.status, 400);
  assert.equal(response.json?.code, 'BAD_REQUEST');
});

test('route không tồn tại hoặc sai method: 404', async () => {
  assert.equal((await call('GET', '/khong-ton-tai')).status, 404);
  assert.equal((await call('GET', '/tools/check-duplicates')).status, 404);
  assert.equal((await call('GET', '/webhooks/idea-approved')).status, 404);
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(condition: () => boolean, timeoutMs: number, message: () => string) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message());
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
