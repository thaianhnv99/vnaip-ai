import type { Express } from "express";
import {
  registerCheckDuplicatesTool,
  type CheckDuplicatesToolOptions,
} from "./check-duplicates/register.js";

export interface ToolRegistryOptions {
  checkDuplicates?: CheckDuplicatesToolOptions;
}

/**
 * Registry của các Sota tool (route khai báo trong `contributes.tools` của manifest).
 * Thêm tool mới: tạo `tools/<tool>/` có `register.ts`, thêm MỘT dòng vào đây và khai báo tool
 * trong manifest (xem README, mục "Thêm tool mới"). Tool không import tool khác; thứ dùng chung
 * nằm ở `platform/`, `shared/` hoặc `integrations/`.
 */
export function registerTools(app: Express, appId: string, options: ToolRegistryOptions = {}): void {
  registerCheckDuplicatesTool(app, appId, options.checkDuplicates);
}
