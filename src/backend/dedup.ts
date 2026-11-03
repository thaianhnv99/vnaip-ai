/**
 * UNRESOLVED: "solution" là type duy nhất đã xác nhận trong schema hiện tại.
 * Mở rộng union này cùng lúc với inputSchema/outputSchema khi nghiệp vụ xác
 * nhận thêm type khác.
 */
export type RecordType = "solution";

export interface DedupInput {
  type: RecordType;
  title: string;
  content: string;
  excludeId?: string;
  parentSolutionId?: string;
}

export interface Candidate {
  id: string;
  type: RecordType;
  title: string;
  content: string;
}

export interface Match {
  id: string;
  type: RecordType;
  /**
   * percent (0..100, integer) là giá trị chuẩn do model sinh ra. score (0..1)
   * luôn được suy ra từ percent (score = percent / 100) ở checkDuplicates(),
   * không phải ngược lại — model không còn được tin trực tiếp trên score.
   */
  percent: number;
  score: number; // = percent / 100, giữ lại để tương thích phía dùng thang 0..1
  reason: string;
}

export interface DedupOutput {
  matches: Match[];
}

/**
 * Shape thô mà model/adapter chấm điểm trả về, trước khi checkDuplicates()
 * validate và gán lại type/score. Model không cần (và không nên) tự trả
 * type/score — percent là giá trị chuẩn duy nhất cần sinh ra.
 */
export interface RawModelMatch {
  id: string;
  percent: number;
  reason: string;
}

/**
 * Lỗi nghiệp vụ có mã ổn định để tool-routes map sang HTTP/JSON đúng contract.
 * Không bao giờ đưa nội dung hồ sơ hoặc chi tiết downstream nhạy cảm vào message.
 */
export class DedupError extends Error {
  readonly code:
    | "INVALID_INPUT"
    | "CANDIDATES_UNAVAILABLE"
    | "SCORING_UNAVAILABLE";

  constructor(
    code: DedupError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.code = code;
    this.name = "DedupError";
  }
}

/**
 * Context đã được middleware xác thực của SotaAgents kiểm chứng.
 * Không lấy trực tiếp các giá trị này từ request body.
 */
export interface VerifiedContext {
  organizationId: string;
  workspaceId: string;
}

/**
 * Các kết nối bên ngoài được truyền vào để dễ thay thế và kiểm thử.
 */
export interface DedupDependencies {
  findCandidates(
    input: DedupInput,
    context: VerifiedContext,
    options: { limit: number },
  ): Promise<Candidate[]>;

  scoreCandidates(
    input: DedupInput,
    candidates: Candidate[],
  ): Promise<RawModelMatch[]>;
}

export interface CheckDuplicatesOptions {
  /**
   * Số ứng viên tối đa lấy từ VNAIP BE để chấm điểm.
   * UNRESOLVED: 30 là giá trị khởi điểm chưa tối ưu, cấu hình qua env
   * (xem VNAIP_CANDIDATE_LIMIT trong server.ts / vnaip-client.ts).
   */
  candidateLimit: number;
}

export async function checkDuplicates(
  input: DedupInput,
  context: VerifiedContext,
  deps: DedupDependencies,
  options: CheckDuplicatesOptions,
): Promise<DedupOutput> {
  if (!input.type || !input.title?.trim() || !input.content?.trim()) {
    throw new DedupError("INVALID_INPUT", "type, title và content là bắt buộc");
  }

  // Bước 1: lấy ứng viên từ VNAIP BE. Nếu adapter lỗi, lỗi phải propagate —
  // không bao giờ biến lỗi lấy ứng viên thành "không có hồ sơ trùng".
  let candidates: Candidate[];
  try {
    candidates = await deps.findCandidates(input, context, {
      limit: options.candidateLimit,
    });
  } catch (error) {
    throw new DedupError(
      "CANDIDATES_UNAVAILABLE",
      "Không lấy được danh sách ứng viên từ VNAIP",
      { cause: error },
    );
  }

  if (candidates.length === 0) {
    return { matches: [] };
  }

  // Bước 2: model chấm mức tương đồng.
  let rawMatches: RawModelMatch[];
  try {
    rawMatches = await deps.scoreCandidates(input, candidates);
  } catch (error) {
    throw new DedupError(
      "SCORING_UNAVAILABLE",
      "Model chấm điểm tương đồng thất bại",
      { cause: error },
    );
  }

  // Bước 3: chỉ chấp nhận ID thuộc tập ứng viên.
  const candidatesById = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );

  const seen = new Set<string>();
  const matches: Match[] = [];

  for (const match of rawMatches) {
    if (!match || typeof match.id !== "string") continue;

    const candidate = candidatesById.get(match.id);
    const reason = typeof match.reason === "string" ? match.reason.trim() : "";

    // percent là giá trị chuẩn do model sinh ra; score luôn được suy ra từ
    // percent (score = percent / 100) — score thô do model trả (nếu có) KHÔNG
    // được tin, để tránh 2 số lệch nhau khi model sinh không nhất quán.
    if (
      !candidate ||
      seen.has(match.id) ||
      !Number.isInteger(match.percent) ||
      match.percent < 0 ||
      match.percent > 100 ||
      reason.length === 0
    ) {
      continue;
    }

    seen.add(match.id);

    matches.push({
      id: candidate.id,
      type: candidate.type, // Lấy từ VNAIP, không tin type do model trả về.
      percent: match.percent,
      score: match.percent / 100,
      reason: reason.slice(0, 1000),
    });
  }

  matches.sort((a, b) => b.percent - a.percent);

  // outputSchema giới hạn maxItems: 30. UNRESOLVED: nghiệp vụ chưa xác nhận có
  // nên cắt ở đây hay trả toàn bộ kết quả hợp lệ đã chấm; tạm cắt theo điểm cao
  // nhất để luôn tuân thủ schema.
  return { matches: matches.slice(0, 30) };
}
