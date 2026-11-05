/**
 * Gọi API /tools/check-duplicates cục bộ, dùng token mint từ
 * scripts/dev-fake-jwks.ts. KHÔNG dùng production.
 *
 * Yêu cầu chạy trước (xem dev-fake-jwks.ts để biết chi tiết 3 terminal):
 *   1. tsx scripts/dev-fake-jwks.ts
 *   2. SOTA_CORE_ORIGIN=http://127.0.0.1:4455 npm run dev
 *
 * Cách dùng:
 *   tsx scripts/dev-call-check-duplicates.ts [path/to/input.json]
 */
const JWKS_ORIGIN = process.env.FAKE_JWKS_ORIGIN ?? 'http://127.0.0.1:4455';
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8787';
const SCOPE = 'tool:check-duplicates';

async function main() {
  const mintResponse = await fetch(`${JWKS_ORIGIN}/mint-token?scope=${encodeURIComponent(SCOPE)}`);
  if (!mintResponse.ok) {
    throw new Error(
      `Không lấy được token từ fake JWKS server (${JWKS_ORIGIN}). ` +
        'Đã chạy "tsx scripts/dev-fake-jwks.ts" chưa?',
    );
  }
  const { token } = (await mintResponse.json()) as { token: string };

  const inputPath = process.argv[2];
  const input = inputPath
    ? JSON.parse(await (await import('node:fs/promises')).readFile(inputPath, 'utf8'))
    : {
        // Một trong: ideas, solutions, initiatives. Chỉ so với sáng kiến cùng type.
        type: 'solutions',
        title: 'Giải pháp quản lý hồ sơ số hóa',
        content: 'Một hệ thống số hóa và quản lý hồ sơ cho đơn vị hành chính.',
      };

  console.log('Input:', JSON.stringify(input, null, 2));
  console.log(`\nGọi POST ${BACKEND_URL}/tools/check-duplicates ...\n`);

  const response = await fetch(`${BACKEND_URL}/tools/check-duplicates`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ body: { input } }),
  });

  const body = await response.json().catch(() => null);
  console.log(`HTTP ${response.status}`);
  console.log(JSON.stringify(body, null, 2));
}

main().catch((error) => {
  console.error('Script thất bại:', error);
  process.exitCode = 1;
});
