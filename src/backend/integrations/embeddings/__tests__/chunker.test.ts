import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../chunker.js";

test("văn bản ngắn là một chunk; rỗng hoặc toàn khoảng trắng không có chunk", () => {
  assert.deepEqual(chunkText("Một câu ngắn."), ["Một câu ngắn."]);
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("  \n\n \r\n  "), []);
});

test("gom các đoạn liền nhau vào cùng chunk khi còn vừa, tách khi vượt maxChars", () => {
  const paragraphs = ["a".repeat(30), "b".repeat(30), "c".repeat(30)];
  const text = paragraphs.join("\n\n");

  assert.deepEqual(chunkText(text, { maxChars: 100 }), [text]);
  assert.deepEqual(chunkText(text, { maxChars: 70 }), [
    `${paragraphs[0]}\n\n${paragraphs[1]}`,
    paragraphs[2],
  ]);
});

test("đoạn quá dài được cắt ở khoảng trắng, không chunk nào vượt maxChars hoặc rỗng", () => {
  const words = Array.from({ length: 1000 }, (_, i) => `từ${i}`);
  const chunks = chunkText(words.join(" "), { maxChars: 200 });

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 200));
  // Không mất từ nào và không từ nào bị cắt đôi.
  assert.deepEqual(chunks.join(" ").split(/\s+/), words);
});

test("chuỗi không có khoảng trắng bị cắt cứng đúng maxChars", () => {
  const chunks = chunkText("a".repeat(500), { maxChars: 100 });
  assert.deepEqual(chunks.map((chunk) => chunk.length), [100, 100, 100, 100, 100]);
});

test("không cắt giữa cặp surrogate của emoji", () => {
  const text = "a".repeat(99) + "😀" + "b".repeat(50);
  const chunks = chunkText(text, { maxChars: 100 });
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => !loneSurrogate.test(chunk)));
  assert.equal(chunks.join(""), text);
});

test("CRLF được chuẩn hoá thành đoạn", () => {
  assert.deepEqual(chunkText("đoạn một\r\n\r\nđoạn hai", { maxChars: 50 }), ["đoạn một\n\nđoạn hai"]);
});

test("maxChars không hợp lệ bị từ chối", () => {
  assert.throws(() => chunkText("x", { maxChars: 10 }), RangeError);
  assert.throws(() => chunkText("x", { maxChars: 100.5 }), RangeError);
});
