import type { RequestHandler } from "express";
import {
  checkDuplicates,
  DedupError,
  type DedupDependencies,
} from "./dedup.js";
import { parseDedupInput } from "./validate-input.js";
import { assertValidDedupOutput } from "./validate-output.js";
import {
  findVnaipCandidates,
  loadVnaipClientConfig,
  createMockVnaipClient,
  VnaipClientError,
} from "./vnaip-client.js";
import {
  scoreCandidatesWithLlm,
  loadLlmScorerConfig,
  createMockScorer,
  LlmScorerError,
} from "./llm-scorer.js";
import type { InvocationClaims } from "./sota-auth.js";

/**
 * UNRESOLVED (blocker trước production): VNAIP_MOCK_MODE / LLM_MOCK_MODE
 * mặc định "true" vì chưa có API contract thật. Đổi sang "false" chỉ sau
 * khi VNAIP BE và provider model thật đã được xác nhận và kiểm thử.
 */
function isMockEnabled(name: string, env: NodeJS.ProcessEnv): boolean {
  return (env[name] ?? "true") !== "false";
}

function loadCandidateLimit(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.VNAIP_CANDIDATE_LIMIT ?? 30);
  return Number.isInteger(raw) && raw > 0 && raw <= 200 ? raw : 30;
}

export function buildDependencies(
  env: NodeJS.ProcessEnv = process.env,
): DedupDependencies {
  const useVnaipMock = isMockEnabled("VNAIP_MOCK_MODE", env);
  const useLlmMock = isMockEnabled("LLM_MOCK_MODE", env);

  const vnaipConfig = loadVnaipClientConfig(env);
  const llmConfig = loadLlmScorerConfig(env);

  return {
    findCandidates: useVnaipMock
      ? createMockVnaipClient()
      : (input, context, options) =>
          findVnaipCandidates(input, context, options, vnaipConfig),
    scoreCandidates: useLlmMock
      ? createMockScorer()
      : (input, candidates) =>
          scoreCandidatesWithLlm(input, candidates, llmConfig),
  };
}

export function createCheckDuplicatesHandler(
  deps: DedupDependencies = buildDependencies(),
  env: NodeJS.ProcessEnv = process.env,
): RequestHandler {
  const candidateLimit = loadCandidateLimit(env);

  return async (request, response) => {
    const claims = response.locals.sota as InvocationClaims;
    const requestId =
      response.getHeader("x-request-id") ??
      request.header("x-request-id") ??
      null;

    let input;
    try {
      const envelopeBody = isRecord(request.body?.body)
        ? request.body.body
        : request.body;
      input = parseDedupInput(envelopeBody?.input ?? envelopeBody);
    } catch (error) {
      response.status(400).json({
        code: "INVALID_INPUT",
        message: error instanceof Error ? error.message : "Input không hợp lệ",
      });
      return;
    }

    try {
      const output = await checkDuplicates(
        input,
        { organizationId: claims.oid, workspaceId: claims.wid },
        deps,
        { candidateLimit },
      );

      assertValidDedupOutput(output);
      response.json(output);
    } catch (error) {
      const { status, code, message } = mapErrorToResponse(error);
      log("error", "check_duplicates_failed", { requestId, code, message });
      response.status(status).json({ code, message });
    }
  };
}

function mapErrorToResponse(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof DedupError) {
    switch (error.code) {
      case "INVALID_INPUT":
        return { status: 400, code: error.code, message: error.message };
      case "CANDIDATES_UNAVAILABLE":
        return {
          status: 502,
          code: error.code,
          message:
            "Không thể lấy danh sách ứng viên từ VNAIP. Vui lòng thử lại sau.",
        };
      case "SCORING_UNAVAILABLE":
        return {
          status: 502,
          code: error.code,
          message: "Model chấm điểm tương đồng thất bại. Vui lòng thử lại sau.",
        };
    }
  }
  if (error instanceof VnaipClientError || error instanceof LlmScorerError) {
    // Không nên lộ ra ngoài checkDuplicates() (đã được bọc thành DedupError),
    // nhưng xử lý phòng hờ để không bao giờ rơi về nhánh "lỗi nội bộ" chung.
    return {
      status: 502,
      code: error.code,
      message: "Phụ thuộc bên ngoài thất bại. Vui lòng thử lại sau.",
    };
  }

  // Output không hợp lệ theo schema, hoặc lỗi không mong đợi khác: không
  // bao giờ trả 200 với nội dung sai hợp đồng.
  return { status: 500, code: "APP_ERROR", message: "Xử lý yêu cầu thất bại." };
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function log(
  level: "info" | "error",
  event: string,
  details: Record<string, unknown>,
) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...details,
    }),
  );
}
