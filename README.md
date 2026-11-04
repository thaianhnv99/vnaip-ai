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

Kiểm tra mức độ tương đồng giữa một hồ sơ đầu vào và **toàn bộ sáng kiến cùng loại đã
được duyệt và index trong Qdrant** (hướng A: lấy tất cả ứng viên, không tìm theo
vector), rồi để model chấm điểm qua OpenRouter. Dữ liệu trong Qdrant do luồng index
(webhook → BullMQ → worker) nạp. Xem contract đầy đủ trong:

- `src/schemas/dedup-input.schema.json`
- `src/schemas/dedup-output.schema.json`
- `src/backend/dedup.ts` (logic nghiệp vụ, framework-neutral, test được độc lập)
- `src/backend/candidate-source.ts` (đọc Qdrant, gom chunk theo sáng kiến)
- `src/backend/llm-scorer.ts` (chấm điểm theo batch song song, có deadline)
- `src/backend/caller-policy.ts` (giới hạn ai được gọi tool)

### Ai được gọi tool

Mọi sáng kiến nằm chung một tập dữ liệu, nên ai gọi được tool là so sánh được với tất cả.
Tool vì vậy **từ chối (403) mọi lời gọi** cho tới khi đặt ít nhất một danh sách trong
`CHECK_DUPLICATES_ALLOWED_SUBS` / `_OIDS` / `_WIDS`, và chỉ so khớp với claims đã xác
thực của Core (không bao giờ với body hay header). Đặt nhiều danh sách thì phải khớp tất cả.

### Hành vi cần biết

- **Vượt trần thì báo lỗi, không cắt.** Quá `CHECK_DUPLICATES_CANDIDATE_LIMIT` sáng kiến
  (mặc định 100, sau khi loại `excludeIds`) hoặc kho vượt giới hạn đọc thì tool trả `503
  CANDIDATE_LIMIT_EXCEEDED`. Cắt tuỳ ý có thể bỏ sót đúng sáng kiến trùng và trả "không
  trùng" sai. Chạm trần là tín hiệu chuyển sang hướng B (top-k theo vector; vector đã được lưu sẵn).
- **Lỗi một phần là lỗi.** Một batch chấm điểm lỗi hoặc hết giờ thì cả lời gọi trả `502
  SCORING_UNAVAILABLE`; không trả điểm của một phần ứng viên.
- **Chỉ so sánh sáng kiến cùng `type`** với input (hiện chỉ có `solution`).
- Nội dung mỗi ứng viên đưa vào prompt bị cắt ở `LLM_SCORER_MAX_CANDIDATE_CHARS` (4000 ký tự).
- `parentSolutionId` được chấp nhận nhưng chưa dùng để lọc (vai trò chưa được nghiệp vụ xác nhận).
- Input dùng `excludeIds` (mảng); `excludeId` và `datasetKey` bị từ chối (400): BE phải đổi.

### Cấu hình

Copy `.env.example` thành `.env` và chỉnh các biến. Tiến trình **web** cần cấu hình Qdrant
(cùng collection với worker), `OPENROUTER_API_KEY`, `LLM_SCORER_MODEL` và danh sách người
gọi. Biến chính của tool:

