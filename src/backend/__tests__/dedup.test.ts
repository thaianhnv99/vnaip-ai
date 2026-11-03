import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDuplicates,
  DedupError,
  type Candidate,
  type DedupDependencies,
  type RawModelMatch,
} from '../dedup.js';

const context = { organizationId: 'org-1', workspaceId: 'ws-1' };
const options = { candidateLimit: 30 };

const validInput = {
  type: 'solution' as const,
  title: 'Giải pháp quản lý hồ sơ',
  content: 'Nội dung mô tả giải pháp quản lý hồ sơ số hóa.',
};

function candidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return { id, type: 'solution', title: `Candidate ${id}`, content: `Nội dung của ${id}`, ...overrides };
}

function deps(overrides: Partial<DedupDependencies>): DedupDependencies {
  return {
    findCandidates: async () => [],
    scoreCandidates: async () => [],
    ...overrides,
  };
}

test('input hợp lệ với candidate và percent hợp lệ trả về matches đã sort giảm dần, score suy ra từ percent', async () => {
  const candidates = [candidate('a'), candidate('b')];
  const matches: RawModelMatch[] = [
    { id: 'a', percent: 40, reason: 'thấp' },
    { id: 'b', percent: 90, reason: 'cao' },
  ];

  const output = await checkDuplicates(
    validInput,
    context,
    deps({
      findCandidates: async () => candidates,
      scoreCandidates: async () => matches,
    }),
    options,
  );

  assert.deepEqual(output.matches.map((m) => m.id), ['b', 'a']);
  assert.equal(output.matches[0].percent, 90);
  assert.equal(output.matches[0].score, 0.9);
  assert.equal(output.matches[1].percent, 40);
  assert.equal(output.matches[1].score, 0.4);
});

test('input thiếu title bị từ chối với DedupError INVALID_INPUT', async () => {
  await assert.rejects(
    () =>
      checkDuplicates(
        { ...validInput, title: '  ' },
        context,
        deps({}),
        options,
      ),
    (error: unknown) => {
      assert.ok(error instanceof DedupError);
      assert.equal(error.code, 'INVALID_INPUT');
      return true;
    },
  );
});

test('input thiếu content bị từ chối', async () => {
  await assert.rejects(() =>
    checkDuplicates({ ...validInput, content: '' }, context, deps({}), options),
  );
});

test('không có ứng viên trả về matches rỗng (không phải lỗi)', async () => {
  const output = await checkDuplicates(
    validInput,
    context,
    deps({ findCandidates: async () => [] }),
    options,
  );
  assert.deepEqual(output.matches, []);
});

test('VNAIP BE lỗi khi lấy ứng viên: propagate CANDIDATES_UNAVAILABLE, KHÔNG trả matches rỗng im lặng', async () => {
  await assert.rejects(
    () =>
      checkDuplicates(
        validInput,
        context,
        deps({
          findCandidates: async () => {
            throw new Error('network down');
          },
        }),
        options,
      ),
    (error: unknown) => {
      assert.ok(error instanceof DedupError);
      assert.equal(error.code, 'CANDIDATES_UNAVAILABLE');
      return true;
    },
  );
});

test('model lỗi khi chấm điểm: propagate SCORING_UNAVAILABLE', async () => {
  await assert.rejects(
    () =>
      checkDuplicates(
        validInput,
        context,
        deps({
          findCandidates: async () => [candidate('a')],
          scoreCandidates: async () => {
            throw new Error('provider timeout');
          },
        }),
        options,
      ),
    (error: unknown) => {
      assert.ok(error instanceof DedupError);
      assert.equal(error.code, 'SCORING_UNAVAILABLE');
      return true;
    },
  );
});

test('model trả ID không thuộc danh sách ứng viên: bị loại khỏi kết quả', async () => {
  const output = await checkDuplicates(
    validInput,
    context,
    deps({
      findCandidates: async () => [candidate('a')],
      scoreCandidates: async () => [
        { id: 'a', percent: 50, reason: 'ok' },
        { id: 'does-not-exist', percent: 99, reason: 'model tự bịa' },
      ],
    }),
    options,
  );

  assert.deepEqual(output.matches.map((m) => m.id), ['a']);
});

test('type trong output luôn lấy từ candidate thật của VNAIP, không phải từ model', async () => {
  const output = await checkDuplicates(
    validInput,
    context,
    deps({
      findCandidates: async () => [candidate('a')],
      scoreCandidates: async () => [{ id: 'a', percent: 50, reason: 'ok' }],
    }),
    options,
  );

  assert.equal(output.matches[0].type, 'solution');
});

test('percent ngoài thang [0,100] bị loại', async () => {
  const output = await checkDuplicates(
    validInput,
    context,
    deps({
      findCandidates: async () => [candidate('a'), candidate('b')],
      scoreCandidates: async () => [
        { id: 'a', percent: 150, reason: 'quá cao' },
        { id: 'b', percent: -10, reason: 'âm' },
      ],
    }),
    options,
  );

  assert.deepEqual(output.matches, []);
});

test('percent không phải integer (thập phân) bị loại', async () => {
  const output = await checkDuplicates(
    validInput,
    context,
    deps({
      findCandidates: async () => [candidate('a')],
      scoreCandidates: async () => [
        { id: 'a', percent: 79.5, reason: 'thập phân' },
      ],
    }),
    options,
  );

  assert.deepEqual(output.matches, []);
});

test('ID trùng trong output model: chỉ giữ lần xuất hiện đầu tiên', async () => {
  const output = await checkDuplicates(
    validInput,
    context,
    deps({
      findCandidates: async () => [candidate('a')],
      scoreCandidates: async () => [
        { id: 'a', percent: 30, reason: 'lần 1' },
        { id: 'a', percent: 90, reason: 'lần 2 (trùng)' },
      ],
    }),
    options,
  );

  assert.equal(output.matches.length, 1);
  assert.equal(output.matches[0].reason, 'lần 1');
});

test('output thiếu reason (rỗng sau trim) bị loại', async () => {
  const output = await checkDuplicates(
    validInput,
    context,
    deps({
      findCandidates: async () => [candidate('a')],
      scoreCandidates: async () => [{ id: 'a', percent: 50, reason: '   ' }],
    }),
    options,
  );

  assert.deepEqual(output.matches, []);
});

test('output bị cắt tối đa 30 kết quả theo percent cao nhất', async () => {
  const candidates = Array.from({ length: 40 }, (_, i) => candidate(`c${i}`));
  const matches: RawModelMatch[] = candidates.map((c, i) => ({
    id: c.id,
    percent: i,
    reason: `percent ${i}`,
  }));

  const output = await checkDuplicates(
    validInput,
    context,
    deps({
      findCandidates: async () => candidates,
      scoreCandidates: async () => matches,
    }),
    options,
  );

  assert.equal(output.matches.length, 30);
  assert.equal(output.matches[0].id, 'c39');
});
