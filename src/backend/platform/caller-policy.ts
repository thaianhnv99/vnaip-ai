import type { RequestHandler } from "express";
import type { InvocationClaims } from "./sota-auth.js";
import { defaultLog, type Logger } from "../shared/logger.js";

/**
 * Giới hạn AI được gọi một tool, chỉ dựa trên CLAIMS ĐÃ XÁC THỰC của Core (`sub`, `oid`,
 * `wid`), không bao giờ dựa trên body hay header không ký. Mỗi tool có chính sách riêng, đọc
 * từ ba biến môi trường cùng tiền tố (`<TIỀN_TỐ>_ALLOWED_SUBS|OIDS|WIDS`, xem
 * `callerEnvNames`), nên thêm tool mới không phải sửa file này.
 *
 * Quy tắc (đóng theo mặc định):
 * - Mỗi danh sách đã cấu hình là một điều kiện BẮT BUỘC: claim tương ứng phải nằm
 *   trong danh sách (AND giữa các danh sách, để thu hẹp chứ không mở rộng quyền).
 * - Không cấu hình danh sách nào thì từ chối mọi lời gọi (403). Quên đặt biến môi
 *   trường không được phép làm mở toang tool.
 *
 * Danh sách nhận nhiều giá trị phân tách bằng dấu phẩy. Giá trị thật của `sub` cho
 * service account của VNAIP BE lấy từ log `invocation_accepted` (bật tạm
 * LOG_VERIFIED_CLAIMS=true); log này chạy TRƯỚC bước kiểm tra ở đây nên vẫn thấy
 * được claim của lời gọi bị từ chối.
 */

export interface CallerPolicy {
  subs: ReadonlySet<string>;
  oids: ReadonlySet<string>;
  wids: ReadonlySet<string>;
}

export type CallerDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "policy_not_configured"
        | "sub_not_allowed"
        | "oid_not_allowed"
        | "wid_not_allowed";
    };

/** Tên ba biến môi trường chứa danh sách người gọi được phép của một tool. */
export interface CallerEnvNames {
  readonly subs: string;
  readonly oids: string;
  readonly wids: string;
}

const ENV_PREFIX_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** `callerEnvNames("CHECK_DUPLICATES")` -> `CHECK_DUPLICATES_ALLOWED_SUBS|OIDS|WIDS`. */
export function callerEnvNames(prefix: string): CallerEnvNames {
  if (!ENV_PREFIX_PATTERN.test(prefix)) {
    throw new RangeError("Tiền tố biến môi trường phải viết hoa, dạng A-Z, 0-9 và _");
  }
  return {
    subs: `${prefix}_ALLOWED_SUBS`,
    oids: `${prefix}_ALLOWED_OIDS`,
    wids: `${prefix}_ALLOWED_WIDS`,
  };
}

export function loadCallerPolicy(
  names: CallerEnvNames,
  env: NodeJS.ProcessEnv = process.env,
): CallerPolicy {
  return {
    subs: parseList(env[names.subs]),
    oids: parseList(env[names.oids]),
    wids: parseList(env[names.wids]),
  };
}

export function isCallerPolicyEmpty(policy: CallerPolicy): boolean {
  return policy.subs.size === 0 && policy.oids.size === 0 && policy.wids.size === 0;
}

export function evaluateCaller(
  policy: CallerPolicy,
  claims: Pick<InvocationClaims, "sub" | "oid" | "wid">,
): CallerDecision {
  if (isCallerPolicyEmpty(policy)) {
    return { allowed: false, reason: "policy_not_configured" };
  }
  if (policy.subs.size > 0 && !isMember(policy.subs, claims.sub)) {
    return { allowed: false, reason: "sub_not_allowed" };
  }
  if (policy.oids.size > 0 && !isMember(policy.oids, claims.oid)) {
    return { allowed: false, reason: "oid_not_allowed" };
  }
  if (policy.wids.size > 0 && !isMember(policy.wids, claims.wid)) {
    return { allowed: false, reason: "wid_not_allowed" };
  }
  return { allowed: true };
}

/**
 * Phải đặt SAU requireSotaInvocation: nó đọc claims đã xác thực ở
 * `response.locals.sota`. Log từ chối chỉ nêu lý do, không ghi giá trị claim
 * (muốn xem giá trị thì dùng LOG_VERIFIED_CLAIMS).
 */
export function requireAllowedCaller(
  policy: CallerPolicy,
  log: Logger = defaultLog,
): RequestHandler {
  return (request, response, next) => {
    const claims = response.locals.sota as InvocationClaims | undefined;
    // Không có claims đã xác thực nghĩa là middleware auth chưa chạy: lỗi lắp ráp
    // route, phải từ chối thay vì cho qua.
    const decision: CallerDecision = claims
      ? evaluateCaller(policy, claims)
      : { allowed: false, reason: "policy_not_configured" };

    if (decision.allowed) {
      next();
      return;
    }

    log("error", "caller_denied", {
      requestId: response.getHeader("x-request-id") ?? request.header("x-request-id") ?? null,
      reason: decision.reason,
    });
    response.status(403).json({
      code: "CALLER_NOT_ALLOWED",
      message: "Người gọi không được phép dùng tool này.",
    });
  };
}

function parseList(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

function isMember(allowed: ReadonlySet<string>, claim: unknown): boolean {
  return typeof claim === "string" && claim.length > 0 && allowed.has(claim);
}
