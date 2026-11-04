import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDedupInput } from '../validate-input.js';

const valid = { type: 'solution', title: 'Tiêu đề', content: 'Nội dung' };

test('input hợp lệ được parse đúng', () => {
  const parsed = parseDedupInput(valid);
  assert.equal(parsed.type, 'solution');
  assert.equal(parsed.title, 'Tiêu đề');
});

test('thiếu title bị từ chối', () => {
  assert.throws(() => parseDedupInput({ type: 'solution', content: 'x' }));
});

test('thiếu content bị từ chối', () => {
  assert.throws(() => parseDedupInput({ type: 'solution', title: 'x' }));
});

test('type không phải "solution" bị từ chối', () => {
  assert.throws(() => parseDedupInput({ ...valid, type: 'other' }));
});

test('title rỗng bị từ chối', () => {
  assert.throws(() => parseDedupInput({ ...valid, title: '' }));
});

test('title vượt 300 ký tự bị từ chối', () => {
  assert.throws(() => parseDedupInput({ ...valid, title: 'a'.repeat(301) }));
});

test('additionalProperties không khai báo bị từ chối', () => {
  assert.throws(() => parseDedupInput({ ...valid, unknownField: 'x' }));
});

test('excludeIds và parentSolutionId optional hợp lệ được giữ lại', () => {
  const parsed = parseDedupInput({ ...valid, excludeIds: ['ex-1', 'ex-2'], parentSolutionId: 'parent-1' });
  assert.deepEqual(parsed.excludeIds, ['ex-1', 'ex-2']);
  assert.equal(parsed.parentSolutionId, 'parent-1');
});

test('không có excludeIds thì để undefined', () => {
  assert.equal(parseDedupInput(valid).excludeIds, undefined);
});

test('excludeId (số ít, tên cũ) bị từ chối như trường lạ: BE phải đổi sang excludeIds', () => {
  assert.throws(() => parseDedupInput({ ...valid, excludeId: 'ex-1' }), /excludeId/);
});

test('datasetKey (đã bỏ) bị từ chối như trường lạ', () => {
  assert.throws(() => parseDedupInput({ ...valid, datasetKey: 'ws-1' }), /datasetKey/);
});

test('excludeIds phải là mảng string 1..200 ký tự, tối đa 100 phần tử', () => {
  assert.throws(() => parseDedupInput({ ...valid, excludeIds: 'ex-1' }));
  assert.throws(() => parseDedupInput({ ...valid, excludeIds: [1] }));
  assert.throws(() => parseDedupInput({ ...valid, excludeIds: [''] }));
  assert.throws(() => parseDedupInput({ ...valid, excludeIds: ['a'.repeat(201)] }));
  assert.throws(() => parseDedupInput({ ...valid, excludeIds: Array.from({ length: 101 }, (_, i) => `id-${i}`) }));
  assert.deepEqual(
    parseDedupInput({ ...valid, excludeIds: Array.from({ length: 100 }, (_, i) => `id-${i}`) }).excludeIds?.length,
    100,
  );
  assert.deepEqual(parseDedupInput({ ...valid, excludeIds: [] }).excludeIds, []);
});

test('input không phải object bị từ chối', () => {
  assert.throws(() => parseDedupInput('not an object'));
  assert.throws(() => parseDedupInput(null));
  assert.throws(() => parseDedupInput(undefined));
});
