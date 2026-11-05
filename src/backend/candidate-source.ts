import { DedupError, type Candidate, type DedupDependencies } from "./dedup.js";
import type { RecordType } from "./record-type.js";
import {
  DEFAULT_MAX_SCROLL_POINTS,
  type StoredChunk,
  type VectorStores,
} from "./vector-store.js";

/**
 * Nguồn ứng viên của luồng kiểm tra trùng (hướng A): đọc MỌI chunk trong collection
 * CỦA ĐÚNG type được hỏi rồi gom lại theo `ideaId`. Collection của type khác không
 * bao giờ được mở ra (type được tách ở tầng lưu trữ, không phải đọc hết rồi lọc).
 * Không dùng vector, nên không cần embedding ở luồng này (quyết định GĐ0 #2).
 *
 * Không còn `datasetKey`, nên hàm này không lọc theo tenant; ai được gọi tool do
 * caller-policy.ts quyết định.
 */

export interface CandidateSourceOptions {
  /** Số chunk tối đa đọc từ store; chạm trần thì báo lỗi, không trả dữ liệu thiếu. */
  maxPoints?: number;
  /**
   * Chạy trước lần đọc đầu tiên của MỘT type (ví dụ ensureCollection của collection
   * type đó); lỗi thì lần sau thử lại.
   */
  ensureReady?: (type: RecordType) => Promise<void>;
  log?: (event: string, details: Record<string, unknown>) => void;
}

export function createQdrantCandidateFinder(
  stores: VectorStores,
  options: CandidateSourceOptions = {},
): DedupDependencies["findCandidates"] {
  const maxPoints = options.maxPoints ?? DEFAULT_MAX_SCROLL_POINTS;

  return async function findCandidates(input) {
    const startedAt = performance.now();
    // Chọn collection theo type TRƯỚC mọi thao tác: type lạ thì dừng ở đây.
    const store = stores.forType(input.type);
    await options.ensureReady?.(input.type);

    const { points, truncated } = await store.scrollAll({ maxPoints });
    if (truncated) {
      // Thiếu chunk nghĩa là thiếu sáng kiến; trả phần đã đọc được sẽ cho kết quả
      // "không trùng" sai, nên coi như vượt trần.
      throw new DedupError(
        "CANDIDATE_LIMIT_EXCEEDED",
        "Kho dữ liệu vượt giới hạn đọc của luồng kiểm tra trùng",
      );
    }

    const candidates = groupChunksIntoCandidates(points, input.type);

    // Collection của type này không được chứa chunk mang type khác. Nếu có thì dữ liệu
    // đã bị ghi lệch (sửa tay, migrate sai...): bỏ qua chúng (xem groupChunksIntoCandidates)
    // và để lại dấu vết trong log thay vì im lặng.
    const foreign = points.filter((chunk) => chunk.payload.type !== input.type).length;
    if (foreign > 0) {
      options.log?.("candidates_foreign_type_ignored", { type: input.type, chunks: foreign });
    }

    options.log?.("candidates_loaded", {
      type: input.type,
      chunks: points.length,
      ideas: candidates.length,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return candidates;
  };
}

/**
 * Ghép các chunk của cùng một sáng kiến lại thành một ứng viên.
 *
 * Index lại một sáng kiến ghi đè chunk 0..n-1 rồi mới xoá chunk thừa (xem
 * index-job.ts), nên lúc đọc có thể thấy chunk của hai lần index lẫn nhau. Quy
 * tắc: lấy lần index MỚI NHẤT (theo `indexedAt`) làm chuẩn cho tiêu đề và số
 * chunk, bỏ chunk có chỉ số >= số chunk đó (đuôi cũ chưa kịp xoá), và nếu một chỉ
 * số có nhiều bản thì lấy bản mới hơn. Không bỏ cả sáng kiến chỉ vì thiếu chunk:
 * làm vậy sẽ che mất một sáng kiến có thể trùng.
 *
 * `chunks` phải đến từ collection của `type`; việc tách type KHÔNG dựa vào dòng lọc
 * bên dưới. Dòng đó chỉ là chốt chặn thứ hai: chunk mang type khác (không thể xuất
 * hiện nếu dữ liệu được ghi qua store) không bao giờ trở thành ứng viên của `type`.
 */
export function groupChunksIntoCandidates(
  chunks: StoredChunk[],
  type: RecordType,
): Candidate[] {
  const byIdea = new Map<string, StoredChunk[]>();
  for (const chunk of chunks) {
    if (chunk.payload.type !== type) continue;
    const list = byIdea.get(chunk.payload.ideaId);
    if (list) list.push(chunk);
    else byIdea.set(chunk.payload.ideaId, [chunk]);
  }

  const candidates: Candidate[] = [];
  for (const [ideaId, list] of byIdea) {
    const newest = list.reduce((best, chunk) =>
      chunk.payload.indexedAt > best.payload.indexedAt ? chunk : best,
    );

    const byIndex = new Map<number, StoredChunk>();
    for (const chunk of list) {
      if (chunk.payload.chunkIndex >= newest.payload.chunkCount) continue;
      const current = byIndex.get(chunk.payload.chunkIndex);
      if (!current || chunk.payload.indexedAt > current.payload.indexedAt) {
        byIndex.set(chunk.payload.chunkIndex, chunk);
      }
    }

    const content = [...byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, chunk]) => chunk.payload.content)
      .join("\n\n");

    candidates.push({ id: ideaId, type, title: newest.payload.title, content });
  }

  // Thứ tự xác định để chia batch ổn định giữa các lần gọi.
  return candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