| Biến | Mô tả |
| --- | --- |
| `CHECK_DUPLICATES_ALLOWED_SUBS`, `_OIDS`, `_WIDS` | Danh sách claim được phép gọi tool (phân tách bằng dấu phẩy, AND giữa các danh sách). Không đặt danh sách nào thì 403 cho tất cả. |
| `CHECK_DUPLICATES_CANDIDATE_LIMIT` | Trần số sáng kiến gửi cho model (mặc định 100, tối đa 500). |
| `CHECK_DUPLICATES_DEADLINE_MS` | Tổng thời gian cho cả lời gọi (mặc định 13000, nhỏ hơn `timeoutMs` 15000 của tool). |
| `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` | Khoá và base URL OpenRouter, dùng chung với embedding. |
| `LLM_SCORER_MODEL` | Model chấm điểm. **Không có mặc định.** Chưa chốt model cho Staging/production: đã đo `claude-haiku-5.5` đạt mốc 15 giây, các model `:free` thì không (xem `docs/ke-hoach-phat-trien.md`, quyết định #15). |
| `LLM_SCORER_BATCH_SIZE`, `LLM_SCORER_CONCURRENCY`, `LLM_SCORER_TIMEOUT_MS`, `LLM_SCORER_MAX_CANDIDATE_CHARS` | Số ứng viên mỗi lần gọi (5), số lần gọi song song (20), trần thời gian mỗi lần (10000ms), phần nội dung tối đa mỗi ứng viên (4000 ký tự). |
| `LLM_MOCK_MODE`, `QDRANT_MOCK_MODE` | `true` dùng scorer mock / kho trong bộ nhớ (rỗng, không chia sẻ với worker). Không đặt nghĩa là dùng dịch vụ thật. |

Không commit giá trị thật của `OPENROUTER_API_KEY`, `QDRANT_API_KEY`, `WEBHOOK_HMAC_SECRETS`.

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

Thử tool cục bộ không cần Core thật: chạy `scripts/dev-fake-jwks.ts` rồi
`scripts/dev-call-check-duplicates.ts` (xem đầu hai file). Token giả mang `oid=org-dev-test`,
nên đặt `CHECK_DUPLICATES_ALLOWED_OIDS=org-dev-test` trong `.env`.

### Dữ liệu mẫu

`scripts/seed-ideas.ts` nạp 10 sáng kiến mẫu (id `SEED-GP-xxxx`, có hai cặp gần như trùng
nhau và một sáng kiến nhiều chunk) vào Qdrant qua đúng đường index của worker, để thử tool
mà không cần VNAIP BE gửi webhook:

```bash
npx tsx scripts/seed-ideas.ts --collection vnaip_dedup_dev           # nạp
npx tsx scripts/seed-ideas.ts --collection vnaip_dedup_dev --clean   # xoá
```

`--collection` bắt buộc và phải trùng `QDRANT_COLLECTION`; script từ chối collection có chữ
"prod" và `QDRANT_MOCK_MODE=true`. Có thể dùng `EMBEDDING_MOCK_MODE=true` (luồng 1 không
dùng vector khi truy vấn); khi đó dữ liệu mẫu mang nhãn model `mock-embedding`.

### Kiểm thử

```bash
npm run typecheck        # typecheck mã production (src/backend, không gồm __tests__)
npm run typecheck:tests   # typecheck toàn bộ gồm __tests__
npm run build             # build mã production sang dist/backend
npm test                  # chạy toàn bộ unit test (node:test qua tsx)
sota validate              # validate manifest.yaml
```

`npm test` yêu cầu Node ≥ 20.3 (WebCrypto global cần cho `jose`, `AbortSignal.any` cho scorer). Nếu máy bạn
dùng `nvm` và đang ở Node 18, chạy `nvm use 22` (hoặc mới hơn) trước. Một số test tích hợp
chỉ chạy khi đặt `REDIS_TEST_URL`.

Các test chính của luồng kiểm tra trùng (xem `src/backend/__tests__/`):

- `dedup.test.ts`: logic nghiệp vụ, lỗi nguồn ứng viên/model propagate đúng thay vì trả
  "không trùng" im lặng, `excludeIds`, vượt trần, deadline.
- `candidate-source.test.ts`: gom chunk, lọc `type`, index lại giữa chừng, scroll bị cắt.
- `llm-scorer.test.ts`: URL OpenRouter giữ `/api/v1`, batch song song, giới hạn đồng thời,
  deadline, một batch lỗi thì cả lời gọi lỗi, không lộ khoá API.
- `caller-policy.test.ts`, `check-duplicates-http.test.ts`: giới hạn người gọi, qua cả chuỗi
  Express thật + xác thực JWT thật (JWKS giả); claims không khớp bị 403, danh tính khai
  trong body/header không có tác dụng.
- `check-duplicates-pipeline.test.ts`: index → kiểm tra trùng trong cùng tiến trình (mốc MVP).
- `validate-input.test.ts`, `validate-output.test.ts`: validate tay theo đúng JSON Schema
  (SotaAgents không tự kiểm tra outputSchema tại runtime).
- `sota-auth.test.ts`: JWT hợp lệ, thiếu token, hết hạn, audience sai, thiếu scope.

### Việc còn lại trước khi tích hợp VNAIP và triển khai production

Xem `docs/ke-hoach-phat-trien.md` (GĐ0 còn hai mục, GĐ3, GĐ4, GĐ5). Tóm tắt các điểm chưa
được xác nhận:

1. Claim nhận diện service account của VNAIP BE (để đặt `CHECK_DUPLICATES_ALLOWED_*`):
   deploy Staging với `LOG_VERIFIED_CLAIMS=true`, cho BE gọi tool một lần, đọc log
   `invocation_accepted`. Cho tới khi đặt danh sách, tool trả 403.
2. Chọn model chấm điểm (`LLM_SCORER_MODEL`) và đo thời gian trả lời với dữ liệu thật.
3. Giá trị `type` hợp lệ đầy đủ, vai trò của `parentSolutionId`, ngưỡng hiển thị và số kết
   quả tối đa theo nghiệp vụ thật.
4. `timeoutMs` tối đa khi build artifact (schema chỉ ràng buộc `minimum: 1`).
5. Trần số ứng viên và ngưỡng chuyển sang hướng B khi số sáng kiến tăng.
