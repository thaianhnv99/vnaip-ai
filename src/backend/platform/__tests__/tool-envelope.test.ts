import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrapToolInput } from '../tool-envelope.js';

/**
 * Hàm này thay hai bản chép của cùng một biểu thức (`/tools/example` và `/tools/check-duplicates`):
 *   envelope = isRecord(body?.body) ? body.body : body;  return envelope?.input ?? envelope;
 * Các case dưới đây khoá ngữ nghĩa đó, kể cả các hình dạng body bất thường.
 */

const input = { type: 'ideas', title: 'T', content: 'C' };

test('envelope của Core: { body: { input } } trả về input', () => {
  assert.deepEqual(unwrapToolInput({ body: { input } }), input);
});

test('lời gọi trực tiếp: { input } trả về input', () => {
  assert.deepEqual(unwrapToolInput({ input }), input);
});

test('body chính là input (không có lớp bọc): trả về chính nó', () => {
  assert.deepEqual(unwrapToolInput(input), input);
});

test('envelope { body: {...} } không có input: trả về object trong body', () => {
  assert.deepEqual(unwrapToolInput({ body: input }), input);
});

test('input là null: rơi về envelope', () => {
  assert.deepEqual(unwrapToolInput({ input: null }), { input: null });
});

test('body.body không phải object: không coi là envelope', () => {
  const body = { body: 'chuỗi' };
  assert.equal(unwrapToolInput(body), body);
  const withArray = { body: [1, 2] };
  assert.equal(unwrapToolInput(withArray), withArray);
});

test('body không phải object: trả về nguyên giá trị, không ném lỗi', () => {
  assert.equal(unwrapToolInput(undefined), undefined);
  assert.equal(unwrapToolInput(null), null);
  assert.equal(unwrapToolInput('x'), 'x');
  const list = [1];
  assert.equal(unwrapToolInput(list), list);
});
