import type { Express, RequestHandler } from "express";
import { requireSotaInvocation } from "./sota-auth.js";
import { requireAllowedCaller, type CallerPolicy } from "./caller-policy.js";

export interface ProtectedToolRoute {
  /** Route khai báo trong manifest, ví dụ `/tools/check-duplicates`. */
  path: string;
  /** Scope hẹp nhất cho phép thao tác này, ví dụ `tool:check-duplicates`. */
  scope: string;
  /** Bắt buộc: không có tool nào được mount mà thiếu chính sách người gọi (đóng theo mặc định). */
  callerPolicy: CallerPolicy;
  handler: RequestHandler;
}

/**
 * Mount một tool (POST) sau đúng chuỗi biên: xác thực token Core rồi kiểm người gọi dựa trên
 * claims đã xác thực, và chỉ sau đó mới tới handler. Mọi tool đi qua hàm này để một handler
 * không thể vô tình bỏ qua bước nào hay đảo thứ tự. Handler chỉ đọc danh tính từ
 * `response.locals.sota`, không bao giờ từ body.
 */
export function mountProtectedTool(app: Express, appId: string, route: ProtectedToolRoute): void {
  app.post(
    route.path,
    // Thứ tự có chủ đích: xác thực token trước, rồi mới kiểm người gọi dựa trên claims đã xác thực.
    requireSotaInvocation(appId, route.scope),
    requireAllowedCaller(route.callerPolicy),
    route.handler,
  );
}
