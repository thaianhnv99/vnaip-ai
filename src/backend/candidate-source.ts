import { DedupError, type Candidate, type DedupDependencies, type RecordType } from "./dedup.js";
import {
  DEFAULT_MAX_SCROLL_POINTS,
  type StoredChunk,
  type VectorStore,
} from "./vector-store.js";

/**
 * Nguồn ứng viên của luồng kiểm tra trùng (hướng A): đọc MỌI chunk trong
 * collection của môi trường rồi gom lại theo `ideaId`. Không dùng vector, nên
 * không cần embedding ở luồng này (quyết định GĐ0 #2).
 *
 * Mọi sáng kiến nằm chung một tập dữ liệu (không còn `datasetKey`), nên hàm này
 * không lọc theo tenant; ai được gọi tool do caller-policy.ts quyết định.
 */

export interface CandidateSourceOptions {
  /** Số chunk tối đa đọc từ store; chạm trần thì báo lỗi, không trả dữ liệu thiếu. */
  maxPoints?: number;
  /** Chạy trước lần đọc đầu tiên (ví dụ ensureCollection); lỗi thì lần sau thử lại. */
  ensureReady?: () => Promise<void>;
  log?: (event: string, details: Record<string, unknown>) => void;
}

export function createQdrantCandidateFinder(
  store: VectorStore,
  options: CandidateSourceOptions = {},
): DedupDependencies["findCandidates"] {
  const maxPoints = options.maxPoints ?? DEFAULT_MAX_SCROLL_POINTS;

  return async function findCandidates(input) {
    const startedAt = performance.now();
    await options.ensureReady?.();

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
    options.log?.("candidates_loaded", {
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
