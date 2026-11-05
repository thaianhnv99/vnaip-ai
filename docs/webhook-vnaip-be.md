# Webhook index sáng kiến: hướng dẫn tích hợp cho VNAIP-BE

Khi một sáng kiến được duyệt (hoặc được cập nhật), VNAIP-BE gọi webhook này để app `vnaip-dedup` index nội dung sáng kiến, phục vụ việc kiểm tra trùng lặp. Webhook xác thực bằng **chữ ký HMAC-SHA256**, không dùng API key.

## 1. Thông tin cần có trước khi tích hợp

| Mục | Giá trị |
|---|---|
| Địa chỉ webhook | `POST <URL_APP_DA_DEPLOY>/webhooks/idea-approved` (**TODO: người phụ trách app điền URL trước khi gửi tài liệu này**; môi trường hosted chỉ dùng HTTPS) |
| Secret ký | Do phía app tạo ngẫu nhiên (ví dụ `openssl rand -hex 32`, ra 64 ký tự hex) và gửi qua kênh an toàn (không qua chat, email thường hay repo). Tối thiểu 16 ký tự, không chứa dấu phẩy. BE lưu trong cấu hình bí mật của mình (tên biến tuỳ BE, chỉ cần cùng giá trị) và chỉ dùng để ký, **không bao giờ gửi secret trong request**. Mỗi môi trường (dev, staging, production) một secret riêng |
| Đổi secret | Báo trước. Server nhận nhiều secret cùng lúc nên hai bên đổi lần lượt được, không cần ngừng gửi event |

## 2. Request

```
POST /webhooks/idea-approved
Content-Type: application/json
X-Webhook-Timestamp: 1730000000
X-Webhook-Signature: sha256=cc535c95d5a952d060256b76fb646dfb7e866fdf85a92b37650f960053861589

{"id":"GP-1","type":"solutions","title":"Tiêu đề","content":"Nội dung"}
```

Body tối đa 1MB. Trường lạ (kể cả `datasetKey` cũ) bị bỏ qua.

Body là **một event (object)** hoặc **một mảng event** (xem mục 2.1). Bảng dưới là hợp đồng của **một event**, mỗi phần tử của mảng cũng theo đúng bảng này.

| Trường | Yêu cầu |
|---|---|
| `id` | Bắt buộc. Chuỗi không rỗng, tối đa 200 ký tự, **duy nhất trong toàn VNAIP**. Gửi lại cùng `id` là cập nhật sáng kiến đó, không tạo bản mới |
| `type` | Bắt buộc. **Đúng một trong ba giá trị `ideas`, `solutions`, `initiatives`** (khớp từng ký tự, phân biệt hoa/thường, số nhiều; `solution`, `idea`, `Ideas`... đều bị từ chối). Mỗi type được lưu và so sánh trùng ở một collection riêng, nên các type không bao giờ lẫn nhau. Giữ `type` của một sáng kiến cố định: gửi lại cùng `id` với `type` khác tạo bản thứ hai ở type mới, **không** xoá bản ở type cũ |
| `title` | Bắt buộc. Chuỗi không rỗng, tối đa 300 ký tự |
| `content` | Bắt buộc. Chuỗi không rỗng, tối đa 200.000 ký tự |
| `metadata` | Tuỳ chọn. Object, tối đa 10.000 byte khi serialize |
| `fileRef` | Tuỳ chọn. Chuỗi không rỗng hoặc object, tối đa 2.000 byte. **Hiện chưa được xử lý** (chờ MinIO); gửi cũng được, hệ thống chỉ index `title` và `content` |

### 2.1. Gửi nhiều event trong một request (mảng)

Thay vì một object, body có thể là mảng object, ví dụ để gửi bù hàng loạt:

```
POST /webhooks/idea-approved
Content-Type: application/json
X-Webhook-Timestamp: 1730000000
X-Webhook-Signature: sha256=<chữ ký của đúng chuỗi body này>

[
  {"id":"GP-1","type":"solutions","title":"Tiêu đề 1","content":"Nội dung 1"},
  {"id":"GP-2","type":"solutions","title":"Tiêu đề 2","content":"Nội dung 2"}
]
```

