import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  callerEnvNames,
  evaluateCaller,
  isCallerPolicyEmpty,
  loadCallerPolicy,
  requireAllowedCaller,
  type CallerPolicy,
} from "../caller-policy.js";

function policy(env: Record<string, string | undefined>): CallerPolicy {
  return loadCallerPolicy(callerEnvNames("CHECK_DUPLICATES"), env);
}

const claims = { sub: "svc-vnaip-be", oid: "org-vnaip", wid: "ws-vnaip" };

test("loadCallerPolicy: tách theo dấu phẩy, bỏ khoảng trắng và mục rỗng", () => {
  const loaded = policy({
    CHECK_DUPLICATES_ALLOWED_SUBS: " svc-a , svc-b,, ",
    CHECK_DUPLICATES_ALLOWED_OIDS: "org-1",
  });

  assert.deepEqual([...loaded.subs], ["svc-a", "svc-b"]);
  assert.deepEqual([...loaded.oids], ["org-1"]);
  assert.equal(loaded.wids.size, 0);
});

test("chưa cấu hình danh sách nào thì từ chối mọi lời gọi (đóng theo mặc định)", () => {
  for (const env of [{}, { CHECK_DUPLICATES_ALLOWED_SUBS: "" }, { CHECK_DUPLICATES_ALLOWED_SUBS: " , ," }]) {
    const empty = policy(env);
    assert.equal(isCallerPolicyEmpty(empty), true);
    assert.deepEqual(evaluateCaller(empty, claims), { allowed: false, reason: "policy_not_configured" });
  }
});

test("chỉ cấu hình sub: sub khớp thì cho qua, sub khác bị từ chối dù oid/wid là gì", () => {
  const only = policy({ CHECK_DUPLICATES_ALLOWED_SUBS: "svc-vnaip-be" });

  assert.deepEqual(evaluateCaller(only, claims), { allowed: true });
  assert.deepEqual(evaluateCaller(only, { ...claims, sub: "user-khac" }), {
    allowed: false,
    reason: "sub_not_allowed",
  });
});

test("chỉ cấu hình oid hoặc wid: claim tương ứng phải khớp", () => {
  const byOrg = policy({ CHECK_DUPLICATES_ALLOWED_OIDS: "org-vnaip" });
  assert.equal(evaluateCaller(byOrg, claims).allowed, true);
  assert.deepEqual(evaluateCaller(byOrg, { ...claims, oid: "org-khac" }), {
    allowed: false,
    reason: "oid_not_allowed",
  });

  const byWorkspace = policy({ CHECK_DUPLICATES_ALLOWED_WIDS: "ws-vnaip" });
  assert.equal(evaluateCaller(byWorkspace, claims).allowed, true);
  assert.deepEqual(evaluateCaller(byWorkspace, { ...claims, wid: "ws-khac" }), {
    allowed: false,
    reason: "wid_not_allowed",
  });
});

test("nhiều danh sách là AND: phải khớp tất cả danh sách đã cấu hình", () => {
  const both = policy({
    CHECK_DUPLICATES_ALLOWED_SUBS: "svc-vnaip-be",
    CHECK_DUPLICATES_ALLOWED_OIDS: "org-vnaip",
  });

  assert.equal(evaluateCaller(both, claims).allowed, true);
  // sub đúng nhưng ở tổ chức khác (service account trùng tên): không được qua.
  assert.deepEqual(evaluateCaller(both, { ...claims, oid: "org-khac" }), {
    allowed: false,
    reason: "oid_not_allowed",
  });
  // tổ chức đúng nhưng người dùng khác: không được qua.
  assert.deepEqual(evaluateCaller(both, { ...claims, sub: "user-khac" }), {
    allowed: false,
    reason: "sub_not_allowed",
  });
});

test("danh sách nhiều giá trị: khớp một trong các giá trị của cùng danh sách", () => {
  const many = policy({ CHECK_DUPLICATES_ALLOWED_SUBS: "svc-stg, svc-prod" });

  assert.equal(evaluateCaller(many, { ...claims, sub: "svc-prod" }).allowed, true);
  assert.equal(evaluateCaller(many, { ...claims, sub: "svc-stg" }).allowed, true);
  assert.equal(evaluateCaller(many, { ...claims, sub: "svc" }).allowed, false);
});

test("so khớp chính xác: không phân biệt hoa thường thì KHÔNG khớp, tiền tố cũng không", () => {
  const exact = policy({ CHECK_DUPLICATES_ALLOWED_SUBS: "svc-vnaip-be" });

  assert.equal(evaluateCaller(exact, { ...claims, sub: "SVC-VNAIP-BE" }).allowed, false);
  assert.equal(evaluateCaller(exact, { ...claims, sub: "svc-vnaip" }).allowed, false);
  assert.equal(evaluateCaller(exact, { ...claims, sub: "svc-vnaip-be-2" }).allowed, false);
});

