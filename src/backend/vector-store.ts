import { createHash } from "node:crypto";

/**
 * Hợp đồng lưu trữ vector.
 *
 * Quyết định 2026-11-04: bỏ `datasetKey`. Toàn bộ sáng kiến của VNAIP nằm trong
 * MỘT tập dữ liệu duy nhất của collection; app không tách dữ liệu theo workspace
 * hay tenant nữa. Hệ quả cần nhớ:
 * - Không còn filter cách ly ở tầng lưu trữ. Ai gọi được tool `check-duplicates`
 *   thì thấy được mọi sáng kiến, nên việc giới hạn người gọi phải làm ở tầng tool
 *   (kiểm claim đã xác thực của Core), không phải ở đây.
 * - Mỗi môi trường dùng một collection riêng (QDRANT_COLLECTION).
 * - `ideaId` phải là duy nhất trong toàn VNAIP, vì nó là khoá định danh một
 *   sáng kiến: gửi lại cùng `ideaId` nghĩa là cập nhật chính sáng kiến đó.
 * - Point ID suy ra từ (ideaId, chunkIndex) nên retry không tạo trùng.
 */

export type VectorStoreErrorCode =
  | "NOT_CONFIGURED"
  | "INVALID_POINT"
  | "COLLECTION_MISMATCH"
  | "AUTH_ERROR"
  | "BAD_REQUEST"
  | "UPSTREAM_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "BAD_RESPONSE";

const RETRYABLE_CODES: ReadonlySet<VectorStoreErrorCode> = new Set([
  "UPSTREAM_ERROR",
  "TIMEOUT",
  "NETWORK_ERROR",
]);

export class VectorStoreError extends Error {
  readonly code: VectorStoreErrorCode;
  readonly retryable: boolean;

  constructor(
    code: VectorStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    this.name = "VectorStoreError";
  }
}

export const DEFAULT_MAX_SCROLL_POINTS = 10000;

/** Payload của mỗi chunk. */
export interface IdeaChunkPayload {
  ideaId: string;
  type: string;
  title: string;
  chunkIndex: number;
  chunkCount: number;
  content: string;
  metadata: Record<string, unknown>;
  /** Model đã tạo vector; đổi model thì phải reindex. */
  embeddingModel: string;
  indexedAt: string;
}

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: IdeaChunkPayload;
}

export interface StoredChunk {
  id: string;
  payload: IdeaChunkPayload;
}

export interface ScrollResult {
  points: StoredChunk[];
  /** true nếu còn point chưa trả về vì chạm `maxPoints`. */
  truncated: boolean;
}

export interface VectorStore {
  /** Tạo collection và payload index nếu chưa có; báo lỗi nếu cấu hình lệch. */
  ensureCollection(): Promise<void>;
  /** Idempotent: cùng (ideaId, chunkIndex) thì ghi đè đúng point đó. */
  upsertChunks(points: VectorPoint[]): Promise<void>;
  /** Hướng A: lấy mọi chunk trong collection (không có vector). */
  scrollAll(options?: { maxPoints?: number }): Promise<ScrollResult>;
  deleteIdea(ideaId: string): Promise<void>;
  /**
   * Xoá các chunk có chunkIndex >= fromChunkIndex của một idea. Dùng sau khi
   * index lại một idea với ít chunk hơn lần trước, để không còn chunk thừa.
   */
  deleteChunksFrom(ideaId: string, fromChunkIndex: number): Promise<void>;
}

// Namespace cố định cho UUID v5 của app này. Đổi giá trị này sẽ đổi mọi point ID.
const POINT_ID_NAMESPACE = Buffer.from("5b0e9d2c7a1f4e6b9c3d8a2f1e4b7c60", "hex");

/**
 * UUID v5 xác định từ (ideaId, chunkIndex). Qdrant chỉ nhận số nguyên không dấu
 * hoặc UUID làm point ID. Phần cuối của tên luôn là số nguyên nên hai cặp giá
 * trị khác nhau không thể sinh cùng chuỗi tên, kể cả khi ideaId chứa dấu ":".
 */
