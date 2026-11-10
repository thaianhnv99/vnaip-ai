import type { ErrorRequestHandler } from "express";
import type { Logger } from "./shared/logger.js";

/**
 * Error handler cuối cùng. Lỗi 4xx của body-parser (JSON hỏng, body quá lớn)
 * phải trả đúng 400/413 thay vì 500, để webhook caller biết lỗi nằm ở request
 * của mình. Mọi lỗi khác trả 500 chung, chi tiết chỉ nằm trong log.
 */
export function createErrorHandler(log: Logger): ErrorRequestHandler {
  return (error, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const status = clientErrorStatus(error);
    if (status !== undefined) {
      response.status(status).json(
        status === 413
          ? { code: "PAYLOAD_TOO_LARGE", message: "Body quá lớn" }
          : { code: "BAD_REQUEST", message: "Request không hợp lệ" },
      );
      return;
    }

    log("error", "request_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    response.status(500).json({ code: "APP_ERROR", message: "Request failed" });
  };
}

function clientErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500
    ? status
    : undefined;
}