test("token không có sub (lời gọi không có actor) không khớp danh sách sub", () => {
  const bySub = policy({ CHECK_DUPLICATES_ALLOWED_SUBS: "svc-vnaip-be" });

  assert.equal(evaluateCaller(bySub, { oid: "o", wid: "w" } as never).allowed, false);
  assert.equal(evaluateCaller(bySub, { ...claims, sub: "" }).allowed, false);
});

function fakeRequestResponse(sota: unknown) {
  const request = { header: () => undefined } as unknown as Request;
  const state: { status?: number; body?: unknown } = {};
  const response = {
    locals: sota === undefined ? {} : { sota },
    getHeader: () => "req-1",
    status(code: number) {
      state.status = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
  } as unknown as Response;
  return { request, response, state };
}

test("middleware: người gọi được phép thì gọi next() và không ghi response", () => {
  const { request, response, state } = fakeRequestResponse(claims);
  let nexted = false;

  requireAllowedCaller(policy({ CHECK_DUPLICATES_ALLOWED_SUBS: "svc-vnaip-be" }), () => {})(
    request,
    response,
    () => {
      nexted = true;
    },
  );

  assert.equal(nexted, true);
  assert.equal(state.status, undefined);
});

test("middleware: người gọi không khớp bị 403 CALLER_NOT_ALLOWED, không gọi next()", () => {
  const { request, response, state } = fakeRequestResponse({ ...claims, sub: "user-khac" });

  requireAllowedCaller(policy({ CHECK_DUPLICATES_ALLOWED_SUBS: "svc-vnaip-be" }), () => {})(
    request,
    response,
    () => {
      throw new Error("next() không nên được gọi");
    },
  );

  assert.equal(state.status, 403);
  assert.equal((state.body as { code: string }).code, "CALLER_NOT_ALLOWED");
});

test("middleware: chính sách rỗng thì 403 dù claims hợp lệ", () => {
  const { request, response, state } = fakeRequestResponse(claims);

  requireAllowedCaller(policy({}), () => {})(request, response, () => {
    throw new Error("next() không nên được gọi");
  });

  assert.equal(state.status, 403);
});

test("middleware: thiếu claims đã xác thực (lắp sai thứ tự middleware) thì từ chối, không cho qua", () => {
  const { request, response, state } = fakeRequestResponse(undefined);

  requireAllowedCaller(policy({ CHECK_DUPLICATES_ALLOWED_SUBS: "svc-vnaip-be" }), () => {})(
    request,
    response,
    () => {
      throw new Error("next() không nên được gọi");
    },
  );

  assert.equal(state.status, 403);
});

test("log từ chối chỉ nêu lý do và requestId, không ghi giá trị claim; response không lộ danh sách cho phép", () => {
  const lines: Array<Record<string, unknown>> = [];
  const { request, response, state } = fakeRequestResponse({
    sub: "user-bi-tu-choi",
    oid: "org-bi-tu-choi",
    wid: "ws-bi-tu-choi",
  });

  requireAllowedCaller(policy({ CHECK_DUPLICATES_ALLOWED_SUBS: "svc-vnaip-be" }), (level, event, details) =>
    lines.push({ level, event, ...details }),
  )(request, response, () => {});

  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.event, "caller_denied");
  assert.equal(lines[0]!.reason, "sub_not_allowed");
  assert.equal(lines[0]!.requestId, "req-1");
  assert.doesNotMatch(JSON.stringify(lines), /bi-tu-choi/);
  assert.doesNotMatch(JSON.stringify(state.body), /svc-vnaip-be|bi-tu-choi/);
});

test("callerEnvNames: tên biến của check-duplicates giữ nguyên (hợp đồng cấu hình đã triển khai)", () => {
  assert.deepEqual(
    { ...callerEnvNames("CHECK_DUPLICATES") },
    {
      subs: "CHECK_DUPLICATES_ALLOWED_SUBS",
      oids: "CHECK_DUPLICATES_ALLOWED_OIDS",
      wids: "CHECK_DUPLICATES_ALLOWED_WIDS",
    },
  );
});

test("callerEnvNames: tool khác dùng tiền tố riêng và không đọc nhầm biến của tool khác", () => {
  const names = callerEnvNames("OTHER_TOOL");
  assert.deepEqual(
    { ...names },
    {
      subs: "OTHER_TOOL_ALLOWED_SUBS",
      oids: "OTHER_TOOL_ALLOWED_OIDS",
      wids: "OTHER_TOOL_ALLOWED_WIDS",
    },
  );

  const loaded = loadCallerPolicy(names, {
    OTHER_TOOL_ALLOWED_SUBS: "svc-other",
    CHECK_DUPLICATES_ALLOWED_SUBS: "svc-vnaip-be",
  });
  assert.deepEqual([...loaded.subs], ["svc-other"]);
  assert.equal(isCallerPolicyEmpty(loadCallerPolicy(names, { CHECK_DUPLICATES_ALLOWED_SUBS: "svc-vnaip-be" })), true);
});

test("callerEnvNames: tiền tố sai định dạng bị từ chối", () => {
  for (const bad of ["", "check", "1ABC", "A-B", "A B"]) {
    assert.throws(() => callerEnvNames(bad), RangeError, JSON.stringify(bad));
  }
});