- **Tối đa 50 phần tử**, mảng rỗng bị từ chối. Giới hạn body 1MB tính cho **cả mảng**, nên mảng nhiều sáng kiến dài có thể chạm 1MB trước khi đủ 50 phần tử (chia nhỏ mảng nếu gặp `413`).
- **Tất cả hoặc không gì cả khi kiểm tra dữ liệu**: chỉ cần một phần tử sai là cả request bị `400 INVALID_EVENT` và **không phần tử nào** được nhận. Message nêu chỉ số phần tử (bắt đầu từ 0), ví dụ `Phần tử [1]: Trường title bắt buộc và phải là chuỗi không rỗng`.
- **Một chữ ký cho cả request**: ký đúng chuỗi bytes của cả mảng (mục 3), không ký từng phần tử. Chống replay cũng tính theo cả request: gửi lại nguyên mảng (cùng chữ ký) thì nhận `409`.
- **Thứ tự được giữ**: các phần tử được xếp hàng theo đúng thứ tự trong mảng và xử lý tuần tự. Nếu cùng một `id` xuất hiện hai lần trong mảng thì phần tử sau ghi đè phần tử trước. Nên tránh, mỗi `id` chỉ cần gửi bản mới nhất.
- Mảng một phần tử vẫn là mảng: response theo dạng mảng (mục 4), không phải dạng của object đơn.
- Object đơn vẫn dùng được y như trước, response không đổi.

## 3. Cách ký

```
timestamp = epoch GIÂY hiện tại (UTC), số nguyên
rawBody   = đúng chuỗi bytes JSON (UTF-8) sẽ gửi đi
signature = hex( HMAC_SHA256( secret, timestamp + "." + rawBody ) )
```

- Header `X-Webhook-Timestamp` = `timestamp` (chuỗi số nguyên).
- Header `X-Webhook-Signature` = `sha256=` + `signature` (64 ký tự hex; hoa hay thường đều được; tiền tố `sha256=` có thể bỏ).
- Chữ ký phủ đúng chuỗi `timestamp` trong header, nên giữ nguyên chuỗi đó, đừng format lại.
- `secret` được dùng **nguyên chuỗi ký tự (UTF-8) làm khoá**. Dù secret trông như hex hay base64, đừng giải mã nó ra bytes trước khi ký.

### Test vector

Dùng để tự kiểm tra code ký trước khi gọi thật (secret dưới đây chỉ là ví dụ, **không phải secret thật**):

```
secret    = example-secret-0123456789
timestamp = 1730000000
rawBody   = {"id":"GP-1","type":"solutions","title":"Tiêu đề","content":"Nội dung"}
signature = cc535c95d5a952d060256b76fb646dfb7e866fdf85a92b37650f960053861589
```

Giá trị này đã được kiểm tra bằng OpenSSL, Node.js, Python và Java. Nếu BE tính ra giá trị khác thì lỗi nằm ở cách serialize hoặc encoding, không phải ở server.

### Những lỗi hay gặp

1. **Ký một chuỗi nhưng gửi chuỗi khác.** Serialize đúng một lần, ký chuỗi đó rồi gửi chính chuỗi đó. Nhiều HTTP client có tuỳ chọn "gửi object dưới dạng JSON" sẽ serialize lại, làm khoảng trắng hoặc thứ tự trường khác đi và chữ ký sai.
2. **Timestamp tính bằng mili-giây.** Phải là **giây** (10 chữ số ở thời điểm hiện tại). Timestamp không được có số 0 đầu dòng, dấu `+`/`-`, phần thập phân, dạng mũ (`1e9`) hay hex.
3. **Đồng hồ máy chủ BE lệch.** Timestamp lệch quá **±300 giây** so với giờ server bị từ chối (cả quá khứ lẫn tương lai). Nên bật NTP.
4. **Sai encoding.** Body và chuỗi ký phải là UTF-8.
5. **Thiếu hoặc sai `Content-Type`.** Phải là `application/json`, nếu không server trả `415`.
6. **Gửi lại nguyên request cũ.** Mỗi chữ ký chỉ được nhận **một lần** (chống replay). Mỗi lần gửi, kể cả retry, phải ký lại với timestamp hiện tại. Hai event giống hệt nhau trong cùng một giây có cùng chữ ký nên cái thứ hai bị `409`.
7. **Còn gửi `x-api-key`.** Cách xác thực API key cũ đã bị thay hoàn toàn, header này bị bỏ qua.

## 4. Response và cách xử lý

Mọi response đều là JSON.

