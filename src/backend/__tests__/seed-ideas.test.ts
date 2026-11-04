import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseIndexEvent } from '../index-event.js';
import { chunkText } from '../chunker.js';

/**
 * scripts/seed-ideas.json là dữ liệu mẫu cho script seed. Test này giữ cho file luôn
 * hợp lệ theo ĐÚNG luật của webhook (nếu không, seed sẽ hỏng giữa chừng khi chạy thật).
 */
const SEED_FILE = new URL('../../../scripts/seed-ideas.json', import.meta.url);

async function load(): Promise<unknown[]> {
  const raw: unknown = JSON.parse(await readFile(SEED_FILE, 'utf8'));
  assert.ok(Array.isArray(raw));
  return raw;
}

test('mọi sáng kiến mẫu qua được parseIndexEvent (cùng luật với webhook)', async () => {
  for (const item of await load()) parseIndexEvent(item);
});

test('id mẫu bắt đầu bằng SEED-, không trùng nhau, và type là solution', async () => {
  const events = (await load()).map((item) => parseIndexEvent(item));
  const ids = events.map((event) => event.ideaId);

  assert.ok(ids.every((id) => id.startsWith('SEED-')));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(events.every((event) => event.type === 'solution'));
});

test('số lượng nằm dưới trần ứng viên mặc định để nạp xong vẫn kiểm tra trùng được', async () => {
  const count = (await load()).length;
  assert.ok(count >= 5 && count <= 50, `có ${count} sáng kiến mẫu`);
});

test('có ít nhất một sáng kiến nhiều chunk để thử đường gom chunk', async () => {
  const chunkCounts = (await load()).map((item) => chunkText(parseIndexEvent(item).content).length);
  assert.ok(chunkCounts.some((count) => count > 1));
});
