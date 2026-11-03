import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckDuplicatesHandler } from '../check-duplicates-route.js';
import type { DedupDependencies } from '../dedup.js';
import type { Request, Response } from 'express';

function fakeRequestResponse(body: unknown) {
  const request = {
    body,
    header: () => undefined,
  } as unknown as Request;

  const state: { status: number; body?: unknown } = { status: 200 };
  const response = {
    locals: { sota: { oid: 'org-1', wid: 'ws-1', iid: 'install-1', sub: 'user-1', scp: ['tool:check-duplicates'] } },
    getHeader: () => 'req-1',
    status(code: number) {
      state.status = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
  } as unknown as Response;

  return { request, response, state };
}

const validInput = {
  type: 'solution',
  title: 'Giải pháp quản lý hồ sơ',
  content: 'Nội dung mô tả giải pháp quản lý hồ sơ số hóa cho đơn vị hành chính.',
};

test('request hợp lệ trả 200 với output đúng schema', async () => {
  const deps: DedupDependencies = {
    findCandidates: async () => [{ id: 'a', type: 'solution', title: 'A', content: 'nội dung A' }],
    scoreCandidates: async () => [{ id: 'a', percent: 60, reason: 'giống nhau' }],
  };

  const handler = createCheckDuplicatesHandler(deps, {});
  const { request, response, state } = fakeRequestResponse({ body: { input: validInput } });

  await handler(request, response, () => {});

  assert.equal(state.status, 200);
  assert.deepEqual((state.body as any).matches[0].id, 'a');
  assert.equal((state.body as any).matches[0].percent, 60);
  assert.equal((state.body as any).matches[0].score, 0.6);
});

test('input sai schema trả 400 INVALID_INPUT', async () => {
  const deps: DedupDependencies = {
    findCandidates: async () => [],
    scoreCandidates: async () => [],
  };
  const handler = createCheckDuplicatesHandler(deps, {});
  const { request, response, state } = fakeRequestResponse({ body: { input: { type: 'solution' } } });

  await handler(request, response, () => {});

  assert.equal(state.status, 400);
  assert.equal((state.body as any).code, 'INVALID_INPUT');
});

test('VNAIP BE lỗi trả 502 CANDIDATES_UNAVAILABLE, không lộ chi tiết lỗi gốc', async () => {
  const deps: DedupDependencies = {
    findCandidates: async () => {
      throw new Error('ECONNREFUSED 10.0.0.5:443 token=super-secret-abc');
    },
    scoreCandidates: async () => [],
  };
  const handler = createCheckDuplicatesHandler(deps, {});
  const { request, response, state } = fakeRequestResponse({ body: { input: validInput } });

  await handler(request, response, () => {});

  assert.equal(state.status, 502);
  assert.equal((state.body as any).code, 'CANDIDATES_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(state.body), /super-secret-abc/);
  assert.doesNotMatch(JSON.stringify(state.body), /10\.0\.0\.5/);
});

test('model lỗi trả 502 SCORING_UNAVAILABLE', async () => {
  const deps: DedupDependencies = {
    findCandidates: async () => [{ id: 'a', type: 'solution', title: 'A', content: 'x' }],
    scoreCandidates: async () => {
      throw new Error('provider 500');
    },
  };
  const handler = createCheckDuplicatesHandler(deps, {});
  const { request, response, state } = fakeRequestResponse({ body: { input: validInput } });

  await handler(request, response, () => {});

  assert.equal(state.status, 502);
  assert.equal((state.body as any).code, 'SCORING_UNAVAILABLE');
});

test('không có ứng viên trả 200 với matches rỗng (phân biệt với lỗi)', async () => {
  const deps: DedupDependencies = {
    findCandidates: async () => [],
    scoreCandidates: async () => {
      throw new Error('không nên được gọi khi không có ứng viên');
    },
  };
  const handler = createCheckDuplicatesHandler(deps, {});
  const { request, response, state } = fakeRequestResponse({ body: { input: validInput } });

  await handler(request, response, () => {});

  assert.equal(state.status, 200);
  assert.deepEqual((state.body as any).matches, []);
});

test('log lỗi không chứa nội dung hồ sơ (title/content) hoặc bí mật', async () => {
  const originalLog = console.log;
  const logged: string[] = [];
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };

  try {
    const deps: DedupDependencies = {
      findCandidates: async () => {
        throw new Error('network down, Authorization: Bearer abc.def.ghi');
      },
      scoreCandidates: async () => [],
    };
    const handler = createCheckDuplicatesHandler(deps, {});
    const sensitiveInput = {
      ...validInput,
      content: 'NỘI DUNG NHẠY CẢM KHÔNG ĐƯỢC LOG: mã số bí mật XYZ-123',
    };
    const { request, response } = fakeRequestResponse({ body: { input: sensitiveInput } });

    await handler(request, response, () => {});
  } finally {
    console.log = originalLog;
  }

  const combined = logged.join('\n');
  assert.doesNotMatch(combined, /NỘI DUNG NHẠY CẢM/);
  assert.doesNotMatch(combined, /XYZ-123/);
  assert.doesNotMatch(combined, /Bearer abc\.def\.ghi/);
});