| Mã | `code` | Ý nghĩa | BE nên làm |
|---|---|---|---|
| `202` | (không có), body `{"status":"accepted","jobId":"..."}` | Đã nhận object đơn, sẽ index nền | Xong. `jobId` chỉ để đối chiếu log |
| `202` | (không có), body `{"status":"accepted","count":2,"jobs":[{"id":"GP-1","jobId":"..."},{"id":"GP-2","jobId":"..."}]}` | Đã nhận cả mảng, sẽ index nền. `jobs` cùng thứ tự với mảng đã gửi | Xong. `jobId` chỉ để đối chiếu log |
| `409` | `DUPLICATE_DELIVERY` | Request (cùng chữ ký) đã được nhận trước đó | Coi như đã nhận, **không** coi là lỗi |
| `400` | `INVALID_EVENT` | Event thiếu hoặc sai trường (kể cả `type` không phải `ideas`/`solutions`/`initiatives`), hoặc mảng rỗng/quá 50 phần tử (message nêu tên trường và chỉ số phần tử nếu là mảng, không lặp lại giá trị) | Sửa dữ liệu, không retry nguyên văn. Với mảng, chưa phần tử nào được nhận |
| `400` | `BAD_REQUEST` | Body không phải JSON hợp lệ hoặc rỗng | Sửa request |
| `401` | `AUTH_ERROR` | Chữ ký hoặc timestamp không hợp lệ | Kiểm tra secret, cách ký, định dạng và độ lệch timestamp (mục 3) |
| `413` | `PAYLOAD_TOO_LARGE` | Body vượt 1MB | Rút gọn nội dung |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | `Content-Type` không phải JSON | Gửi `application/json` |
| `503` | `QUEUE_UNAVAILABLE` | Hàng đợi tạm thời không nhận được event | Retry sau, **ký lại với timestamp mới** |
| `503` | `WEBHOOK_NOT_CONFIGURED` | Phía app chưa cấu hình webhook | Báo phía app; retry sau |

Response `401` cố ý không cho biết sai ở đâu (secret, timestamp hay body). Nguyên nhân chỉ có trong log phía app, nên khi cần dò lỗi hãy gửi cho phía app thời điểm gọi (giờ UTC) để tra log.

### Retry và thứ tự

- Retry chỉ với `503` (và lỗi mạng/timeout), dùng backoff tăng dần, mỗi lần ký lại.
- Index theo `id` là idempotent: gửi lại cùng event không nhân đôi dữ liệu.
- Với mảng, `503` có thể xảy ra khi **một phần** mảng đã vào hàng đợi. Cứ retry **cả mảng** (ký lại): phần tử đã vào hàng đợi chỉ bị index lại cùng nội dung, không nhân đôi dữ liệu. Không cần và không nên tự cắt phần đã gửi, vì response `503` không cho biết phần tử nào đã vào.
- **Giữ đúng thứ tự cho cùng một `id`.** Event đến sau ghi đè event đến trước. Nếu một sáng kiến được cập nhật liên tiếp và bản cũ đang chờ retry thì đừng retry bản cũ sau khi đã gửi bản mới, nếu không bản cũ sẽ ghi đè bản mới.
- Hệ thống xử lý event tuần tự từng cái; hiện chưa có rate limit nhưng cũng đừng gửi dồn dập hàng loạt.

## 5. Ví dụ code

Các ví dụ dưới đây đã được chạy thử với server thật (ở chế độ mock) và nhận `202`. Đặt `WEBHOOK_URL` và `WEBHOOK_SECRET` bằng biến môi trường.

### curl + OpenSSL (kiểm tra nhanh)

```bash
SECRET='<secret>'
URL='<URL_APP_DA_DEPLOY>/webhooks/idea-approved'
TS=$(date +%s)
BODY='{"id":"GP-1","type":"solutions","title":"Tiêu đề","content":"Nội dung"}'
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')

curl -i -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H "X-Webhook-Timestamp: $TS" \
  -H "X-Webhook-Signature: sha256=$SIG" \
  --data-binary "$BODY"
```

### Node.js (18+)

```js
import { createHmac } from "node:crypto";

const url = process.env.WEBHOOK_URL;
const secret = process.env.WEBHOOK_SECRET;

// 1. Serialize MỘT lần; ký và gửi đúng chuỗi này.
const body = JSON.stringify({
  id: "GP-2026-0001",
  type: "solutions",
  title: "Ứng dụng báo cáo sự cố",
  content: "Nội dung sáng kiến đã được duyệt...",
});

// 2. Timestamp là epoch GIÂY (không phải mili-giây).
const timestamp = Math.floor(Date.now() / 1000).toString();

// 3. signature = hex(HMAC_SHA256(secret, `${timestamp}.${body}`))
const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");

const response = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Webhook-Timestamp": timestamp,
    "X-Webhook-Signature": `sha256=${signature}`,
  },
  body, // đúng chuỗi đã ký
});
console.log(response.status, await response.text());
```

### Python 3 (chỉ dùng thư viện chuẩn)

