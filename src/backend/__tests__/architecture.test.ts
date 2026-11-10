import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Giữ hướng phụ thuộc giữa các thư mục của backend (xem README, mục "Cấu trúc mã nguồn").
 * Chỉ kiểm mã production (bỏ qua `__tests__`): test được phép đi xuyên các lớp để dựng kịch
 * bản tích hợp.
 *
 *   shared        -> shared
 *   platform      -> shared, platform
 *   integrations  -> shared, integrations
 *   indexing      -> shared, integrations, indexing
 *   tools/<tool>  -> shared, platform, integrations, và CHÍNH tool đó (không import tool khác)
 *   tools/index   -> như tool, nhưng được import mọi tool (registry)
 *   scaffold      -> shared, platform, scaffold
 *   file ở gốc    -> mọi lớp (server.ts, worker.ts, app.ts nối mọi thứ lại)
 *
 * Thêm thư mục cấp một mới thì test này fail có chủ đích: hãy khai báo lớp của nó ở LAYERS.
 */

const BACKEND = fileURLToPath(new URL('../', import.meta.url));

const LAYERS: Record<string, (target: string) => boolean> = {
  shared: (t) => t === 'shared',
  platform: (t) => ['shared', 'platform'].includes(t),
  integrations: (t) => ['shared', 'integrations'].includes(t),
  indexing: (t) => ['shared', 'integrations', 'indexing'].includes(t),
  scaffold: (t) => ['shared', 'platform', 'scaffold'].includes(t),
};

function layerOf(file: string): string {
  const parts = path.relative(BACKEND, file).split(path.sep);
  if (parts.length === 1) return 'app';
  if (parts[0] === 'tools') {
    // tools/index.ts là registry; tools/<tool>/... là một tool.
    return parts.length === 2 ? 'tools-registry' : `tool:${parts[1]}`;
  }
  return parts[0]!;
}

function isAllowed(from: string, to: string): boolean {
  if (from === 'app') return true;
  if (from === 'tools-registry') {
    return ['shared', 'platform', 'integrations', 'tools-registry'].includes(to) || to.startsWith('tool:');
  }
  if (from.startsWith('tool:')) {
    return ['shared', 'platform', 'integrations'].includes(to) || to === from;
  }
  const rule = LAYERS[from];
  if (!rule) throw new Error(`Thư mục cấp một chưa khai báo lớp: ${from} (thêm vào LAYERS)`);
  return rule(to);
}

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : productionFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|^import\s+)["'](\.{1,2}\/[^"']+)["']/gm;

test('mã production chỉ import theo đúng hướng phụ thuộc giữa các lớp', () => {
  const files = productionFiles(BACKEND);
  assert.ok(files.length > 20, `chỉ thấy ${files.length} file; walker có thể đang sai`);

  const violations: string[] = [];
  for (const file of files) {
    const from = layerOf(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_SPEC)) {
      const target = path.resolve(path.dirname(file), match[1]!);
      const to = layerOf(target);
      if (!isAllowed(from, to)) {
        violations.push(`${path.relative(BACKEND, file)} (${from}) import ${match[1]} (${to})`);
      }
    }
  }
  assert.deepEqual(violations, [], `vi phạm hướng phụ thuộc:\n  ${violations.join('\n  ')}`);
});

test('mỗi tool trong tools/ được đăng ký ở tools/index.ts', () => {
  const toolDirs = readdirSync(path.join(BACKEND, 'tools'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '__tests__')
    .map((entry) => entry.name);
  assert.ok(toolDirs.length > 0);

  const registry = readFileSync(path.join(BACKEND, 'tools', 'index.ts'), 'utf8');
  for (const name of toolDirs) {
    assert.ok(
      registry.includes(`./${name}/`),
      `tools/${name}/ chưa được import trong tools/index.ts (tool không đăng ký thì không có route)`,
    );
  }
});
