import { isRecord } from "../shared/guards.js";

/**
 * Lấy input của tool từ body request. Core gọi tool với body dạng `{ body: { input } }`
 * (envelope); lời gọi trực tiếp có thể gửi `{ input }` hoặc chính input. Hàm này chỉ BÓC
 * lớp bọc, không validate: mỗi tool tự validate kết quả theo schema của mình.
 *
 * Dùng chung cho mọi tool để các tool không lệch nhau về cách đọc envelope.
 */
export function unwrapToolInput(requestBody: unknown): unknown {
  const wrapped = (requestBody as { body?: unknown } | null | undefined)?.body;
  const envelope = isRecord(wrapped) ? wrapped : requestBody;
  return (envelope as { input?: unknown } | null | undefined)?.input ?? envelope;
}