```python
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request

url = os.environ["WEBHOOK_URL"]
secret = os.environ["WEBHOOK_SECRET"].encode("utf-8")

# 1. Serialize MỘT lần ra bytes; ký và gửi đúng bytes này.
body = json.dumps(
    {
        "id": "GP-2026-0002",
        "type": "solutions",
        "title": "Ứng dụng báo cáo sự cố",
        "content": "Nội dung sáng kiến đã được duyệt...",
    },
    ensure_ascii=False,
).encode("utf-8")

# 2. Timestamp là epoch GIÂY (không phải mili-giây).
timestamp = str(int(time.time()))

# 3. signature = hex(HMAC_SHA256(secret, timestamp + "." + body))
signature = hmac.new(secret, timestamp.encode("utf-8") + b"." + body, hashlib.sha256).hexdigest()

request = urllib.request.Request(
    url,
    data=body,  # đúng bytes đã ký
    method="POST",
    headers={
        "Content-Type": "application/json",
        "X-Webhook-Timestamp": timestamp,
        "X-Webhook-Signature": f"sha256={signature}",
    },
)
try:
    with urllib.request.urlopen(request, timeout=10) as response:
        print(response.status, response.read().decode("utf-8"))
except urllib.error.HTTPError as error:  # 4xx/5xx vẫn có body JSON mô tả lỗi
    print(error.code, error.read().decode("utf-8"))
```

Nếu dùng thư viện `requests`, truyền `data=body` (bytes đã ký), **đừng** dùng `json=...` vì thư viện sẽ serialize lại.

### Java 17+

```java
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public class SendWebhook {
    public static void main(String[] args) throws Exception {
        String url = System.getenv("WEBHOOK_URL");
        String secret = System.getenv("WEBHOOK_SECRET");

        // 1. Serialize MỘT lần; ký và gửi đúng chuỗi này (ở đây viết tay cho gọn,
        //    thực tế dùng Jackson/Gson rồi giữ nguyên chuỗi kết quả).
        String body = "{\"id\":\"GP-2026-0003\",\"type\":\"solutions\","
                + "\"title\":\"Ứng dụng báo cáo sự cố\","
                + "\"content\":\"Nội dung sáng kiến đã được duyệt...\"}";

        // 2. Timestamp là epoch GIÂY (không phải mili-giây).
        String timestamp = Long.toString(System.currentTimeMillis() / 1000);

        // 3. signature = hex(HMAC_SHA256(secret, timestamp + "." + body)), UTF-8
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] digest = mac.doFinal((timestamp + "." + body).getBytes(StandardCharsets.UTF_8));
        String signature = HexFormat.of().formatHex(digest);

        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .header("X-Webhook-Timestamp", timestamp)
                .header("X-Webhook-Signature", "sha256=" + signature)
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8)) // đúng chuỗi đã ký
                .build();

        HttpResponse<String> response =
                HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
        System.out.println(response.statusCode() + " " + response.body());
    }
}
```

Với ngôn ngữ khác (C#, PHP, Go...), chỉ cần làm đúng ba bước ở mục 3 và đối chiếu với test vector.

## 6. Checklist tự kiểm tra của BE

1. Code ký ra đúng `signature` của test vector (mục 3).
2. Gọi với secret **sai** → nhận `401 AUTH_ERROR`.
3. Gọi với secret thật và event hợp lệ → nhận `202`.
4. Gửi lại y nguyên request vừa rồi (cùng timestamp và chữ ký) → nhận `409 DUPLICATE_DELIVERY`.
5. Gửi event thiếu `title` → nhận `400 INVALID_EVENT`.
6. Retry của BE ký lại với timestamp mới ở mỗi lần gửi.
7. BE đã ngừng gửi `x-api-key` và không còn dùng API key cũ.
8. (Nếu dùng mảng) Gửi mảng 2 event hợp lệ → nhận `202` với `count: 2` và `jobs` đúng thứ tự; gửi mảng có một phần tử thiếu `title` → nhận `400` nêu đúng chỉ số và không phần tử nào được index.

## 7. Chuyển đổi từ API key cũ

Webhook trước đây xác thực bằng header `x-api-key`. Cách đó **đã bị thay hoàn toàn** bởi HMAC và hai cách không chạy song song được, nên cần phối hợp:

1. Phía app đặt `WEBHOOK_HMAC_SECRETS` (biến môi trường của dịch vụ web) rồi deploy.
2. Phía app gửi secret cho BE qua kênh an toàn.
3. BE triển khai bản ký HMAC và tự kiểm tra theo mục 6.
4. Từ lúc app deploy bản mới đến khi BE chuyển xong, request dùng `x-api-key` sẽ bị `401`. Nên chốt giờ chuyển cùng lúc, hoặc tạm dừng gửi event trong khoảng đó rồi gửi bù (gửi lại an toàn vì index theo `id` là idempotent).
