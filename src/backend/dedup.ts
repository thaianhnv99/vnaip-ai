import { isRecordType, RECORD_TYPES_LABEL, type RecordType } from "./record-type.js";

/**
 * Ba type hợp lệ là ideas / solutions / initiatives (record-type.ts). Giữ export
 * lại ở đây để các chỗ đã import từ dedup.ts không phải đổi.
 */
export type { RecordType };

export interface DedupInput {
  type: RecordType;
  title: string;
  content: string;
  /** Các `id` sáng kiến cần loại khỏi tập ứng viên (ví dụ chính hồ sơ đang sửa). */
  excludeIds?: string[];
  /** Hiện chưa được dùng để lọc ứng viên (vai trò chưa được nghiệp vụ xác nhận). */
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
    | "CANDIDATE_LIMIT_EXCEEDED"
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

/** Ngân sách thời gian của một lời gọi chấm điểm. */
export interface ScoreOptions {
  /** Mốc tuyệt đối (epoch ms) mà lời gọi phải xong; quá mốc thì dừng và báo lỗi. */
  deadlineAt: number;
}

/**
 * Các kết nối bên ngoài được truyền vào để dễ thay thế và kiểm thử.
 *
 * Không có tham số tenant: từ 2026-11-04 không còn `datasetKey`, nên việc giới hạn
 * ai được gọi tool nằm ở tầng route (caller-policy.ts, dựa trên claims đã xác
 * thực), không phải ở đây. Dữ liệu được tách theo `type`: mỗi type một collection.
 */
export interface DedupDependencies {
  /**
   * Trả MỌI sáng kiến của ĐÚNG `input.type` (hướng A, không tìm theo vector), đọc
   * từ collection riêng của type đó. Không được đọc collection của type khác rồi
   * lọc lại. Phải ném lỗi khi không đọc được hết dữ liệu; không bao giờ trả danh
   * sách bị cắt như thể đầy đủ.
   */
  findCandidates(input: DedupInput): Promise<Candidate[]>;

  scoreCandidates(
    input: DedupInput,
    candidates: Candidate[],
    options: ScoreOptions,
  ): Promise<RawModelMatch[]>;
}

export interface CheckDuplicatesOptions {
  /**
   * Số sáng kiến tối đa (sau khi loại `excludeIds`) được gửi cho model. Vượt trần
   * thì báo lỗi CANDIDATE_LIMIT_EXCEEDED thay vì cắt: cắt tuỳ ý (không có độ
   * tương đồng để xếp hạng) có thể bỏ sót đúng sáng kiến trùng và trả "không
   * trùng" sai. Chạm trần là tín hiệu để chuyển sang hướng B (top-k theo vector).
   */
  candidateLimit: number;
  /** Tổng thời gian cho cả lời gọi (lấy ứng viên + chấm điểm), nhỏ hơn timeoutMs của tool. */
  deadlineMs: number;
}

export async function checkDuplicates(
  input: DedupInput,
  deps: DedupDependencies,
  options: CheckDuplicatesOptions,
): Promise<DedupOutput> {
  if (!input.title?.trim() || !input.content?.trim()) {
    throw new DedupError("INVALID_INPUT", "type, title và content là bắt buộc");
  }
  if (!isRecordType(input.type)) {
    throw new DedupError("INVALID_INPUT", `type phải là một trong: ${RECORD_TYPES_LABEL}`);
  }

  const deadlineAt = Date.now() + options.deadlineMs;

  // Bước 1: lấy ứng viên. Nếu adapter lỗi, lỗi phải propagate — không bao giờ biến
  // lỗi lấy ứng viên thành "không có hồ sơ trùng".
  let found: Candidate[];
  try {
    found = await deps.findCandidates(input);
  } catch (error) {
    if (error instanceof DedupError) throw error;
    throw new DedupError(
      "CANDIDATES_UNAVAILABLE",
      "Không lấy được danh sách sáng kiến để so sánh",
      { cause: error },
    );
  }

  // Chốt chặn cuối cùng của việc tách theo type. Adapter đã phải đọc đúng collection
  // của type này; nếu vẫn lọt ứng viên khác type thì đó là lỗi của adapter. Fail
  // closed: không so sánh chéo type, và không lặng lẽ bỏ ứng viên đi rồi trả kết
  // quả như thể đủ dữ liệu.
  if (found.some((candidate) => candidate.type !== input.type)) {
    throw new DedupError(
      "CANDIDATES_UNAVAILABLE",
      "Nguồn ứng viên trả sáng kiến khác type với yêu cầu",
    );
  }

  // Loại excludeIds ở đây (quy tắc nghiệp vụ) để không phụ thuộc adapter có làm hay không.
  const excluded = new Set(input.excludeIds ?? []);
  const candidates = found.filter((candidate) => !excluded.has(candidate.id));

  if (candidates.length > options.candidateLimit) {
    throw new DedupError(
      "CANDIDATE_LIMIT_EXCEEDED",
      "Số sáng kiến cần so sánh vượt trần cho phép",
    );
  }

  if (candidates.length === 0) {
    return { matches: [] };
  }

  // Bước 2: model chấm mức tương đồng.
  let rawMatches: RawModelMatch[];
  try {
    rawMatches = await deps.scoreCandidates(input, candidates, { deadlineAt });
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
      type: candidate.type, // Lấy từ dữ liệu đã index, không tin type do model trả về.
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
