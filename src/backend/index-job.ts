import { chunkText, DEFAULT_CHUNK_CHARS } from "./chunker.js";
import type { Embedder } from "./openrouter-embeddings.js";
import { pointId, type VectorPoint, type VectorStore } from "./vector-store.js";
import type { JobHandler, JobOutcome, RetryPolicy } from "./job-queue.js";
import { decideOutcome } from "./job-queue.js";

/**
 * Job index một sáng kiến. Job mang đủ thông tin để worker làm việc mà không
 * cần hỏi lại BE (id, type, title, content, metadata, fileRef); vì chứa nội dung
 * sáng kiến nên Redis phải nằm trong mạng tin cậy hoặc dùng TLS.
 */
export interface IndexJob {
  jobId: string;
  ideaId: string;
  type: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  receivedAt: string;
  /**
   * #TODO(MinIO): tham chiếu file trong MinIO của VNAIP. VNAIP chưa có MinIO nên
   * worker chưa tải hay xử lý file; chỉ ghi log là đã bỏ qua.
   */
  fileRef?: string | Record<string, unknown>;
}

export class IndexJobError extends Error {
  readonly code = "TOO_LARGE" as const;
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "IndexJobError";
  }
}

export interface IndexDependencies {
  embed: Embedder;
  store: VectorStore;
  /** Tên model, ghi vào payload để biết khi nào cần reindex. */
  embeddingModel: string;
  chunkChars?: number;
  maxChunks?: number;
  now?: () => Date;
  /** Chạy trước job đầu tiên (ví dụ tạo collection); lỗi thì job được retry. */
  ensureReady?: () => Promise<void>;
}

export const DEFAULT_MAX_CHUNKS = 400;

/**
 * Idempotent: chạy lại cùng job cho cùng kết quả. Thứ tự có chủ đích:
 * embed trước (dễ lỗi nhất, chưa đụng dữ liệu), upsert chunk mới, rồi mới xoá
 * chunk thừa, nên không có lúc nào sáng kiến biến mất khỏi Qdrant.
 */
export async function processIndexJob(
  job: IndexJob,
  deps: IndexDependencies,
): Promise<{ chunks: number }> {
  const chunks = chunkText(job.content, {
    maxChars: deps.chunkChars ?? DEFAULT_CHUNK_CHARS,
  });
  if (chunks.length === 0) {
    throw new IndexJobError("Sáng kiến không có nội dung để index");
  }
  if (chunks.length > (deps.maxChunks ?? DEFAULT_MAX_CHUNKS)) {
    throw new IndexJobError("Sáng kiến quá dài để index");
  }

  await deps.ensureReady?.();

  // Mỗi vector mang cả tiêu đề để chunk nào cũng giữ ngữ cảnh của sáng kiến.
  const vectors = await deps.embed(
    chunks.map((chunk) => `${job.title}\n\n${chunk}`),
  );

  const indexedAt = (deps.now?.() ?? new Date()).toISOString();
  const points: VectorPoint[] = chunks.map((content, chunkIndex) => ({
    id: pointId(job.ideaId, chunkIndex),
    vector: vectors[chunkIndex]!,
    payload: {
      ideaId: job.ideaId,
      type: job.type,
      title: job.title,
      chunkIndex,
      chunkCount: chunks.length,
      content,
      metadata: job.metadata,
      embeddingModel: deps.embeddingModel,
      indexedAt,
    },
  }));

  await deps.store.upsertChunks(points);
  await deps.store.deleteChunksFrom(job.ideaId, chunks.length);
  return { chunks: chunks.length };
}

export type JobLogger = (
  level: "info" | "error",
  event: string,
  details: Record<string, unknown>,
) => void;

/**
 * Biến processIndexJob thành handler cho queue: lỗi được phân loại thành
 * retry hoặc dead-letter. Log chỉ chứa định danh và mã lỗi, không có
 * title/content/fileRef.
 */
export function createIndexJobHandler(
  deps: IndexDependencies,
  policy: RetryPolicy,
  log: JobLogger,
): JobHandler<IndexJob> {
  return async (job, { attempt }): Promise<JobOutcome> => {
    const startedAt = performance.now();
    const base = {
      jobId: job.jobId,
      ideaId: job.ideaId,
      attempt,
      // #TODO(MinIO): khi có MinIO, tải file theo fileRef (quyền chỉ đọc), trích
      // text, chia chunk, rồi xoá file tạm. Hiện chỉ ghi nhận là đã bỏ qua.
      ...(job.fileRef !== undefined ? { fileSkipped: true } : {}),
    };
    try {
      const { chunks } = await processIndexJob(job, deps);
      log("info", "index_job_done", {
        ...base,
        chunks,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return { status: "done" };
    } catch (error) {
      const outcome = decideOutcome(error, attempt, policy);
      log("error", "index_job_failed", {
        ...base,
        errorCode: (error as { code?: string }).code ?? "UNKNOWN",
        outcome: outcome.status,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return outcome;
    }
  };
}
