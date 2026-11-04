import {
  DEFAULT_MAX_SCROLL_POINTS,
  InMemoryVectorStore,
  VectorStoreError,
  assertChunkRange,
  assertIdeaId,
  assertValidPoint,
  type IdeaChunkPayload,
  type ScrollResult,
  type StoredChunk,
  type VectorPoint,
  type VectorStore,
} from "./vector-store.js";

/**
 * Qdrant qua REST. Chỉ dùng fetch để không thêm phụ thuộc và dễ test bằng
 * server giả.
 *
 * Toàn bộ collection là một tập dữ liệu duy nhất (không còn `datasetKey`, xem
 * vector-store.ts). Mọi thao tác xoá phải có điều kiện `ideaId` (đi qua
 * `ideaFilter()`), nên không có đường xoá "cả collection" trong code. Thông báo
 * lỗi chỉ chứa mã HTTP, không chứa API key, payload hay body phản hồi.
 */

export interface QdrantConfig {
  url: string;
  /** Bắt buộc với host không phải localhost. */
  apiKey: string;
  collection: string;
  /** Số chiều vector của collection (phải khớp embedding model). */
  dimensions: number;
  timeoutMs: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const COLLECTION_NAME = /^[A-Za-z0-9_-]{1,255}$/;
const PAGE_SIZE = 256;
const UPSERT_BATCH_SIZE = 100;
/**
 * Các trường cần payload index vì truy vấn lọc theo chúng. Qdrant Cloud từ
 * chối lọc theo trường chưa có index (HTTP 400 "Index required but not found"),
 * kể cả lọc `range` của deleteChunksFrom trên chunkIndex.
 */
const INDEXED_FIELDS: ReadonlyArray<{ field: string; schema: "keyword" | "integer" }> = [
  { field: "ideaId", schema: "keyword" },
  { field: "chunkIndex", schema: "integer" },
];

export function loadQdrantConfig(
  env: NodeJS.ProcessEnv = process.env,
  dimensions: number,
): QdrantConfig {
  const rawUrl = (env.QDRANT_URL ?? "").trim().replace(/\/+$/, "");
  const collection = env.QDRANT_COLLECTION ?? "";
  const apiKey = env.QDRANT_API_KEY ?? "";
  if (!rawUrl || !collection) {
    throw new VectorStoreError(
      "NOT_CONFIGURED",
      "Qdrant chưa được cấu hình (thiếu QDRANT_URL hoặc QDRANT_COLLECTION)",
    );
  }
  if (!COLLECTION_NAME.test(collection)) {
    throw new VectorStoreError(
      "NOT_CONFIGURED",
      "QDRANT_COLLECTION chỉ gồm chữ, số, dấu gạch ngang và gạch dưới",
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new VectorStoreError("NOT_CONFIGURED", "QDRANT_URL không hợp lệ", {
      cause: error,
    });
  }
  const isLocal = LOCAL_HOSTS.has(url.hostname);
  if (!isLocal && url.protocol !== "https:") {
    throw new VectorStoreError(
      "NOT_CONFIGURED",
      "QDRANT_URL phải dùng https (chỉ localhost được dùng http)",
    );
  }
  if (!isLocal && !apiKey) {
    throw new VectorStoreError(
      "NOT_CONFIGURED",
      "Thiếu QDRANT_API_KEY cho Qdrant không chạy trên localhost",
    );
  }

  const timeoutMs = Number(env.QDRANT_TIMEOUT_MS);
  return {
    url: rawUrl,
    apiKey,
    collection,
    dimensions,
    timeoutMs: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000,
  };
}

/**
 * Kho trong bộ nhớ dùng chung trong một tiến trình (theo số chiều) cho
 * QDRANT_MOCK_MODE: khi web chạy worker ngay trong tiến trình (QUEUE_MOCK_MODE=true),
 * sáng kiến được index qua webhook phải hiện ra ở tool check-duplicates. Nếu mỗi nơi
 * tự tạo một kho riêng thì tool luôn thấy kho rỗng và trả "không trùng" cho mọi thứ.
 */
const sharedMockStores = new Map<number, InMemoryVectorStore>();

function sharedMockStore(dimensions: number): InMemoryVectorStore {
  let store = sharedMockStores.get(dimensions);
  if (!store) {
    store = new InMemoryVectorStore(dimensions);
    sharedMockStores.set(dimensions, store);
  }
  return store;
}

/**
 * QDRANT_MOCK_MODE=true dùng store trong bộ nhớ (chung trong tiến trình, xem
 * sharedMockStore; không chia sẻ được giữa web và worker chạy tiến trình riêng).
 * Biến không đặt nghĩa là dùng Qdrant thật (và báo NOT_CONFIGURED nếu thiếu cấu hình).
 */
export function createVectorStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  dimensions: number,
): VectorStore {
  return env.QDRANT_MOCK_MODE === "true"
    ? sharedMockStore(dimensions)
    : new QdrantVectorStore(loadQdrantConfig(env, dimensions));
}

type Condition =
  | { key: string; match: { value: string } }
  | { key: string; range: { gte: number } };

/** Nơi DUY NHẤT dựng filter xoá; luôn có điều kiện ideaId. */
function ideaFilter(ideaId: string, extra: Condition[] = []) {
  return {
    must: [{ key: "ideaId", match: { value: ideaId } }, ...extra],
  };
}

export class QdrantVectorStore implements VectorStore {
  private readonly config: QdrantConfig;