export function pointId(ideaId: string, chunkIndex: number): string {
  const bytes = Buffer.from(
    createHash("sha1")
      .update(POINT_ID_NAMESPACE)
      .update(`${ideaId}:${chunkIndex}`)
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/** Kiểm point trước khi ghi; dùng chung cho mọi implementation. */
export function assertValidPoint(point: VectorPoint, dimensions: number): void {
  const { payload } = point;
  const valid =
    typeof payload === "object" &&
    payload !== null &&
    typeof payload.ideaId === "string" &&
    payload.ideaId.length > 0 &&
    Number.isInteger(payload.chunkIndex) &&
    payload.chunkIndex >= 0 &&
    Number.isInteger(payload.chunkCount) &&
    payload.chunkCount > payload.chunkIndex &&
    Array.isArray(point.vector) &&
    point.vector.length === dimensions &&
    point.vector.every((value) => Number.isFinite(value)) &&
    point.id === pointId(payload.ideaId, payload.chunkIndex);

  if (!valid) {
    throw new VectorStoreError(
      "INVALID_POINT",
      "Point không hợp lệ: thiếu ideaId hoặc chunk sai, sai số chiều vector, hoặc id không khớp pointId()",
    );
  }
}

/** Store trong bộ nhớ cho test, seed và QDRANT_MOCK_MODE. Không bền vững. */
export class InMemoryVectorStore implements VectorStore {
  private readonly points = new Map<string, VectorPoint>();
  private readonly dimensions: number;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }

  async ensureCollection(): Promise<void> {}

  async upsertChunks(points: VectorPoint[]): Promise<void> {
    for (const point of points) assertValidPoint(point, this.dimensions);
    for (const point of points) {
      this.points.set(point.id, structuredClone(point));
    }
  }

  async scrollAll(options: { maxPoints?: number } = {}): Promise<ScrollResult> {
    const maxPoints = options.maxPoints ?? DEFAULT_MAX_SCROLL_POINTS;
    const sorted = [...this.points.values()].sort(
      (a, b) =>
        a.payload.ideaId.localeCompare(b.payload.ideaId) ||
        a.payload.chunkIndex - b.payload.chunkIndex,
    );
    return {
      points: sorted
        .slice(0, maxPoints)
        .map((point) => ({ id: point.id, payload: structuredClone(point.payload) })),
      truncated: sorted.length > maxPoints,
    };
  }

  async deleteIdea(ideaId: string): Promise<void> {
    assertIdeaId(ideaId);
    for (const [id, point] of this.points) {
      if (point.payload.ideaId === ideaId) this.points.delete(id);
    }
  }

  async deleteChunksFrom(ideaId: string, fromChunkIndex: number): Promise<void> {
    assertChunkRange(ideaId, fromChunkIndex);
    for (const [id, point] of this.points) {
      if (point.payload.ideaId === ideaId && point.payload.chunkIndex >= fromChunkIndex) {
        this.points.delete(id);
      }
    }
  }
}

/** Kiểm ideaId của thao tác xoá; dùng chung cho mọi implementation. */
export function assertIdeaId(ideaId: string): void {
  if (typeof ideaId !== "string" || ideaId.length === 0) {
    throw new VectorStoreError("INVALID_POINT", "ideaId không được rỗng");
  }
}

/** Kiểm tham số của deleteChunksFrom; dùng chung cho mọi implementation. */
export function assertChunkRange(ideaId: string, fromChunkIndex: number): void {
  if (
    typeof ideaId !== "string" ||
    ideaId.length === 0 ||
    !Number.isInteger(fromChunkIndex) ||
    fromChunkIndex < 0
  ) {
    throw new VectorStoreError(
      "INVALID_POINT",
      "ideaId không được rỗng và chunkIndex phải là số nguyên không âm",
    );
  }
}
