# Kế hoạch phát triển vnaip-dedup theo thiết kế mới

> Nguồn: `vnaip-dedup-design.md` (thiết kế tổng hợp từ phản hồi của anh Hưng).
> Phạm vi: chia công việc thành các giai đoạn phát triển, có phụ thuộc và tiêu chí xong.
> Ngày lập: 2026-11-03. Cập nhật 2026-11-04: GĐ0 và GĐ1 xong; GĐ2 xong phần lõi (webhook, BullMQ, worker tách tiến trình riêng), còn phần file/MinIO đang để `#TODO`; GĐ3 chưa bắt đầu. Queue và luồng file được sửa theo diagram `Final1.png` (mục 3.3); cùng ngày bỏ `datasetKey`, chốt Redis tự host và tách worker (mục 3.2 dòng 9 đến 11).

## 1. Hiện trạng so với thiết kế mới

- Tool `check-duplicates` đã có: xác thực JWT/JWKS, validate input/output, LLM scorer. Candidate lấy từ VNAIP BE và cả hai phần (VNAIP client, LLM scorer) đang ở mock mode.
- Chưa có: embedding, Qdrant, webhook, queue, worker.
- Thiết kế mới bỏ VNAIP client và thay bằng Qdrant. Phần lớn `src/backend/dedup.ts` và `src/backend/llm-scorer.ts` dùng lại được.
- `src/backend/sota-auth.ts` đang có thay đổi chưa commit, chủ yếu là format lại. Có một thay đổi cần chú ý: Core origin mặc định đổi từ `https://api.v4.stg.sotaagents.ai` sang `https://api.v4.sotaagents.ai`. Manifest có môi trường `stg`, nên hosted phải đặt `SOTA_CORE_ORIGIN` tường minh.

## 2. Tổng quan các giai đoạn

| GĐ | Tên | Kết quả chính | Phụ thuộc |
|---|---|---|---|
| 0 | Chốt quyết định chặn | Các câu hỏi mục 11 của thiết kế được trả lời, dọn nợ nhỏ | — |
| 1 | Nền tảng: OpenRouter và Qdrant | Embedding client, Qdrant client, module tenant filter | GĐ0 |
| 2 | Luồng index | Webhook → queue → worker → Qdrant chạy được | GĐ1 |
| 3 | Luồng kiểm tra trùng mới | `check-duplicates` lấy ứng viên từ Qdrant | GĐ1 (song song GĐ2 được nhờ seed data) |
| 4 | Vòng đời dữ liệu | Backfill, cập nhật/xoá, callback trạng thái, cache | GĐ2 và GĐ3 |
| 5 | Hardening và release | Test bảo mật, observability, deploy stg → prod | GĐ4 |

Mốc MVP là hết GĐ3: một ý tưởng được duyệt → được index → kiểm tra trùng tìm thấy nó, chạy trên stg.

```
GĐ0 → GĐ1 ─┬→ GĐ2 ─┐
           └→ GĐ3 ─┴→ GĐ4 → GĐ5
```

## 3. GĐ0: Chốt quyết định chặn

Giai đoạn này không viết code. Chỉ các điểm sau thật sự chặn các giai đoạn sau.

