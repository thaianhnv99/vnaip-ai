import { isRecordType, RECORD_TYPES_LABEL, type RecordType } from "./record-type.js";
import { isRecord } from "./shared/guards.js";

/**
 * Hợp đồng của event "sáng kiến được duyệt" mà VNAIP BE gửi vào webhook.
 *
 * - `type` bắt buộc và phải là MỘT trong `ideas` / `solutions` / `initiatives`
 *   (khớp từng ký tự, xem record-type.ts). Giá trị khác bị từ chối ngay ở đây (400),
 *   trước khi có job nào được đẩy vào hàng đợi; type quyết định collection Qdrant mà
 *   worker ghi sáng kiến vào.
 * - Không còn `datasetKey` (quyết định 2026-11-04): không tách dữ liệu theo workspace.
 *   Nếu BE vẫn gửi trường này thì nó bị bỏ qua như mọi trường lạ.
 * - `id` là khoá định danh sáng kiến và phải duy nhất trong toàn VNAIP: gửi lại
 *   cùng `id` CÙNG `type` là cập nhật sáng kiến đó, không tạo bản mới. Gửi lại cùng
 *   `id` với `type` khác thì tạo bản thứ hai ở collection của type mới; bản cũ ở
 *   collection của type cũ không bị xoá.
 * - `fileRef` là tham chiếu tới file trong MinIO của VNAIP. #TODO: VNAIP chưa có
 *   MinIO nên định dạng của nó (khoá object, bucket, URL?) chưa được chốt; tạm
 *   nhận chuỗi hoặc object nhỏ, mang theo trong job và bỏ qua ở worker.
 * - Body là một event hoặc một mảng event (`parseIndexEvents`, tối đa
 *   MAX_BATCH_SIZE). Mỗi phần tử theo đúng hợp đồng của một event.
 * - Trường lạ bị bỏ qua để BE có thể thêm trường mà không làm hỏng webhook.
 * - Thông báo lỗi chỉ nêu tên trường, không bao giờ lặp lại giá trị đã gửi.
 */

export const MAX_ID_LENGTH = 200;
export const MAX_TITLE_LENGTH = 300;
export const MAX_CONTENT_LENGTH = 200_000;
export const MAX_METADATA_BYTES = 10_000;
/** #TODO: giới hạn tạm cho fileRef, chỉnh khi biết định dạng thật. */
export const MAX_FILE_REF_BYTES = 2_000;
/**
 * Số event tối đa trong một request dạng mảng. Body vẫn bị chặn ở 1MB cho cả
 * request (BODY_LIMIT), nên mảng toàn event lớn sẽ chạm giới hạn đó trước.
 */
export const MAX_BATCH_SIZE = 50;

export interface IndexEvent {
  ideaId: string;
  type: RecordType;
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

export interface ParsedIndexEvents {
  /** true nếu body là mảng: response trả danh sách job thay vì một `jobId`. */
  batch: boolean;
  /** Theo đúng thứ tự BE gửi; luôn có ít nhất một event. */
  events: IndexEvent[];
}

/**
 * Body webhook là một event (object) hoặc một mảng event. Mảng được kiểm tra
 * trọn vẹn hoặc không gì cả: một phần tử sai thì cả request bị từ chối, nên
 * không bao giờ có chuyện chỉ một phần mảng được nhận. Thông báo lỗi nêu chỉ số
 * phần tử (bắt đầu từ 0), không lặp lại giá trị đã gửi.
 */
export function parseIndexEvents(body: unknown): ParsedIndexEvents {
  if (!Array.isArray(body)) {
    if (!isRecord(body)) {
      throw new IndexEventError("Body phải là một JSON object hoặc một mảng các object");
    }
    return { batch: false, events: [parseIndexEvent(body)] };
  }

  if (body.length === 0) {
    throw new IndexEventError("Mảng event không được rỗng");
  }
  if (body.length > MAX_BATCH_SIZE) {
    throw new IndexEventError(`Mảng event vượt ${MAX_BATCH_SIZE} phần tử`);
  }

  const events = body.map((item: unknown, index): IndexEvent => {
    if (!isRecord(item)) {
      throw new IndexEventError(`Phần tử [${index}] phải là một JSON object`);
    }
    try {
      return parseIndexEvent(item);
    } catch (error) {
      if (error instanceof IndexEventError) {
        throw new IndexEventError(`Phần tử [${index}]: ${error.message}`);
      }
      throw error;
    }
  });
  return { batch: true, events };
}

export function parseIndexEvent(body: unknown): IndexEvent {
  if (!isRecord(body)) {
    throw new IndexEventError("Body phải là một JSON object");
  }

  const ideaId = requireString(body, "id", MAX_ID_LENGTH);
  // Khớp chính xác, không trim hay đổi hoa/thường: "Ideas" hay "idea" là sai type chứ
  // không phải lỗi gõ để đoán. Thông báo nêu các giá trị hợp lệ, không lặp lại giá trị gửi.
  const type = body.type;
  if (!isRecordType(type)) {
    throw new IndexEventError(`Trường type bắt buộc và phải là một trong: ${RECORD_TYPES_LABEL}`);
  }
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
