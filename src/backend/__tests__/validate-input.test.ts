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

test('excludeId và parentSolutionId optional hợp lệ được giữ lại', () => {
  const parsed = parseDedupInput({ ...valid, excludeId: 'ex-1', parentSolutionId: 'parent-1' });
  assert.equal(parsed.excludeId, 'ex-1');
  assert.equal(parsed.parentSolutionId, 'parent-1');
});

test('input không phải object bị từ chối', () => {
  assert.throws(() => parseDedupInput('not an object'));
  assert.throws(() => parseDedupInput(null));
  assert.throws(() => parseDedupInput(undefined));
});