- [x] **Auth webhook và tách dữ liệu theo workspace (mục 11 #2).** Đã chốt API key đặt trong env để xác thực BE. Phần tách dữ liệu theo `datasetKey` (chốt 2026-11-03) đã **bị bỏ ngày 2026-11-04**: mọi sáng kiến nằm chung một tập dữ liệu, xem mục 3.2 dòng 9 và "Điểm mở còn lại".
- [x] **Hướng A hay B ở luồng 1 (#4).** Đã chọn hướng A (lấy tất cả ứng viên), xem mục 3.2.
- [x] **Payload Qdrant và chunk (#5, #7).** Đã chốt, xem mục 3.2.
- [x] **Embedding model và nơi gọi (#6).** Đã chốt `openai/text-embedding-3-small` qua OpenRouter.
- [x] **Giữ SotaAgents Core trong luồng 1 hay không (#1).** Đã chốt giữ qua Core.
- [x] **File đính kèm.** Ban đầu chốt theo khuyến nghị; sau đó đổi theo diagram `Final1.png`: BE gửi `fileRef` (tham chiếu file trong MinIO của VNAIP), xem mục 3.3. MinIO chưa có nên phần này là `#TODO`.
- [x] **Cách khai báo webhook trong manifest.** Đã khảo sát ngày 2026-11-03, xem mục 3.1: manifest không có chỗ khai báo webhook từ hệ thống ngoài.
- [ ] **Xác định claim nhận diện BE (cách A).** Deploy Staging với `LOG_VERIFIED_CLAIMS=true`, để BE gọi tool `check-duplicates` một lần, đọc log `invocation_accepted` để biết `sub` hoặc claim nào cố định cho service account của BE. Từ khi bỏ `datasetKey`, claim này dùng để **giới hạn ai được gọi tool** (không còn để tin `datasetKey`). Nếu không có claim nào dùng được thì giới hạn theo `oid`/`wid` của VNAIP.
- [ ] **Dọn nợ.** Commit `sota-auth.ts` (nay gồm cả log claims tạm), đặt `SOTA_CORE_ORIGIN` cho từng môi trường hosted.

### 3.1 Kết quả khảo sát GĐ0 (2026-11-03, sota CLI 1.16.1)

**Đã xác minh bằng CLI:**

- `sota validate` đạt (server-side preflight) với manifest hiện tại.
- Manifest v3 không có chỗ khai báo webhook gọi từ hệ thống ngoài. `events` / `events_consume` chỉ nhận Bus hoặc App Data CDC (topic dạng `appdata.<app>:<collection>@<n>.insert|update|replace|delete`) qua signed delivery từ Core (`sota manifest explain skills.event`). `lifecycle` (softDelete, archive, erase, export) cũng là Core gọi app.
- Hệ quả: webhook index là một route HTTP thường trên `service.baseUrl` công khai, không khai báo trong manifest, không đi qua Core nên không có JWT và không có claims `iid/oid/wid`. App phải tự xác thực, và tenant của dữ liệu index không thể lấy từ claims. Đây là lý do cần chốt tenant binding trước GĐ2.
- Manifest có khai báo `env` (tên biến, đánh dấu `required`/`secret`) và `sota env template` / `sota env check` dùng được cho GĐ1 (OpenRouter, Qdrant, secret webhook). Chỉ lưu tên, không lưu giá trị.
- Staging đang chạy 1.0.0 (deploy khoảng 9 giờ trước thời điểm khảo sát), Production chưa có.
- Schema của `timeoutMs` tool chỉ có `minimum: 1`, không có `maximum`. Giới hạn thật của Core vẫn chưa xác minh.

**Chưa xác minh được:**

- `SOTA_CORE_ORIGIN` trong `.env` local là `https://api.v4.sotaagents.ai` (Core production) và mặc định trong `sota-auth.ts` (chưa commit) cũng đã đổi sang origin này, trước đó là `api.v4.stg...`. Chưa biết service Staging trên Render đặt biến này là gì, và Core nào ký token cho môi trường Staging. Cần kiểm tra biến môi trường trên Render trước khi commit thay đổi mặc định.

**Các câu hỏi đã đặt ra (đã trả lời, xem mục 3.2):**

| # | Câu hỏi | Khuyến nghị |
|---|---|---|
| 1 | Webhook index dùng JWT, API key hay HMAC? Tenant (org/workspace) của dữ liệu index xác định thế nào khi webhook không có claims? | HMAC kèm timestamp. Tenant cố định theo deployment hoặc ánh xạ từ credential, không lấy từ body |
| 2 | Luồng 1 dùng hướng A hay B? | B (top-k), kèm `k` và ngưỡng ban đầu |
| 3 | Payload Qdrant có `content` đầy đủ hay rút gọn? Có chia chunk không? | Lưu `ideaId`, `type`, `title`, nội dung chunk, `metadata`; gom theo `ideaId` khi query |
| 4 | Embedding model nào, gọi qua OpenRouter? | Chốt một model, ghi tên model vào payload hoặc tên collection |
| 5 | BE gọi luồng 1 qua Core hay gọi thẳng Sota App? | Giữ qua Core (hiện đã chạy với JWT) |
| 6 | File đính kèm: định dạng, dung lượng tối đa, link có cần quyền không, xử lý khi không đọc được file | Không đọc được file thì vẫn index `title` + `content` và ghi cờ lỗi |

**Việc dọn nợ còn lại:** đã xác nhận (2026-11-04) `SOTA_CORE_ORIGIN` trên Render là `https://api.v4.sotaagents.ai`, khớp mặc định mới trong `sota-auth.ts`. File này vẫn chưa commit, chờ đồng ý.

### 3.2 Quyết định đã chốt (2026-11-03)

| # | Chủ đề | Quyết định |
|---|---|---|
| 1 | Auth webhook và tách dữ liệu theo workspace | Hai key khác nhau. (a) API key chung, giá trị bất kỳ, đặt trong env của app, xác thực VNAIP BE ở webhook. (b) ~~Key phân vùng `datasetKey` do BE gửi...~~ **Đã bỏ ngày 2026-11-04** (dòng 9): không tách dữ liệu theo workspace nữa |
| 2 | Luồng 1 | Hướng A: lấy tất cả ứng viên từ Qdrant rồi để LLM chấm, không embed (1) ở luồng 1 |
| 3 | Payload Qdrant | `ideaId`, `type`, `title`, nội dung chunk, `metadata`. Có chia chunk, gom theo `ideaId` khi query |
| 4 | Embedding | `openai/text-embedding-3-small` qua OpenRouter (vector 1536 chiều) |
| 5 | Đường gọi luồng 1 | Giữ BE → SotaAgents Core → Sota App (JWT) |
| 6 | File đính kèm | Không đọc được file thì vẫn index `title` + `content` và ghi cờ lỗi |
| 7 | Queue (2026-11-04, đã đổi) | **BullMQ (Redis)**, theo diagram `Final1.png`; thay cho RabbitMQ đã chọn trước đó (mã RabbitMQ đã gỡ). Worker `concurrency = 1` cộng giới hạn toàn cục bằng 1 trong Redis; retry do BullMQ giữ (`attempts` + backoff tuỳ chỉnh); job lỗi nằm ở tập `failed`. Redis: xem dòng 10 |
| 8 | File đính kèm, cập nhật theo diagram (2026-11-04) | BE gửi `fileRef`, không gửi file hay link. Worker tải file từ MinIO của VNAIP bằng quyền chỉ đọc, trích text bằng CPU, chia chunk, rồi xoá file tạm. **MinIO: `#TODO`** (VNAIP chưa có: endpoint, bucket, credential chỉ đọc, định dạng `fileRef`). Hiện event nhận `fileRef`, job mang theo, worker bỏ qua và ghi log. Giới hạn đã đồng ý từ trước (20 MB, 30 giây xử lý, 500.000 ký tự văn bản trích ra) áp dụng khi làm phần file |
| 9 | Bỏ `datasetKey` (2026-11-04) | Không tách dữ liệu theo workspace: mọi sáng kiến của VNAIP nằm chung một tập dữ liệu trong collection của môi trường. Event không cần `datasetKey` (nếu BE vẫn gửi thì bị bỏ qua). Thay quyết định #1(b). Hệ quả: xem "Điểm mở còn lại" |
| 10 | Redis (2026-11-04) | Tự host. `maxmemory-policy noeviction`. **AOF tắt** (sẽ bật nếu cần): Redis khởi động lại thì job đang chờ bị mất, nên BE phải gửi lại event chưa thấy được index (an toàn vì index idempotent theo `id`). Tách khỏi Redis cache của BE. Chưa dựng Redis thật; chưa biết có TLS không (code đang đòi `rediss://` trừ localhost) |
| 11 | Worker (2026-11-04) | Tách khỏi tiến trình web: `src/backend/worker.ts`, chạy bằng `npm run start:worker` (dev: `npm run dev:worker`). Web chỉ là producer, không cần khoá OpenRouter/Qdrant. Job mang đủ `id`, `type`, `title`, `content`, `metadata`, `fileRef` để worker không phải hỏi lại BE |

**Hệ quả của các quyết định:**

- Hướng A không dùng vector khi truy vấn, nên embedding chỉ phục vụ luồng index. Vector vẫn được lưu để có thể chuyển sang top-k sau này mà không phải index lại.
- Hướng A gửi toàn bộ ứng viên cho LLM, nên chi phí token và độ trễ tăng theo số sáng kiến; từ khi bỏ `datasetKey` đó là toàn bộ sáng kiến của VNAIP chứ không chỉ một workspace. Tool có `timeoutMs: 15000`. Cần chấm theo batch song song, và nếu đặt trần số ứng viên thì trần đó cắt tuỳ ý (không có độ tương đồng để xếp hạng) nên có thể bỏ sót sáng kiến trùng.
- API key webhook chỉ chứng minh người gọi biết bí mật. Nên so sánh bằng hàm hằng thời gian (constant-time), chỉ nhận qua HTTPS, có rate limit, và có cách đổi key mà không phải deploy lại code.

**Điểm mở còn lại:**

- **Không tách dữ liệu theo workspace (quyết định 2026-11-04, thay quyết định ngày 2026-11-03).** Bỏ `datasetKey`: mọi sáng kiến của VNAIP nằm chung một tập dữ liệu trong collection của môi trường. Đã gỡ khỏi code: `DatasetKeyHash`, `hashDatasetKey`, `DATASET_KEY_HASH_SECRET`, filter theo dataset (`scrollDataset` thành `scrollAll`, `deleteDataset` bỏ). Event còn mang `datasetKey` thì bị bỏ qua. Collection thử nghiệm cũ đã xoá nên không cần migrate.
- **Hệ quả cần theo dõi:**
  - Không còn lớp cách ly ở tầng lưu trữ: ai gọi được tool `check-duplicates` là thấy mọi sáng kiến của VNAIP. App cài vào nhiều workspace Sota, nên quyền gọi tool phải giới hạn bằng claims đã xác thực của Core (đúng quy tắc `CLAUDE.md`, không dùng trường từ body hay header không ký). Cách A cũ nay dùng cho việc này: chỉ chấp nhận lời gọi có claim (ví dụ `sub` của service account BE, hoặc `oid`/`wid` của VNAIP) nằm trong danh sách cho phép đặt ở env; không khớp trả 403. Tool có mô tả hiển thị cho model nên có thể được agent gọi (quyền gọi cụ thể chưa xác minh). Log tạm `invocation_accepted` (bật bằng `LOG_VERIFIED_CLAIMS=true`, chỉ ghi các claims trong allow-list, không ghi token) dùng để xem claim thật từ BE trên Staging.
  - `id` sáng kiến phải duy nhất trong toàn VNAIP: gửi lại cùng `id` là cập nhật sáng kiến đó. Hai sáng kiến khác nhau mà trùng `id` sẽ ghi đè nhau.
  - Input tool `check-duplicates` sẽ không có `datasetKey`. Schema hiện có `additionalProperties: false`, nên nếu BE đã gửi trường này khi gọi tool thì bị từ chối: BE cần ngừng gửi.
- **Trần số ứng viên** gửi cho LLM ở hướng A, và ngưỡng số sáng kiến để chuyển sang hướng B.

### 3.3 Thay đổi theo diagram `Final1.png` (2026-11-04)

Diagram luồng index mới (file nằm ngoài repo) thay đổi các điểm sau so với những gì đã làm:

| Hạng mục | Trước | Theo diagram | Đã làm / còn lại |
|---|---|---|---|
| Queue | RabbitMQ (CloudAMQP) | BullMQ trên Redis | Đã thay `rabbitmq-queue.ts` bằng `bullmq-queue.ts`, gỡ `amqplib`, xoá URL RabbitMQ khỏi `.env`. Đã chạy thật trên Redis cục bộ; chưa có Redis hosted |
| File đính kèm | `fileLinks`, rồi "BE gửi file trực tiếp" | `fileRef` tham chiếu file trong MinIO của VNAIP; worker tải bằng quyền chỉ đọc | Event nhận `fileRef`, job mang theo, worker bỏ qua và ghi `fileSkipped`. Tải file, trích text, xoá file tạm: **`#TODO`** |
| MinIO | — | Kho file của VNAIP (hệ thống hiện có) | **`#TODO`**: VNAIP chưa có. Cần endpoint, bucket, access key và secret chỉ đọc, định dạng `fileRef`. `.env.example` có sẵn các biến `MINIO_*` để `#TODO` |
| Worker | Chạy chung tiến trình web | "trích text bằng CPU" | **Đã tách (2026-11-04)** thành tiến trình riêng `worker.ts` để việc trích text sau này không chặn webhook và `/health` |

**Đã xác nhận (2026-11-04):**

1. Không cần `datasetKey` nữa: đã gỡ khỏi code, xem "Điểm mở còn lại" ở mục 3.2.
2. Redis tự host, đặt `noeviction`, không bật AOF (sẽ bật nếu cần). Hệ quả khi không có AOF: Redis khởi động lại thì mất job đang chờ (mục 9).
3. Tách worker khỏi tiến trình web: đã làm (`worker.ts`), xem GĐ2.
4. Worker cần nhận đủ thông tin: job mang `id`, `type`, `title`, `content`, `metadata` và `fileRef` (diagram ghi gọn là `{metadata, fileRef}`).

**Còn mở:** Redis tự host có TLS không? Code đòi `rediss://` trừ localhost; nếu Redis chạy trong mạng nội bộ không TLS thì cần thêm một biến cho phép `redis://` có chủ đích.

## 4. GĐ1: Nền tảng OpenRouter và Qdrant

- [x] Embedding client qua OpenRouter (`src/backend/openrouter-embeddings.ts`): gọi `POST {baseUrl}/embeddings`, chia batch tuần tự, kiểm số chiều, phân loại lỗi có cờ `retryable`, có mock mode. Phần chat client chưa làm, chuyển sang GĐ3: `llm-scorer.ts` đang ghép URL bằng `new URL("/v1/chat/completions", baseUrl)`, với `https://openrouter.ai/api/v1` sẽ ra `https://openrouter.ai/v1/chat/completions` (mất `/api`).
- [x] Qdrant client (`src/backend/qdrant-store.ts`, REST bằng fetch): tạo collection (1536 chiều, cosine) và kiểm cấu hình nếu đã có, upsert, scroll, delete theo filter. Không làm `search` vì luồng 1 theo hướng A; thêm khi chuyển sang hướng B. Có store trong bộ nhớ (`InMemoryVectorStore`) cho test, seed và `QDRANT_MOCK_MODE`.
- [x] Gom mọi truy vấn Qdrant vào một module duy nhất (`qdrant-store.ts`; `ensureCollection()` tạo payload index cho `ideaId` và `chunkIndex`; mọi thao tác xoá đi qua `ideaFilter()` nên không có đường xoá cả collection). Bản đầu có `datasetFilter()` và `datasetKeyHash` để tách workspace; đã gỡ ngày 2026-11-04 khi bỏ `datasetKey`. Mỗi deployment (stg, prod) dùng collection riêng.
- [~] Cấu hình qua env. Code đọc env và `.env.example` đã cập nhật; secret không vào manifest, repo, log hay thông báo lỗi. Chưa khai báo `env` trong `manifest.yaml`: làm khi nối vào server (GĐ2/GĐ3), vì `sota env template --write` sẽ render lại `.env.example` từ manifest và có thể ghi đè các ghi chú hiện có.
- [x] Quy ước point ID (`pointId()` = UUID v5 từ `ideaId + chunkIndex`): Qdrant chỉ nhận số nguyên không dấu hoặc UUID. Mục 5.3 của thiết kế nói dùng `id` sáng kiến làm point ID, nhưng mục 9 lại chia nhiều chunk. Dùng UUID xác định từ `ideaId + chunkIndex`, còn `ideaId` nằm trong payload để gom nhóm và xoá theo filter. (Bản đầu có thêm `datasetKeyHash` trong tên; đã bỏ ngày 2026-11-04.)

Xong khi: unit test cho các client (có mock), tạo collection và upsert/scroll chạy được với Qdrant thật hoặc local.

Trạng thái (2026-11-04): khung đã xong và chưa nối vào `server.ts`, nên hành vi app không đổi. 79 test đạt (Node 22), typecheck, build và `sota validate` đạt. Test dùng server HTTP giả. Đã gọi OpenRouter thật cùng ngày: 3 vector 1536 chiều, độ dài L2 xấp xỉ 1, văn bản cùng chủ đề gần nhau hơn (cosine 0.677 so với 0.311), khoảng 2 giây cho một lô 3 văn bản. Đã chạy trên Qdrant Cloud thật (cluster `sa-east-1`, URL không cần `:6333`): `ensureCollection` (kể cả chạy lại), upsert (kể cả ghi lại lần hai không nhân đôi), scroll, `deleteIdea`, `deleteDataset`, và hai dataset trùng `ideaId` không lẫn nhau; collection thử nghiệm đã được xoá. **GĐ1 đạt tiêu chí "xong khi".** Script thử nghiệm nằm ngoài repo, chưa có lệnh `npm` cho việc này. (Ghi chú 2026-11-04: phần `deleteDataset` và "hai dataset không lẫn nhau" nói trên đã lỗi thời vì `datasetKey` đã bị bỏ; được kiểm lại bằng lần chạy ở GĐ2.)

## 5. GĐ2: Luồng index

- [x] Route webhook `POST /webhooks/idea-approved` (`webhook-routes.ts`): API key qua `Authorization: Bearer` hoặc `x-api-key`, so sánh hằng thời gian, nhận nhiều key (`WEBHOOK_API_KEYS`) để đổi key không ngừng nhận event. Validate event (`index-event.ts`), enqueue rồi trả `202`; queue không nhận được thì trả `503`, không bao giờ trả `202` giả. Chưa cấu hình thì trả `503 WEBHOOK_NOT_CONFIGURED` thay vì làm app sập.
- [x] Idempotent khi BE gửi lại event (point ID xác định; có test gửi lại không nhân đôi).
- [x] Queue BullMQ (Redis) chạy tuần tự (mục 3.2, dòng 7), `bullmq-queue.ts` cài giao diện `JobQueue`: worker `concurrency = 1` và giới hạn toàn cục bằng 1, publish chỉ thành công khi Redis đã lưu job (`202` đi sau đó) và có timeout riêng vì BullMQ chờ vô hạn nếu Redis chưa từng kết nối được, mất kết nối thì webhook trả 503 nhanh và tự chạy lại khi Redis sống lại, retry bằng `attempts` + backoff tuỳ chỉnh (lỗi `dead` ném `UnrecoverableError` nên vào tập `failed` ngay), job xong xoá sau 1 giờ và job lỗi xoá sau 14 ngày. Đã thử trên Redis thật cục bộ (12 test, trong đó có kịch bản Redis chết rồi sống lại). **Chưa thử trên Redis hosted** vì chưa có.
- [x] Worker (`index-job.ts`): chia chunk (`chunker.ts`), embed (mỗi chunk kèm tiêu đề), upsert, rồi mới dọn chunk thừa, nên sáng kiến không biến mất khỏi Qdrant giữa chừng và embedding lỗi thì dữ liệu cũ còn nguyên. Chạy ở tiến trình riêng (mục dưới). Phần file đính kèm xem mục `#TODO` MinIO; `fileRef` hiện được mang theo trong job và bỏ qua, log chỉ ghi `fileSkipped`.
- [x] Retry có giới hạn: lỗi `retryable` thử lại với độ trễ tăng gấp đôi (mặc định 5 lần, 10 giây đến 5 phút), lỗi khác hoặc hết số lần thì vào tập `failed` của BullMQ; log theo `jobId`, `ideaId`, mã lỗi và kết quả, không có nội dung. Chưa có cách báo kết quả về BE (câu hỏi callback #3 ở GĐ4).
- [x] Worker chạy tách khỏi tiến trình web (2026-11-04). `index-service.ts` có hai vai: `startWebhookService` (web, chỉ là producer, không cần khoá OpenRouter/Qdrant, `webhook_service_started`) và `startIndexWorker` (`worker.ts`, không mở cổng HTTP, `index_worker_started`). Thiếu cấu hình thì worker thoát mã 1 (`worker_failed`) để nền tảng báo hỏng ngay, còn web vẫn khởi động và webhook trả 503. Web và worker phải dùng cùng `REDIS_URL`, `QUEUE_PREFIX`, `QUEUE_NAME` (lệch prefix thì job nằm đó không ai xử lý) và nên cùng `INDEX_MAX_ATTEMPTS`. Triển khai: một dịch vụ thứ hai (ví dụ Render Background Worker) từ cùng repo và cùng bước build, lệnh chạy `npm run start:worker`; `sota dev` không chạy worker nên dev cục bộ chạy thêm `npm run dev:worker`. Ngoại lệ: `QUEUE_MOCK_MODE=true` dùng hàng đợi trong bộ nhớ nên web tự chạy worker trong tiến trình (chỉ cục bộ), và `worker.ts` từ chối chế độ này. Đã bỏ biến `INDEX_WORKER_ENABLED`.
- [x] Tắt êm khi nhận SIGTERM/SIGINT, cả web lẫn worker: web ngừng nhận request rồi đóng kết nối Redis; worker ngừng nhận job mới, chờ job đang chạy xong (tối đa 20 giây). Quá hạn 25 giây thì thoát cưỡng bức; job dở dang được BullMQ xếp lại (stalled) cho lần chạy sau. Đã kiểm tra trên tiến trình thật.
- [ ] **#TODO MinIO.** Tải file theo `fileRef` bằng quyền chỉ đọc, trích text bằng CPU (PDF, DOCX), chia chunk rồi xoá file tạm trên server (kể cả khi lỗi). Bị chặn vì VNAIP chưa có MinIO. Cần chốt trước: định dạng `fileRef` (khoá object, bucket hay URL?), endpoint, bucket, credential chỉ đọc. Khi làm cần: coi `fileRef` là khoá object hợp lệ chứ không phải URL tuỳ ý, giới hạn dung lượng, kiểm chữ ký file, chặn zip bomb, đặt thời hạn trích text, và chạy ở tiến trình worker riêng.

Xong khi: gửi event giả thì thấy point trong Qdrant, gửi lại event không tạo bản ghi trùng, auth sai bị từ chối.

Trạng thái (2026-11-04): đã chạy thật được từ đầu đến cuối với hai tiến trình riêng. 142 test đạt (Node 22; 7 test tích hợp chỉ chạy khi có `REDIS_TEST_URL`), typecheck, build và `sota validate` đạt. Kiểm tra đầu-cuối: web (`server.ts`, **không được cấp khoá OpenRouter/Qdrant**) → BullMQ (Redis cục bộ) → worker (`worker.ts`, tiến trình riêng) → OpenRouter thật → Qdrant Cloud thật, mỗi lần dùng tiền tố khoá và collection riêng rồi xoá. Đạt: worker thiếu cấu hình thoát mã 1; khi chưa có worker, web vẫn trả 202 và job nằm chờ trong Redis; bật worker thì nó nhặt job và ghi 5 chunk; sai key trả 401; gửi lại cùng event không nhân đôi; index lại bản rút gọn dọn còn 1 chunk; tắt worker rồi gửi event khác thì web vẫn trả 202, bật lại thì job được xử lý; hàng đợi và tập `failed` rỗng; SIGTERM tắt êm mã 0 cho cả web lẫn worker; log của cả hai không chứa khoá, `fileRef`, `datasetKey` cũ, tiêu đề hay nội dung. **Còn thiếu để đạt "xong khi" đầy đủ:** phần file/MinIO (`#TODO`), Redis tự host thật (chưa thử TLS, AOF), rate limit và chống replay cho webhook (GĐ5).

## 6. GĐ3: Luồng kiểm tra trùng mới

- [ ] Thay `findVnaipCandidates` bằng truy vấn Qdrant theo hướng A: `scrollAll()` toàn bộ point (không còn lọc theo dataset), loại các id trong `excludeIds`, gom chunk theo `ideaId`. Không embed (1) ở luồng này.
- [ ] Không thêm `datasetKey` vào `dedup-input.schema.json` (đã bỏ). Schema giữ `additionalProperties: false`.
- [ ] Giới hạn ai được gọi tool: middleware kiểm claims đã xác thực (danh sách cho phép đặt trong env, ví dụ `sub` của BE hoặc `oid`/`wid` của VNAIP); không khớp trả 403, có test. Cần biết claim thật từ Staging (xem GĐ0, mục "Xác định claim nhận diện BE").
- [ ] Chấm điểm theo batch chạy song song để nằm trong `timeoutMs`, và quyết định trần số ứng viên (xem mục 3.2).
- [ ] Đổi `excludeId` thành `excludeIds` ở `dedup-input.schema.json` (thiết kế dùng mảng, code hiện dùng một giá trị). Giữ output `{matches:[{type,id,score,reason}]}`.
- [ ] LLM scorer chuyển sang OpenRouter, giữ các bước kiểm tra kết quả sẵn có (id phải thuộc ứng viên, percent hợp lệ, reason không rỗng). Sửa cách ghép URL trong `llm-scorer.ts` để giữ phần `/api/v1` của `OPENROUTER_BASE_URL`.
- [ ] Xoá `vnaip-client.ts` và mock VNAIP khỏi đường production.
- [ ] Script seed dữ liệu để phát triển song song với GĐ2.

Xong khi: test giới hạn người gọi (claims không khớp bị từ chối), thời gian trả lời nằm trong 15 giây, `sota validate` và build đạt.

## 7. GĐ4: Vòng đời dữ liệu

- [ ] Backfill một lần cho các sáng kiến đã duyệt trước đây. Script phải chạy lại được, không tạo trùng.
- [ ] Event cập nhật, thu hồi, huỷ duyệt → sửa hoặc xoá point.
- [ ] Quyết định có cần callback trạng thái index về BE không (#3).
- [ ] Phối hợp với BE chính sách hết hạn cache Redis khi dữ liệu Qdrant thay đổi.
- [ ] Xử lý khoảng trễ index: sáng kiến vừa duyệt có thể chưa tìm thấy ngay.

## 8. GĐ5: Hardening và release

- [ ] Test bảo mật: replay và timestamp webhook, rate limit, người gọi tool không được phép, cross-environment, SSRF.
- [ ] Log có cấu trúc, health/readiness (kiểm Qdrant với timeout ngắn), theo dõi chi phí token.
- [ ] Cảnh báo khi worker không chạy hoặc hàng đợi tồn đọng (web vẫn trả 202 khi worker chết), và khi có job vào tập `failed`.
- [ ] Chỉnh ngưỡng và `k` bằng dữ liệu thật.
- [ ] Gỡ mọi `.invalid` và localhost khỏi cấu hình hosted.
- [ ] `sota validate` và build đạt, deploy stg rồi mới tới production.

## 9. Rủi ro cần theo dõi

| Rủi ro | Giai đoạn | Cách giảm |
|---|---|---|
| Không còn tách dữ liệu theo workspace: ai gọi được tool là đọc được mọi sáng kiến VNAIP | GĐ3, GĐ5 | Kiểm claims đã xác thực của người gọi (danh sách cho phép trong env), 403 nếu không khớp, có test; xác minh quyền gọi tool của các workspace khác cài app |
| Hướng A vượt timeout 15 giây hoặc tốn token khi dữ liệu tăng | GĐ3, GĐ5 | Chấm batch song song, đo thời gian với dữ liệu thật, đặt ngưỡng số sáng kiến để chuyển sang hướng B (vector đã được lưu sẵn) |
| Đổi embedding model sau khi index | GĐ1, GĐ4 | Ghi tên model và version vào payload hoặc tên collection, cần reindex khi đổi |
| Redis tự host không bật AOF: khởi động lại là mất job đang chờ | GĐ2 | BE gửi lại event chưa thấy được index (idempotent theo `id`); bật AOF khi cần; luôn đặt `noeviction`; hàng trong bộ nhớ chỉ dùng cục bộ (`QUEUE_MOCK_MODE=true`), không bao giờ bật ở hosted |
| Webhook là điểm vào công khai, không qua Core | GĐ2, GĐ5 | API key so sánh hằng thời gian, nhiều key để đổi key; còn thiếu rate limit và chống replay (GĐ5) |
| Web và worker cấu hình lệch (`REDIS_URL`, `QUEUE_PREFIX`, `QUEUE_NAME`) | GĐ2, GĐ5 | Job nằm trong Redis mà không ai xử lý và không có lỗi. Đặt cùng một bộ giá trị cho hai dịch vụ; cảnh báo hàng đợi tồn đọng (GĐ5) |
| Worker chết nhưng web vẫn trả 202 | GĐ2, GĐ5 | Job dồn trong Redis; `noeviction` nên khi Redis đầy thì publish lỗi và webhook trả 503. Cần theo dõi độ sâu hàng đợi và tuổi job cũ nhất (GĐ5) |
| Cache BE trả kết quả cũ | GĐ4 | Thống nhất chính sách hết hạn với BE |

## 10. Việc chưa kiểm tra

- Client OpenRouter và Qdrant đã chạy thật ở GĐ1 và GĐ2 (embedding, tạo, ghi, đọc, xoá trên collection tạm). Chưa thử tải lớn (nhiều nghìn point), giới hạn tốc độ hay độ trễ khi scroll toàn bộ collection theo hướng A.
- Chưa biết claim nào của token nhận diện được service account của BE (cần log `invocation_accepted` từ Staging). Claim này giờ dùng để giới hạn ai được gọi tool.
- Test cần Node 20 trở lên; máy phát triển đang mặc định Node 18 nên phải `nvm use 22` trước khi chạy `npm test`.
- Quyền gọi tool `check-duplicates` ngoài BE (ví dụ agent trong workspace cài app) chưa được xác minh.
