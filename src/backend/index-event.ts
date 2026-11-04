/**
 * Hợp đồng của event "sáng kiến được duyệt" mà VNAIP BE gửi vào webhook.
 *
 * - Không còn `datasetKey` (quyết định 2026-11-04): mọi sáng kiến nằm chung một
 *   tập dữ liệu. Nếu BE vẫn gửi trường này thì nó bị bỏ qua như mọi trường lạ.
 * - `id` là khoá định danh sáng kiến và phải duy nhất trong toàn VNAIP: gửi lại
 *   cùng `id` là cập nhật sáng kiến đó, không tạo bản mới.
 * - `fileRef` là tham chiếu tới file trong MinIO của VNAIP. #TODO: VNAIP chưa có
 *   MinIO nên định dạng của nó (khoá object, bucket, URL?) chưa được chốt; tạm
 *   nhận chuỗi hoặc object nhỏ, mang theo trong job và bỏ qua ở worker.
 * - Trường lạ bị bỏ qua để BE có thể thêm trường mà không làm hỏng webhook.
 * - Thông báo lỗi chỉ nêu tên trường, không bao giờ lặp lại giá trị đã gửi.
 */

export const MAX_ID_LENGTH = 200;
export const MAX_TYPE_LENGTH = 50;
export const MAX_TITLE_LENGTH = 300;
export const MAX_CONTENT_LENGTH = 200_000;
export const MAX_METADATA_BYTES = 10_000;
/** #TODO: giới hạn tạm cho fileRef, chỉnh khi biết định dạng thật. */
export const MAX_FILE_REF_BYTES = 2_000;

export interface IndexEvent {
  ideaId: string;
  type: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  /** #TODO(MinIO): tham chiếu file trong MinIO của VNAIP; chưa được xử lý. */
  fileRef?: string | Record<string, unknown>;
}

export class IndexEventError extends Error {
  readonly code = "INVALID_EVENT" as const;

  constructor(message: string) {
    super(message);
    this.name = "IndexEventError";
  }
}

export function parseIndexEvent(body: unknown): IndexEvent {
  if (!isRecord(body)) {
    throw new IndexEventError("Body phải là một JSON object");
  }

  const ideaId = requireString(body, "id", MAX_ID_LENGTH);
  const type = requireString(body, "type", MAX_TYPE_LENGTH);
  const title = requireString(body, "title", MAX_TITLE_LENGTH);
  const content = requireString(body, "content", MAX_CONTENT_LENGTH);

  let metadata: Record<string, unknown> = {};
  if (body.metadata !== undefined && body.metadata !== null) {
    if (!isRecord(body.metadata)) {
      throw new IndexEventError("Trường metadata phải là object");
    }
    if (Buffer.byteLength(JSON.stringify(body.metadata), "utf8") > MAX_METADATA_BYTES) {
      throw new IndexEventError(`Trường metadata vượt ${MAX_METADATA_BYTES} byte`);
    }
    metadata = body.metadata;
  }

  let fileRef: IndexEvent["fileRef"];
  if (body.fileRef !== undefined && body.fileRef !== null) {
    const valid =
      (typeof body.fileRef === "string" && body.fileRef.trim().length > 0) ||
      isRecord(body.fileRef);
    if (!valid) {
      throw new IndexEventError("Trường fileRef phải là chuỗi không rỗng hoặc object");
    }
    if (Buffer.byteLength(JSON.stringify(body.fileRef), "utf8") > MAX_FILE_REF_BYTES) {
      throw new IndexEventError(`Trường fileRef vượt ${MAX_FILE_REF_BYTES} byte`);
    }
    fileRef = body.fileRef as IndexEvent["fileRef"];
  }

  return {
    ideaId,
    type,
    title,
    content,
    metadata,
    ...(fileRef !== undefined ? { fileRef } : {}),
  };
}

function requireString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new IndexEventError(`Trường ${field} bắt buộc và phải là chuỗi không rỗng`);
  }
  if (value.length > maxLength) {
    throw new IndexEventError(`Trường ${field} vượt ${maxLength} ký tự`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
