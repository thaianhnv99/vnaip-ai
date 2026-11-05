/**
 * Ba loại hồ sơ của VNAIP. Đây là NGUỒN DUY NHẤT của danh sách type trong code:
 * webhook, tool check-duplicates, store, worker và script seed đều dùng chung.
 *
 * Mỗi type nằm ở một collection Qdrant riêng (xem vector-store.ts và
 * qdrant-store.ts), nên type quyết định hồ sơ được GHI vào đâu, ĐỌC từ đâu để so
 * sánh và bị XOÁ ở đâu. Thêm hay đổi tên một type là đổi tên collection, nên phải
 * đi cùng việc cập nhật dedup-input.schema.json, dedup-output.schema.json và
 * migrate dữ liệu đã index.
 *
 * Giá trị khớp từng ký tự (phân biệt hoa/thường, số nhiều): "ideas", không phải
 * "idea" hay "Ideas".
 */
export const RECORD_TYPES = ["ideas", "solutions", "initiatives"] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

export function isRecordType(value: unknown): value is RecordType {
  return typeof value === "string" && (RECORD_TYPES as readonly string[]).includes(value);
}

/** Dùng trong thông báo lỗi: nêu các giá trị hợp lệ, không lặp lại giá trị đã gửi. */
export const RECORD_TYPES_LABEL = RECORD_TYPES.join(", ");