  constructor(config: QdrantConfig) {
    this.config = config;
  }

  async ensureCollection(): Promise<void> {
    let info = await this.request("GET", this.collectionPath(), undefined, [404]);
    if (info.status === 404) {
      // 409: tiến trình khác vừa tạo xong; bước đọc lại bên dưới sẽ kiểm tra.
      await this.request(
        "PUT",
        this.collectionPath(),
        { vectors: { size: this.config.dimensions, distance: "Cosine" } },
        [409],
      );
      info = await this.request("GET", this.collectionPath());
    }
    this.verifyCollection(info.result);

    for (const { field, schema } of INDEXED_FIELDS) {
      await this.request("PUT", `${this.collectionPath()}/index?wait=true`, {
        field_name: field,
        field_schema: schema,
      });
    }
  }

  async upsertChunks(points: VectorPoint[]): Promise<void> {
    for (const point of points) assertValidPoint(point, this.config.dimensions);
    for (let start = 0; start < points.length; start += UPSERT_BATCH_SIZE) {
      const batch = points.slice(start, start + UPSERT_BATCH_SIZE);
      await this.request("PUT", `${this.collectionPath()}/points?wait=true`, {
        points: batch.map(({ id, vector, payload }) => ({ id, vector, payload })),
      });
    }
  }

  async scrollAll(options: { maxPoints?: number } = {}): Promise<ScrollResult> {
    const maxPoints = options.maxPoints ?? DEFAULT_MAX_SCROLL_POINTS;
    if (!Number.isInteger(maxPoints) || maxPoints < 1) {
      throw new VectorStoreError("BAD_REQUEST", "maxPoints phải là số nguyên dương");
    }

    const points: StoredChunk[] = [];
    let offset: unknown = undefined;
    for (;;) {
      const limit = Math.min(PAGE_SIZE, maxPoints - points.length);
      const { result } = await this.request(
        "POST",
        `${this.collectionPath()}/points/scroll`,
        {
          limit,
          with_payload: true,
          with_vector: false,
          ...(offset !== undefined ? { offset } : {}),
        },
      );
      const page = parseScrollPage(result);
      points.push(...page.points);

      if (page.nextOffset === null) return { points, truncated: false };
      if (points.length >= maxPoints) return { points, truncated: true };
      if (page.points.length === 0) {
        throw new VectorStoreError(
          "BAD_RESPONSE",
          "Qdrant trả trang rỗng nhưng vẫn báo còn dữ liệu",
        );
      }
      offset = page.nextOffset;
    }
  }

  async deleteIdea(ideaId: string): Promise<void> {
    assertIdeaId(ideaId);
    await this.deleteByFilter(ideaFilter(ideaId));
  }

  async deleteChunksFrom(ideaId: string, fromChunkIndex: number): Promise<void> {
    assertChunkRange(ideaId, fromChunkIndex);
    await this.deleteByFilter(
      ideaFilter(ideaId, [{ key: "chunkIndex", range: { gte: fromChunkIndex } }]),
    );
  }

  private async deleteByFilter(filter: ReturnType<typeof ideaFilter>) {
    await this.request("POST", `${this.collectionPath()}/points/delete?wait=true`, {
      filter,
    });
  }

