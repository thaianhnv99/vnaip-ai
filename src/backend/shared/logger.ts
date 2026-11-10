/**
 * Logger dùng chung của backend. Mỗi lời gọi ghi một dòng JSON ra stdout để nền tảng
 * thu log thu thập và lọc theo `event`. Tên `event` là hợp đồng với vận hành (alert,
 * dashboard), nên không đổi tên một event khi chưa báo người vận hành.
 *
 * Log chỉ chứa định danh, mã lỗi và số đếm; không bao giờ ghi token, khoá API hay nội
 * dung hồ sơ.
 */
export type LogLevel = "info" | "error";

export type Logger = (
  level: LogLevel,
  event: string,
  details: Record<string, unknown>,
) => void;

export const defaultLog: Logger = (level, event, details) => {
  console.log(
    JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details }),
  );
};
