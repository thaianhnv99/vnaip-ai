import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IndexEventError,
  MAX_BATCH_SIZE,
  MAX_CONTENT_LENGTH,
  MAX_TITLE_LENGTH,
  parseIndexEvent,
  parseIndexEvents,
} from "../index-event.js";

const valid = {
  id: "GP-2026-0022",
  type: "solution",
  title: "Ứng dụng báo cáo sự cố",
  content: "Nội dung sáng kiến.",
};

function rejects(body: unknown, messagePart: string) {
  assert.throws(
    () => parseIndexEvent(body),
    (error: unknown) =>
      error instanceof IndexEventError &&
      error.code === "INVALID_EVENT" &&
      error.message.includes(messagePart),
  );
}

test("event hợp lệ tối thiểu được parse, metadata mặc định là {}", () => {
  assert.deepEqual(parseIndexEvent(valid), {
    ideaId: "GP-2026-0022",
    type: "solution",
    title: "Ứng dụng báo cáo sự cố",
    content: "Nội dung sáng kiến.",
    metadata: {},
  });
});

test("metadata được giữ; fileRef được mang theo; trường lạ (kể cả datasetKey, fileLinks cũ) bị bỏ qua", () => {
  const event = parseIndexEvent({
    ...valid,
    metadata: { author: "x" },
    fileRef: "bucket/ideas/GP-1.pdf",
    fileLinks: ["https://a.example/1.pdf"],
    workspaceId: "khong-duoc-dung",
    datasetKey: "workspace-7",
  });
  assert.deepEqual(event.metadata, { author: "x" });
  assert.equal(event.fileRef, "bucket/ideas/GP-1.pdf");
  assert.equal("workspaceId" in event, false);
  assert.equal("fileLinks" in event, false);
  assert.equal("datasetKey" in event, false);

  // #TODO: định dạng fileRef chưa chốt vì VNAIP chưa có MinIO; object cũng được nhận.
  assert.deepEqual(parseIndexEvent({ ...valid, fileRef: { bucket: "b", key: "k" } }).fileRef, { bucket: "b", key: "k" });
  assert.equal("fileRef" in parseIndexEvent({ ...valid, fileRef: null }), false);
});

test("thiếu hoặc sai kiểu các trường bắt buộc bị từ chối, nêu đúng tên trường", () => {
  for (const field of ["id", "type", "title", "content"] as const) {
    rejects({ ...valid, [field]: undefined }, field);
    rejects({ ...valid, [field]: "   " }, field);
    rejects({ ...valid, [field]: 123 }, field);
  }
});

test("giới hạn độ dài được áp dụng", () => {
  rejects({ ...valid, title: "x".repeat(MAX_TITLE_LENGTH + 1) }, "title");
  rejects({ ...valid, content: "x".repeat(MAX_CONTENT_LENGTH + 1) }, "content");
  assert.doesNotThrow(() => parseIndexEvent({ ...valid, content: "x".repeat(MAX_CONTENT_LENGTH) }));
});

test("metadata và fileRef sai định dạng bị từ chối", () => {
  rejects({ ...valid, metadata: ["a"] }, "metadata");
  rejects({ ...valid, metadata: "text" }, "metadata");
  rejects({ ...valid, metadata: { blob: "x".repeat(10_001) } }, "metadata");
  rejects({ ...valid, fileRef: "   " }, "fileRef");
  rejects({ ...valid, fileRef: 123 }, "fileRef");
  rejects({ ...valid, fileRef: ["a"] }, "fileRef");
  rejects({ ...valid, fileRef: "x".repeat(2_001) }, "fileRef");
});

test("body không phải object bị từ chối", () => {
  for (const body of [undefined, null, "text", 5, [valid]]) {
    rejects(body, "object");
  }
});

function rejectsBatch(body: unknown, messagePart: string) {
  assert.throws(
    () => parseIndexEvents(body),
    (error: unknown) =>
      error instanceof IndexEventError &&
      error.code === "INVALID_EVENT" &&
      error.message.includes(messagePart),
  );
}

test("parseIndexEvents: object đơn là batch=false, mảng là batch=true và giữ thứ tự", () => {
  const single = parseIndexEvents(valid);
  assert.equal(single.batch, false);
  assert.deepEqual(single.events, [parseIndexEvent(valid)]);

  const list = parseIndexEvents([valid, { ...valid, id: "GP-2" }, { ...valid, id: "GP-3" }]);
  assert.equal(list.batch, true);
  assert.deepEqual(list.events.map((event) => event.ideaId), ["GP-2026-0022", "GP-2", "GP-3"]);

  // Mảng một phần tử vẫn là batch: dạng response do kiểu body quyết định.
  assert.equal(parseIndexEvents([valid]).batch, true);
});

test("parseIndexEvents: mỗi phần tử theo đúng luật của một event (trường lạ bỏ qua, metadata mặc định)", () => {
  const [event] = parseIndexEvents([{ ...valid, datasetKey: "workspace-7", extra: 1 }]).events;
  assert.equal("datasetKey" in event!, false);
  assert.equal("extra" in event!, false);
  assert.deepEqual(event!.metadata, {});
});

test("parseIndexEvents: body không phải object/mảng, mảng rỗng, mảng quá dài bị từ chối", () => {
  for (const body of [undefined, null, "text", 5, true]) {
    rejectsBatch(body, "object");
  }
  rejectsBatch([], "rỗng");
  rejectsBatch(Array.from({ length: MAX_BATCH_SIZE + 1 }, () => valid), String(MAX_BATCH_SIZE));
  assert.equal(parseIndexEvents(Array.from({ length: MAX_BATCH_SIZE }, () => valid)).events.length, MAX_BATCH_SIZE);
});

test("parseIndexEvents: phần tử sai bị từ chối kèm chỉ số, kể cả phần tử không phải object", () => {
  rejectsBatch([valid, { ...valid, title: "" }], "[1]");
  rejectsBatch([valid, { ...valid, title: "" }], "title");
  rejectsBatch([{ ...valid, id: undefined }, valid], "[0]");
  rejectsBatch([valid, "text"], "[1]");
  rejectsBatch([valid, null], "[1]");
  rejectsBatch([valid, [valid]], "[1]"); // mảng lồng mảng không được nhận
  rejectsBatch([valid, 5], "object");
});

test("parseIndexEvents: thông báo lỗi của phần tử không lặp lại giá trị đã gửi", () => {
  assert.throws(
    () => parseIndexEvents([valid, { ...valid, title: "GIA-TRI-NHAY-CAM".repeat(50) }]),
    (error: unknown) => error instanceof IndexEventError && !error.message.includes("GIA-TRI-NHAY-CAM"),
  );
});

test("thông báo lỗi không lặp lại giá trị đã gửi", () => {
  assert.throws(
    () => parseIndexEvent({ ...valid, title: "GIA-TRI-NHAY-CAM".repeat(50) }),
    (error: unknown) => error instanceof IndexEventError && !error.message.includes("GIA-TRI-NHAY-CAM"),
  );
});