  private collectionPath(): string {
    return `/collections/${encodeURIComponent(this.config.collection)}`;
  }

  private verifyCollection(result: unknown): void {
    const vectors = dig(result, ["config", "params", "vectors"]);
    const size = isRecord(vectors) ? vectors.size : undefined;
    const distance = isRecord(vectors) ? vectors.distance : undefined;
    if (
      size !== this.config.dimensions ||
      typeof distance !== "string" ||
      distance.toLowerCase() !== "cosine"
    ) {
      throw new VectorStoreError(
        "COLLECTION_MISMATCH",
        `Collection hiện có không khớp cấu hình (cần vector đơn ${this.config.dimensions} chiều, cosine). Đổi embedding model thì phải dùng collection mới và reindex`,
      );
    }
  }

  private async request(
    method: "GET" | "PUT" | "POST",
    path: string,
    body?: unknown,
    tolerate: number[] = [],
  ): Promise<{ status: number; result: unknown }> {
    let response: Response;
    try {
      response = await fetch(`${this.config.url}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { "api-key": this.config.apiKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      throw transportError(error);
    }

    if (tolerate.includes(response.status)) {
      void response.body?.cancel().catch(() => undefined);
      return { status: response.status, result: undefined };
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw statusError(response.status);
    }

    try {
      const json: unknown = await response.json();
      return { status: response.status, result: isRecord(json) ? json.result : undefined };
    } catch (error) {
      if (isTimeout(error)) throw transportError(error);
      throw new VectorStoreError(
        "BAD_RESPONSE",
        "Qdrant trả response không phải JSON hợp lệ",
        { cause: error },
      );
    }
  }
}

function parseScrollPage(result: unknown): { points: StoredChunk[]; nextOffset: unknown } {
  if (!isRecord(result) || !Array.isArray(result.points)) {
    throw new VectorStoreError("BAD_RESPONSE", "Qdrant trả scroll sai định dạng");
  }

  const points = result.points.map((raw: unknown): StoredChunk => {
    if (
      !isRecord(raw) ||
      (typeof raw.id !== "string" && typeof raw.id !== "number") ||
      !isRecord(raw.payload)
    ) {
      throw new VectorStoreError("BAD_RESPONSE", "Qdrant trả point sai định dạng");
    }
    return { id: String(raw.id), payload: toPayload(raw.payload) };
  });

  return { points, nextOffset: result.next_page_offset ?? null };
}

function toPayload(raw: Record<string, unknown>): IdeaChunkPayload {
  if (
    typeof raw.ideaId !== "string" ||
    typeof raw.type !== "string" ||
    typeof raw.title !== "string" ||
    typeof raw.content !== "string" ||
    !Number.isInteger(raw.chunkIndex) ||
    !Number.isInteger(raw.chunkCount) ||
    typeof raw.embeddingModel !== "string" ||
    typeof raw.indexedAt !== "string"
  ) {
    throw new VectorStoreError("BAD_RESPONSE", "Payload của point thiếu trường bắt buộc");
  }
  return {
    ideaId: raw.ideaId,
    type: raw.type,
    title: raw.title,
    chunkIndex: raw.chunkIndex as number,
    chunkCount: raw.chunkCount as number,
    content: raw.content,
    metadata: isRecord(raw.metadata) ? raw.metadata : {},
    embeddingModel: raw.embeddingModel,
    indexedAt: raw.indexedAt,
  };
}

function statusError(status: number): VectorStoreError {
  if (status === 401 || status === 403) {
    return new VectorStoreError("AUTH_ERROR", `Qdrant từ chối xác thực (HTTP ${status})`);
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new VectorStoreError("UPSTREAM_ERROR", `Qdrant tạm thời lỗi (HTTP ${status})`);
  }
  return new VectorStoreError("BAD_REQUEST", `Qdrant từ chối request (HTTP ${status})`);
}

function transportError(error: unknown): VectorStoreError {
  if (isTimeout(error)) {
    return new VectorStoreError("TIMEOUT", "Gọi Qdrant quá thời gian cho phép", {
      cause: error,
    });
  }
  return new VectorStoreError("NETWORK_ERROR", "Không thể kết nối tới Qdrant", {
    cause: error,
  });
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function dig(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
