import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertValidDedupOutput } from '../validate-output.js';

test('output hợp lệ không throw', () => {
  assert.doesNotThrow(() =>
    assertValidDedupOutput({
      matches: [{ type: 'solution', id: 'a', score: 0.5, percent: 50, reason: 'ok' }],
    }),
  );
});

test('matches rỗng hợp lệ', () => {
  assert.doesNotThrow(() => assertValidDedupOutput({ matches: [] }));
});

test('thiếu field matches bị từ chối', () => {
  assert.throws(() => assertValidDedupOutput({}));
});

test('additionalProperties ở top-level bị từ chối', () => {
  assert.throws(() => assertValidDedupOutput({ matches: [], extra: 1 }));
});

test('score ngoài [0,1] bị từ chối', () => {
  assert.throws(() =>
    assertValidDedupOutput({
      matches: [{ type: 'solution', id: 'a', score: 1.1, percent: 50, reason: 'ok' }],
    }),
  );
});

test('percent ngoài [0,100] bị từ chối', () => {
  assert.throws(() =>
    assertValidDedupOutput({
      matches: [{ type: 'solution', id: 'a', score: 0.5, percent: 101, reason: 'ok' }],
    }),
  );
});

test('percent không phải integer bị từ chối', () => {
  assert.throws(() =>
    assertValidDedupOutput({
      matches: [{ type: 'solution', id: 'a', score: 0.5, percent: 50.5, reason: 'ok' }],
    }),
  );
});

test('thiếu field percent bị từ chối', () => {
  assert.throws(() =>
    assertValidDedupOutput({ matches: [{ type: 'solution', id: 'a', score: 0.5, reason: 'ok' }] }),
  );
});

test('reason rỗng bị từ chối', () => {
  assert.throws(() =>
    assertValidDedupOutput({
      matches: [{ type: 'solution', id: 'a', score: 0.5, percent: 50, reason: '' }],
    }),
  );
});

test('type khác "solution" bị từ chối', () => {
  assert.throws(() =>
    assertValidDedupOutput({
      matches: [{ type: 'other', id: 'a', score: 0.5, percent: 50, reason: 'ok' }],
    }),
  );
});

test('vượt maxItems 30 bị từ chối', () => {
  const matches = Array.from({ length: 31 }, (_, i) => ({
    type: 'solution',
    id: `id-${i}`,
    score: 0.1,
    percent: 10,
    reason: 'ok',
  }));
  assert.throws(() => assertValidDedupOutput({ matches }));
});
