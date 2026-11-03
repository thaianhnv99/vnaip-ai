import type { Candidate, DedupInput, VerifiedContext } from "./dedup.js";

/**
 * Adapter gọi VNAIP BE để lấy danh sách hồ sơ ứng viên.
 *
 * UNRESOLVED (blocker trước production): API contract thật của VNAIP BE
 * (endpoint, auth server-to-server, filter fields, response shape, phân
 * trang) CHƯA được xác nhận. `findVnaipCandidates` dưới đây gọi một endpoint
 * giả định qua `VNAIP_BE_BASE_URL` để minh hoạ hợp đồng mong đợi. Thay thế
 * bằng contract thật khi có, và xoá `createMockVnaipClient` khỏi đường dẫn
 * production.
 *
 * Middleware xác thực invocation JWT của SotaAgents KHÔNG được dùng cho
 * chiều gọi này. VNAIP_BE_SERVICE_TOKEN (hoặc cơ chế auth server-to-server
 * thật) là một bí mật riêng, không liên quan tới Sota Core.
 */

export interface VnaipClientConfig {
  baseUrl: string;
  serviceToken: string;
  timeoutMs: number;
}

export class VnaipClientError extends Error {
  readonly code: "TIMEOUT" | "AUTH_ERROR" | "NETWORK_ERROR" | "BAD_RESPONSE";

  constructor(
    code: VnaipClientError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.code = code;
    this.name = "VnaipClientError";
  }
}

export function loadVnaipClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): VnaipClientConfig {
  const baseUrl = env.VNAIP_BE_BASE_URL ?? "";
  const serviceToken = env.VNAIP_BE_SERVICE_TOKEN ?? "";
  const timeoutMs = Number(env.VNAIP_BE_TIMEOUT_MS ?? 5000);
  return {
    baseUrl,
    serviceToken,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000,
  };
}

/**
 * Gọi API VNAIP BE thật. UNRESOLVED: path, tên field filter, và response
 * shape dưới đây là giả định rõ ràng cho tới khi có API contract thật.
 */
export async function findVnaipCandidates(
  input: DedupInput,
  context: VerifiedContext,
  options: { limit: number },
  config: VnaipClientConfig,
): Promise<Candidate[]> {
  if (!config.baseUrl) {
    throw new VnaipClientError(
      "AUTH_ERROR",
      "VNAIP BE chưa được cấu hình " +
        "(thiếu VNAIP_BE_BASE_URL hoặc VNAIP_BE_SERVICE_TOKEN)",
    );
  }

  const url = new URL("/api/records/candidates", config.baseUrl);

  url.searchParams.set("type", input.type);
  url.searchParams.set("limit", String(options.limit));

  if (input.excludeId) {
    url.searchParams.set("excludeId", input.excludeId);
  }

  if (input.parentSolutionId) {
    url.searchParams.set("parentSolutionId", input.parentSolutionId);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      // headers: {
      //   authorization: `Bearer ${config.serviceToken}`,
      // },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new VnaipClientError(
        "AUTH_ERROR",
        `VNAIP BE từ chối xác thực (HTTP ${response.status})`,
      );
    }

    if (!response.ok) {
      throw new VnaipClientError(
        "NETWORK_ERROR",
        `VNAIP BE trả lỗi HTTP ${response.status}`,
      );
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch (error) {
      // Để lỗi timeout được xử lý ở catch bên ngoài.
      if (controller.signal.aborted) {
        throw error;
      }

      throw new VnaipClientError(
        "BAD_RESPONSE",
        "VNAIP BE trả response không phải JSON hợp lệ",
        { cause: error },
      );
    }

    return parseCandidates(body);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new VnaipClientError(
        "TIMEOUT",
        "Gọi VNAIP BE quá thời gian cho phép",
        { cause: error },
      );
    }

    // Giữ nguyên các lỗi đã được phân loại phía trên.
    if (error instanceof VnaipClientError) {
      throw error;
    }

    throw new VnaipClientError(
      "NETWORK_ERROR",
      "Không thể kết nối tới VNAIP BE",
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}

function parseCandidates(body: unknown): Candidate[] {
  const items = isRecord(body) && Array.isArray(body.data) ? body.data : null;
  if (!items) {
    throw new VnaipClientError(
      "BAD_RESPONSE",
      "VNAIP BE trả response sai định dạng (thiếu items[])",
    );
  }

  const candidates: Candidate[] = [];
  for (const item of items) {
    if (
      isRecord(item) &&
      typeof item.id === "string" &&
      item.id.length > 0 &&
      item.type === "solution" &&
      typeof item.title === "string" &&
      typeof item.content === "string"
    ) {
      candidates.push({
        id: item.id,
        type: "solution",
        title: item.title,
        content: item.content,
      });
    }
    // Bỏ qua item sai định dạng thay vì làm hỏng toàn bộ response — nhưng
    // không coi một response hoàn toàn trống/hỏng là "không có ứng viên"
    // (điều đó được quyết định ở items.length === 0 phía trên, không phải ở đây).
  }

  return candidates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Mock client để phát triển/test khi chưa có API contract thật.
 * KHÔNG dùng trong production — xem biến môi trường VNAIP_MOCK_MODE.
 *
 * Pool lấy từ `record-samples-library.js` (data mẫu màn "Thư viện" của FE
 * prototype), lọc còn các hồ sơ `type: 'solution'` — type duy nhất mà
 * dedup-input/output schema hiện hỗ trợ. Các hồ sơ `type: 'idea'` trong file
 * gốc (YT-2026-...) không thuộc phạm vi tool này nên bị loại khỏi pool.
 */
export function createMockVnaipClient() {
  const pool: Candidate[] = [
    {
      id: "GP-2026-0022",
      type: "solution",
      title: "Ứng dụng di động báo cáo sự cố mặt đất theo thời gian thực",
      content:
        "Xây dựng ứng dụng di động cho nhân viên mặt đất báo cáo sự cố ngay tại vị trí phát sinh, kèm ảnh chụp và định vị, gửi thẳng về trung tâm điều hành.",
    },
    {
      id: "GP-2026-0051",
      type: "solution",
      title: "Nền tảng dữ liệu dùng chung cho các khối nghiệp vụ",
      content:
        "Xây dựng nền tảng lưu trữ và chia sẻ dữ liệu dùng chung giữa các khối nghiệp vụ, thay thế việc trao đổi file rời rạc qua email.",
    },
    {
      id: "GP-2026-0038",
      type: "solution",
      title: "Chuẩn hóa quy trình xử lý yêu cầu khách hàng đa kênh",
      content:
        "Xây dựng quy trình tiếp nhận và xử lý yêu cầu khách hàng thống nhất giữa các kênh (điện thoại, email, mạng xã hội), có SLA rõ ràng theo từng loại yêu cầu.",
    },
  ];

  return async function findCandidatesMock(
    input: DedupInput,
    _context: VerifiedContext,
    options: { limit: number },
  ): Promise<Candidate[]> {
    return pool
      .filter((candidate) => candidate.id !== input.excludeId)
      .slice(0, options.limit);
  };
}
