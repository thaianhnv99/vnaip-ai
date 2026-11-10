import type { Express, RequestHandler } from "express";
import {
  callerEnvNames,
  isCallerPolicyEmpty,
  loadCallerPolicy,
  type CallerPolicy,
} from "../../platform/caller-policy.js";
import { mountProtectedTool } from "../../platform/protected-tool.js";
import { defaultLog } from "../../shared/logger.js";
import { createCheckDuplicatesHandler } from "./route.js";

/** Khớp `route` và scope khai báo cho tool này trong manifest.yaml. */
export const CHECK_DUPLICATES_PATH = "/tools/check-duplicates";
export const CHECK_DUPLICATES_SCOPE = "tool:check-duplicates";
export const CHECK_DUPLICATES_CALLER_ENV = callerEnvNames("CHECK_DUPLICATES");

export interface CheckDuplicatesToolOptions {
  /** Mặc định đọc từ CHECK_DUPLICATES_ALLOWED_* trong env. */
  callerPolicy?: CallerPolicy;
  /** Mặc định: handler thật (Qdrant + Gemini, dựng ở lần gọi đầu). Test truyền handler giả. */
  handler?: RequestHandler;
}

/**
 * Đăng ký tool `check-duplicates`.
 *
 * Vì sao phải giới hạn người gọi: từ 2026-11-04 dữ liệu không còn tách theo workspace hay
 * người gọi (chỉ tách theo `type`: mỗi type một collection, xem vector-store.ts), nên không
 * có lớp cách ly người gọi ở tầng lưu trữ: ai gọi được tool là đọc được (nội dung rút gọn
 * trong prompt, kết quả là id + lý do) mọi sáng kiến của type được hỏi. Top-k theo vector
 * không phải ranh giới quyền: input do người gọi tự chọn nên họ có thể kéo bất kỳ sáng kiến
 * nào vào top-k bằng cách viết input giống nó. App lại có thể được cài vào nhiều workspace
 * Sota, nên quyền gọi phải được giới hạn ở đây (platform/caller-policy.ts).
 */
export function registerCheckDuplicatesTool(
  app: Express,
  appId: string,
  options: CheckDuplicatesToolOptions = {},
): void {
  const callerPolicy = options.callerPolicy ?? loadCallerPolicy(CHECK_DUPLICATES_CALLER_ENV);
  if (isCallerPolicyEmpty(callerPolicy)) {
    // Không dừng app: /health và webhook vẫn phải chạy. Tool trả 403 cho tới khi cấu hình.
    defaultLog("error", "caller_policy_empty", {
      message:
        `Chưa đặt danh sách người gọi được phép (${CHECK_DUPLICATES_CALLER_ENV.subs}, ${CHECK_DUPLICATES_CALLER_ENV.oids} hoặc ${CHECK_DUPLICATES_CALLER_ENV.wids}); ` +
        "tool check-duplicates từ chối mọi lời gọi (403) cho tới khi cấu hình.",
    });
  }

  mountProtectedTool(app, appId, {
    path: CHECK_DUPLICATES_PATH,
    scope: CHECK_DUPLICATES_SCOPE,
    callerPolicy,
    handler: options.handler ?? createCheckDuplicatesHandler(),
  });
}
