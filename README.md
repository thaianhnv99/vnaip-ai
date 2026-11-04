# vnaip-dedup

SotaAgent app generated with composable `sota init` recipes.

## Local development

Run the app watcher and Sota session in two terminals:

```bash
npm run dev       # app watchers (frontend and/or backend)
npm run dev:sota  # in another terminal: attach to your workspace
```

Add another capability at any time with `sota add`.

Editable source lives in `src/`. Generated frontend and backend output lives in `dist/`.

## Tool: `check-duplicates`

Kiểm tra mức độ tương đồng giữa một hồ sơ đầu vào và các hồ sơ ứng viên lấy
từ VNAIP BE, chấm điểm bằng model. Xem contract đầy đủ trong:

- `src/schemas/dedup-input.schema.json`
- `src/schemas/dedup-output.schema.json`
- `src/backend/dedup.ts` (logic nghiệp vụ, framework-neutral, test được độc lập)

### Cấu hình

Copy `.env.example` thành `.env` và chỉnh các biến:

| Biến | Mô tả |
| --- | --- |
| `VNAIP_CANDIDATE_LIMIT` | Số ứng viên tối đa lấy từ VNAIP BE (mặc định 30, chưa tối ưu). |
| `VNAIP_MOCK_MODE` | `true` (mặc định) dùng mock candidate. Đặt `false` khi có API contract thật. |
| `LLM_MOCK_MODE` | `true` (mặc định) dùng mock scorer (so khớp từ vựng thô). Đặt `false` khi có provider thật. |
| `VNAIP_BE_BASE_URL`, `VNAIP_BE_SERVICE_TOKEN`, `VNAIP_BE_TIMEOUT_MS` | Cấu hình gọi VNAIP BE thật. **UNRESOLVED**: cơ chế xác thực server-to-server thật chưa được xác nhận. |
| `LLM_SCORER_BASE_URL`, `LLM_SCORER_API_KEY`, `LLM_SCORER_MODEL`, `LLM_SCORER_TIMEOUT_MS`, `LLM_SCORER_BATCH_SIZE` | Cấu hình provider model thật. **UNRESOLVED**: contract provider thật chưa được xác nhận. |

Không commit giá trị thật của `VNAIP_BE_SERVICE_TOKEN` hoặc `LLM_SCORER_API_KEY`.

### Chạy local

```bash
npm install
npm run dev        # app backend, terminal 1
npm run dev:sota    # Sota dev session + tunnel, terminal 2
```

Luồng index chạy ở hai tiến trình: web (`npm run dev`, hosted `npm start`) chỉ nhận
webhook rồi đẩy job vào Redis; worker (`npm run dev:worker`, hosted
`npm run start:worker`) xử lý job. Với `QUEUE_MOCK_MODE=true` (hàng đợi trong bộ nhớ,
chỉ cục bộ) web tự chạy worker nên không cần chạy thêm. Khi dùng BullMQ thật
(`REDIS_URL`), phải chạy worker riêng với cùng `REDIS_URL`, `QUEUE_PREFIX`, `QUEUE_NAME`.
Chi tiết: `docs/ke-hoach-phat-trien.md` (GĐ2).

### Kiểm thử

```bash
npm run typecheck        # typecheck mã production (src/backend, không gồm __tests__)
npm run typecheck:tests   # typecheck toàn bộ gồm __tests__
npm run build             # build mã production sang dist/backend
npm test                  # chạy toàn bộ unit test (node:test qua tsx)
sota validate              # validate manifest.yaml
```

`npm test` yêu cầu Node ≥ 20 (WebCrypto global cần cho `jose`). Nếu máy bạn
dùng `nvm` và đang ở Node 18, chạy `nvm use 20` (hoặc mới hơn) trước.

Test hiện có (40 test, xem `src/backend/__tests__/`):

- `dedup.test.ts`: input hợp lệ/không hợp lệ, không có ứng viên, lỗi VNAIP/model
  propagate đúng thay vì trả "không trùng" im lặng, ID không thuộc candidate
  bị loại, type do model trả về bị bỏ qua, score ngoài thang, ID trùng, reason
  rỗng, cắt tối đa 30 kết quả.
- `validate-input.test.ts`, `validate-output.test.ts`: validate tay theo đúng
  JSON Schema (vì SotaAgents không tự kiểm tra outputSchema tại runtime).
- `sota-auth.test.ts`: JWT hợp lệ, thiếu token, hết hạn, audience sai, thiếu
  scope — dùng JWKS server giả ký bằng khoá EdDSA tạo tại chỗ.
- `check-duplicates-route.test.ts`: wiring route đầy đủ, map lỗi sang HTTP
  status đúng, và xác nhận log lỗi không chứa nội dung hồ sơ hoặc bí mật.

### Việc còn lại trước khi tích hợp VNAIP và triển khai production

Xem phần "Blocker" trong lịch sử trao đổi với AI; tóm tắt:

1. **Chưa xác nhận**: cơ chế VNAIP BE gọi tool này qua SotaAgents Core bằng
   service account (endpoint, scope thật, mapping workspace ↔ tenant VNAIP).
   Không coi đây là đã xác nhận chỉ vì manual có nhắc `app-tools:invoke`.
2. API contract thật của VNAIP BE để lấy candidate (endpoint, auth
   server-to-server, filter fields, response shape).
3. Provider/model API contract thật để chấm điểm.
4. Giá trị `type` hợp lệ đầy đủ, vai trò/tính bắt buộc của `parentSolutionId`,
   số lượng `excludeId` (một hay nhiều), ngưỡng hiển thị và số kết quả tối đa
   theo nghiệp vụ thật — schema hiện tại là giả định tạm.
5. `timeoutMs` tối đa khi build artifact (schema chỉ ràng buộc `minimum: 1`,
   không có `maximum`) — xác minh theo phiên bản CLI/Core đang dùng.
6. Cơ chế xử lý tác vụ dài hơn giới hạn timeout nếu cần (không giả định
   platform tự hỗ trợ async).
7. `service.baseUrl`/`health.url` còn là placeholder `.invalid` — cần backend
   hosted thật trước khi deploy Staging/Production.
