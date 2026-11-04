import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IndexEventError,
  MAX_CONTENT_LENGTH,
  MAX_TITLE_LENGTH,
  parseIndexEvent,
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

test("thông báo lỗi không lặp lại giá trị đã gửi", () => {
  assert.throws(
    () => parseIndexEvent({ ...valid, title: "GIA-TRI-NHAY-CAM".repeat(50) }),
    (error: unknown) => error instanceof IndexEventError && !error.message.includes("GIA-TRI-NHAY-CAM"),
  );
});
