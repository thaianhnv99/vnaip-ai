# Kế hoạch phát triển vnaip-dedup theo thiết kế mới

> Nguồn: `vnaip-dedup-design.md` (thiết kế tổng hợp từ phản hồi của anh Hưng).
> Phạm vi: chia công việc thành các giai đoạn phát triển, có phụ thuộc và tiêu chí xong.
> Ngày lập: 2026-11-03. Trạng thái: bản nháp, chưa có giai đoạn nào hoàn thành.

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

- [x] **Auth webhook và tách dữ liệu theo workspace (mục 11 #2).** Đã chốt: API key đặt trong env xác thực BE, dữ liệu tách theo `datasetKey` (id workspace VNAIP) do BE gửi, và chỉ tin key này khi claims xác thực khớp BE (cách A, mục 3.2).
- [x] **Hướng A hay B ở luồng 1 (#4).** Đã chọn hướng A (lấy tất cả ứng viên), xem mục 3.2.
- [x] **Payload Qdrant và chunk (#5, #7).** Đã chốt, xem mục 3.2.
- [x] **Embedding model và nơi gọi (#6).** Đã chốt `openai/text-embedding-3-small` qua OpenRouter.
- [x] **Giữ SotaAgents Core trong luồng 1 hay không (#1).** Đã chốt giữ qua Core.
- [x] **File đính kèm.** Đã chốt theo khuyến nghị, xem mục 3.2. Định dạng và dung lượng tối đa vẫn cần số cụ thể ở GĐ2.
- [x] **Cách khai báo webhook trong manifest.** Đã khảo sát ngày 2026-11-03, xem mục 3.1: manifest không có chỗ khai báo webhook từ hệ thống ngoài.
- [ ] **Xác định claim nhận diện BE (cách A).** Deploy Staging với `LOG_VERIFIED_CLAIMS=true`, để BE gọi tool `check-duplicates` một lần, đọc log `invocation_accepted` để biết `sub` hoặc claim nào cố định cho service account của BE. Nếu không có claim nào dùng được thì chuyển sang cách B.
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
| 1 | Auth webhook và tách dữ liệu theo workspace | Hai key khác nhau. (a) API key chung, giá trị bất kỳ, đặt trong env của app, xác thực VNAIP BE ở webhook. (b) Key phân vùng (tên tạm `datasetKey`) do BE gửi cùng dữ liệu ở webhook index và gửi lại trong input tool `check-duplicates`. Mỗi workspace chỉ kiểm tra trên dữ liệu có cùng key (câu trả lời ngày 2026-11-04) |
| 2 | Luồng 1 | Hướng A: lấy tất cả ứng viên từ Qdrant rồi để LLM chấm, không embed (1) ở luồng 1 |
| 3 | Payload Qdrant | `ideaId`, `type`, `title`, nội dung chunk, `metadata`. Có chia chunk, gom theo `ideaId` khi query |
| 4 | Embedding | `openai/text-embedding-3-small` qua OpenRouter (vector 1536 chiều) |
| 5 | Đường gọi luồng 1 | Giữ BE → SotaAgents Core → Sota App (JWT) |
| 6 | File đính kèm | Không đọc được file thì vẫn index `title` + `content` và ghi cờ lỗi |

**Hệ quả của các quyết định:**

- Hướng A không dùng vector khi truy vấn, nên embedding chỉ phục vụ luồng index. Vector vẫn được lưu để có thể chuyển sang top-k sau này mà không phải index lại.
- Hướng A gửi toàn bộ ứng viên cho LLM, nên chi phí token và độ trễ tăng theo số sáng kiến. Tool có `timeoutMs: 15000`. Cần chấm theo batch song song, và nếu đặt trần số ứng viên thì trần đó cắt tuỳ ý (không có độ tương đồng để xếp hạng) nên có thể bỏ sót sáng kiến trùng.
- API key webhook chỉ chứng minh người gọi biết bí mật. Nên so sánh bằng hàm hằng thời gian (constant-time), chỉ nhận qua HTTPS, có rate limit, và có cách đổi key mà không phải deploy lại code.

**Điểm mở còn lại:**

- **Tách dữ liệu theo workspace (đã trả lời 2026-11-04).** BE gửi `datasetKey` cùng dữ liệu ở webhook index và gửi lại đúng key đó trong input tool `check-duplicates`. App ghi key vào payload mỗi point, luồng 1 chỉ đọc point có key khớp. Claims `oid/wid` trong token vẫn dùng để xác thực lời gọi nhưng không dùng để tách dữ liệu, vì webhook không có claims để ghi vào point. Phương án "mỗi workspace một API key trong env của BE" đã bị loại vì BE chỉ có một.
- **Ngoại lệ so với quy tắc tenant trong `CLAUDE.md`, cần bạn xác nhận.** `datasetKey` do người gọi cung cấp trong body hoặc input tool, không phải claim đã xác thực. `datasetKey` là id workspace của VNAIP (bạn xác nhận 2026-11-04), không phải bí mật và có thể đoán được. Cách cách ly này chỉ đúng nếu mọi lời gọi mang key đều đến từ BE. Biện pháp đề xuất:
  - Đã chọn cách A (2026-11-04): chỉ chấp nhận lời gọi có claims đã xác thực khớp danh tính service account của BE (ví dụ `sub` cố định trong env), và chỉ khi đó mới tin `datasetKey` trong input. Tool có mô tả hiển thị cho model nên có thể được agent gọi (quyền gọi cụ thể chưa xác minh), vì vậy lời gọi không khớp danh tính BE phải bị từ chối. Điều kiện để làm được: biết claim nào của token nhận diện được BE. Đã thêm log tạm `invocation_accepted` (bật bằng `LOG_VERIFIED_CLAIMS=true`, chỉ ghi các claims trong allow-list, không ghi token) để xem một token thật từ BE trên Staging. Nếu không có claim nào nhận diện được BE thì chuyển sang cách B (BE ký `datasetKey` bằng HMAC với secret chung).
  - Qdrant chỉ lưu băm của key (HMAC với secret của app), không ghi key thô vào Qdrant, log hay tool output.
  - Thiếu hoặc rỗng `datasetKey` thì từ chối, không bao giờ mặc định là toàn bộ dữ liệu. Filter nằm trong module Qdrant duy nhất.
  - Test: key A không đọc được dữ liệu của key B, không có key thì báo lỗi.
- **Vòng đời key.** Ai sinh `datasetKey` (BE hay app), BE lưu ở đâu (DB của BE, không phải env), cách đổi key, và cách xoá toàn bộ dữ liệu của một workspace khi gỡ.
- **Trần số ứng viên** gửi cho LLM ở hướng A, và ngưỡng số sáng kiến để chuyển sang hướng B.

## 4. GĐ1: Nền tảng OpenRouter và Qdrant

- [x] Embedding client qua OpenRouter (`src/backend/openrouter-embeddings.ts`): gọi `POST {baseUrl}/embeddings`, chia batch tuần tự, kiểm số chiều, phân loại lỗi có cờ `retryable`, có mock mode. Phần chat client chưa làm, chuyển sang GĐ3: `llm-scorer.ts` đang ghép URL bằng `new URL("/v1/chat/completions", baseUrl)`, với `https://openrouter.ai/api/v1` sẽ ra `https://openrouter.ai/v1/chat/completions` (mất `/api`).
- [x] Qdrant client (`src/backend/qdrant-store.ts`, REST bằng fetch): tạo collection (1536 chiều, cosine) và kiểm cấu hình nếu đã có, upsert, scroll, delete theo filter. Không làm `search` vì luồng 1 theo hướng A; thêm khi chuyển sang hướng B. Có store trong bộ nhớ (`InMemoryVectorStore`) cho test, seed và `QDRANT_MOCK_MODE`.
- [x] Gom mọi truy vấn Qdrant vào một module duy nhất (`datasetFilter()` trong `qdrant-store.ts` là hàm duy nhất dựng filter, `ensureCollection()` tạo payload index, store không có method nào đọc mà không có `DatasetKeyHash`) để filter tenant/env không thể bị bỏ sót. Payload luôn có `datasetKeyHash` (băm của `datasetKey`), và đặt payload index cho trường này vì hướng A scroll theo filter này. Mỗi deployment (stg, prod) dùng collection riêng.
- [~] Cấu hình qua env. Code đọc env và `.env.example` đã cập nhật; secret không vào manifest, repo, log hay thông báo lỗi. Chưa khai báo `env` trong `manifest.yaml`: làm khi nối vào server (GĐ2/GĐ3), vì `sota env template --write` sẽ render lại `.env.example` từ manifest và có thể ghi đè các ghi chú hiện có.
- [x] Quy ước point ID (`pointId()` = UUID v5 từ `datasetKeyHash + ideaId + chunkIndex`, nên hai workspace trùng `ideaId` không ghi đè nhau): Qdrant chỉ nhận số nguyên không dấu hoặc UUID. Mục 5.3 của thiết kế nói dùng `id` sáng kiến làm point ID, nhưng mục 9 lại chia nhiều chunk. Dùng UUID xác định từ `ideaId + chunkIndex`, còn `ideaId` nằm trong payload để gom nhóm và xoá theo filter.

Xong khi: unit test cho các client (có mock), tạo collection và upsert/scroll chạy được với Qdrant thật hoặc local.

Trạng thái (2026-11-04): khung đã xong và chưa nối vào `server.ts`, nên hành vi app không đổi. 79 test đạt (Node 22), typecheck, build và `sota validate` đạt. Test dùng server HTTP giả, **chưa thử với OpenRouter hay Qdrant thật**. Còn lại để đóng GĐ1: chạy `ensureCollection` + upsert + scroll với một Qdrant thật (local hoặc cloud) và một lần gọi embedding thật.

## 5. GĐ2: Luồng index

- [ ] Route webhook với auth đã chốt, validate event, trả `202 Accepted`. Event bắt buộc có `datasetKey`; app băm key rồi ghi vào payload mỗi point, thiếu key thì từ chối.
- [ ] Idempotent khi BE gửi lại event (upsert theo point ID xác định).
- [ ] Queue chạy tuần tự. Queue phải nằm ở store ngoài vì đĩa container chỉ là tạm. Cần chọn Redis, Postgres hay thứ khác.
- [ ] Worker: tải file (chống SSRF, giới hạn dung lượng và timeout, kiểm content-type), trích text, chia chunk, embed, upsert.
- [ ] Retry có giới hạn, dead-letter hoặc báo lỗi về BE, log theo event id và kết quả.
- [ ] Thêm lệnh chạy worker riêng trong script dev, vì `sota dev` không chạy worker.

Xong khi: gửi event giả thì thấy point trong Qdrant, gửi lại event không tạo bản ghi trùng, auth sai bị từ chối.

## 6. GĐ3: Luồng kiểm tra trùng mới

- [ ] Thay `findVnaipCandidates` bằng truy vấn Qdrant theo hướng A: scroll toàn bộ point có `datasetKeyHash` khớp `datasetKey` trong input tool, bỏ `excludeIds`, gom chunk theo `ideaId`. Không embed (1) ở luồng này.
- [ ] Thêm `datasetKey` (bắt buộc) vào `dedup-input.schema.json`. Schema hiện có `additionalProperties: false` nên chưa nhận trường này.
- [ ] Middleware kiểm danh tính BE từ claims đã xác thực (giá trị cho phép đặt trong env) trước khi tin `datasetKey`; lời gọi không khớp thì trả 403, có test.
- [ ] Chấm điểm theo batch chạy song song để nằm trong `timeoutMs`, và quyết định trần số ứng viên (xem mục 3.2).
- [ ] Đổi `excludeId` thành `excludeIds` ở `dedup-input.schema.json` (thiết kế dùng mảng, code hiện dùng một giá trị). Giữ output `{matches:[{type,id,score,reason}]}`.
- [ ] LLM scorer chuyển sang OpenRouter, giữ các bước kiểm tra kết quả sẵn có (id phải thuộc ứng viên, percent hợp lệ, reason không rỗng). Sửa cách ghép URL trong `llm-scorer.ts` để giữ phần `/api/v1` của `OPENROUTER_BASE_URL`.
- [ ] Xoá `vnaip-client.ts` và mock VNAIP khỏi đường production.
- [ ] Script seed dữ liệu để phát triển song song với GĐ2.

Xong khi: test tenant isolation (workspace khác không thấy dữ liệu), thời gian trả lời nằm trong 15 giây, `sota validate` và build đạt.

## 7. GĐ4: Vòng đời dữ liệu

- [ ] Backfill một lần cho các sáng kiến đã duyệt trước đây. Script phải chạy lại được, không tạo trùng.
- [ ] Event cập nhật, thu hồi, huỷ duyệt → sửa hoặc xoá point.
- [ ] Quyết định có cần callback trạng thái index về BE không (#3).
- [ ] Phối hợp với BE chính sách hết hạn cache Redis khi dữ liệu Qdrant thay đổi.
- [ ] Xử lý khoảng trễ index: sáng kiến vừa duyệt có thể chưa tìm thấy ngay.

## 8. GĐ5: Hardening và release

- [ ] Test bảo mật: replay và timestamp webhook, rate limit, cross-tenant, cross-environment, SSRF.
- [ ] Log có cấu trúc, health/readiness (kiểm Qdrant với timeout ngắn), theo dõi chi phí token.
- [ ] Chỉnh ngưỡng và `k` bằng dữ liệu thật.
- [ ] Gỡ mọi `.invalid` và localhost khỏi cấu hình hosted.
- [ ] `sota validate` và build đạt, deploy stg rồi mới tới production.

## 9. Rủi ro cần theo dõi

| Rủi ro | Giai đoạn | Cách giảm |
|---|---|---|
| Cách ly workspace dựa vào `datasetKey` do BE gửi, không phải claim đã xác thực | GĐ1 đến GĐ3, GĐ5 | Chỉ BE đưa được key hợp lệ (xem mục 3.2), từ chối khi thiếu key, test cách ly giữa hai key |
| Hướng A vượt timeout 15 giây hoặc tốn token khi dữ liệu tăng | GĐ3, GĐ5 | Chấm batch song song, đo thời gian với dữ liệu thật, đặt ngưỡng số sáng kiến để chuyển sang hướng B (vector đã được lưu sẵn) |
| Đổi embedding model sau khi index | GĐ1, GĐ4 | Ghi tên model và version vào payload hoặc tên collection, cần reindex khi đổi |
| Queue mất job khi restart | GĐ2 | Dùng store ngoài, không dùng bộ nhớ hoặc đĩa container |
| Cache BE trả kết quả cũ | GĐ4 | Thống nhất chính sách hết hạn với BE |

## 10. Việc chưa kiểm tra

- Chưa thử OpenRouter và Qdrant thật; các client mới chỉ được test với server HTTP giả.
- Chưa biết claim nào của token nhận diện được service account của BE (cần log `invocation_accepted` từ Staging).
- Test cần Node 20 trở lên; máy phát triển đang mặc định Node 18 nên phải `nvm use 22` trước khi chạy `npm test`.
- Quyền gọi tool `check-duplicates` ngoài BE (ví dụ agent trong workspace cài app) chưa được xác minh.
