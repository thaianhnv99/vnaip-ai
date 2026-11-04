import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDuplicates,
  DedupError,
  type Candidate,
  type DedupDependencies,
  type RawModelMatch,
} from '../dedup.js';

const options = { candidateLimit: 30, deadlineMs: 5000 };

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
    checkDuplicates({ ...validInput, content: '' }, deps({}), options),
  );
});

test('không có ứng viên trả về matches rỗng (không phải lỗi)', async () => {
  const output = await checkDuplicates(
    validInput,
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
        deps({
      findCandidates: async () => candidates,
      scoreCandidates: async () => matches,
    }),
    { candidateLimit: 100, deadlineMs: 5000 },
  );

  assert.equal(output.matches.length, 30);
  assert.equal(output.matches[0].id, 'c39');
});

test('excludeIds loại ứng viên khỏi kết quả và không gửi chúng cho model', async () => {
  let scored: string[] = [];
  const output = await checkDuplicates(
    { ...validInput, excludeIds: ['a', 'khong-ton-tai'] },
    deps({
      findCandidates: async () => [candidate('a'), candidate('b')],
      scoreCandidates: async (_input, candidates) => {
        scored = candidates.map((c) => c.id);
        return candidates.map((c) => ({ id: c.id, percent: 70, reason: 'giống' }));
      },
    }),
    options,
  );

  assert.deepEqual(scored, ['b']);
  assert.deepEqual(output.matches.map((m) => m.id), ['b']);
});

test('model vẫn trả id nằm trong excludeIds thì id đó bị loại', async () => {
  const output = await checkDuplicates(
    { ...validInput, excludeIds: ['a'] },
    deps({
      findCandidates: async () => [candidate('a'), candidate('b')],
      scoreCandidates: async () => [
        { id: 'a', percent: 99, reason: 'model vẫn trả id đã bị loại' },
        { id: 'b', percent: 10, reason: 'ok' },
      ],
    }),
    options,
  );

  assert.deepEqual(output.matches.map((m) => m.id), ['b']);
});

test('loại excludeIds xong là hết ứng viên thì trả matches rỗng và không gọi model', async () => {
  const output = await checkDuplicates(
    { ...validInput, excludeIds: ['a'] },
    deps({
      findCandidates: async () => [candidate('a')],
      scoreCandidates: async () => {
        throw new Error('không nên được gọi khi không còn ứng viên');
      },
    }),
    options,
  );

  assert.deepEqual(output.matches, []);
});

test('vượt trần ứng viên: báo CANDIDATE_LIMIT_EXCEEDED, KHÔNG cắt âm thầm và không gọi model', async () => {
  await assert.rejects(
    () =>
      checkDuplicates(
        validInput,
        deps({
          findCandidates: async () => Array.from({ length: 4 }, (_, i) => candidate(`c${i}`)),
          scoreCandidates: async () => {
            throw new Error('không nên được gọi khi vượt trần');
          },
        }),
        { candidateLimit: 3, deadlineMs: 5000 },
      ),
    (error: unknown) => {
      assert.ok(error instanceof DedupError);
      assert.equal(error.code, 'CANDIDATE_LIMIT_EXCEEDED');
      return true;
    },
  );
});

test('đúng bằng trần thì vẫn chấm; trần tính SAU khi loại excludeIds', async () => {
  const output = await checkDuplicates(
    { ...validInput, excludeIds: ['c3'] },
    deps({
      findCandidates: async () => Array.from({ length: 4 }, (_, i) => candidate(`c${i}`)),
      scoreCandidates: async (_input, candidates) =>
        candidates.map((c) => ({ id: c.id, percent: 50, reason: 'ok' })),
    }),
    { candidateLimit: 3, deadlineMs: 5000 },
  );

  assert.equal(output.matches.length, 3);
});

test('DedupError từ nguồn ứng viên (vượt giới hạn đọc) được giữ nguyên mã, không bị gói thành CANDIDATES_UNAVAILABLE', async () => {
  await assert.rejects(
    () =>
      checkDuplicates(
        validInput,
        deps({
          findCandidates: async () => {
            throw new DedupError('CANDIDATE_LIMIT_EXCEEDED', 'kho quá lớn');
          },
        }),
        options,
      ),
    (error: unknown) => {
      assert.ok(error instanceof DedupError);
      assert.equal(error.code, 'CANDIDATE_LIMIT_EXCEEDED');
      return true;
    },
  );
});

test('scoreCandidates nhận deadlineAt tính từ deadlineMs của lời gọi', async () => {
  let received: number | undefined;
  const before = Date.now();
  await checkDuplicates(
    validInput,
    deps({
      findCandidates: async () => [candidate('a')],
      scoreCandidates: async (_input, _candidates, scoreOptions) => {
        received = scoreOptions.deadlineAt;
        return [];
      },
    }),
    { candidateLimit: 30, deadlineMs: 4000 },
  );
  const after = Date.now();

  assert.ok(received !== undefined);
  assert.ok(received >= before + 4000 && received <= after + 4000);
});
