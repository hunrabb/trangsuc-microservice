# Task 5.4 — Backfill và kiểm chứng có mục tiêu

## Nguồn và tính nhất quán

POS ghi doanh thu tại `order.paid` theo quyết định nghiệp vụ đã chốt, dù roadmap cũ còn
ghi `order.completed`. Không triển khai Phase 6.

Sales xuất JSONL bằng user của Sales; Report nhập file bằng user của Report. Không
query chéo schema hay thêm internal API. CLI dành cho người vận hành có quyền DB
tương ứng; file export/audit được tạo quyền `0600`, cần chuyển qua kênh được kiểm soát.

Nguồn chính là snapshot bất biến `OrderItem` và `OrderStatusHistory`. Chỉ đơn
`COMPLETED` với đúng một chuyển `PENDING_PAYMENT -> COMPLETED` được xuất thành event.
Giữ giá/trọng lượng/tên từ dòng bán; không hỏi giá sản phẩm hiện tại. `variantId=null`
đánh dấu dòng trước migration snapshot vốn: giá vốn để `null`, không lấy số `0` mặc định
của migration làm vốn lịch sử. Không suy diễn variant/metal bị thiếu.

`paidAt` ưu tiên payload `order.paid` hợp lệ còn trong Sales outbox, nếu không dùng mốc
chuyển trạng thái nhận tiền. Outbox retention 7 ngày không phải nguồn lịch sử duy nhất.
Event cũ thiếu snapshot có thể chưa có ProcessedEvent/đang trong DLQ: backfill dùng ID
ổn định theo namespace + orderId, không dùng lại ID thư hỏng. Live dùng consumer
`report`; import dùng `report.backfill.v1`, marker ghi cùng transaction với doanh thu.

Thiếu lịch sử nhận tiền, thiếu dòng, trùng tem, lệch tổng/schema đều bị loại/audit;
không thay trạng thái đơn để ép đủ điều kiện. Đơn thiếu vốn vẫn đóng góp doanh thu/top
sản phẩm, nhưng COGS/lợi nhuận nhóm tiếp tục là `null`.

`orderId` unique là trọng tài giữa live/backfill. Header và lines được ghi nguyên tử.
Consumer đến sau so sánh toàn bộ dữ liệu đóng góp báo cáo: chi nhánh, kênh, ngày Việt
Nam, tổng, COGS, tem, tên, variant/metal, trọng lượng và giá từng dòng. `paidAt` có thể
lệch mili-giây giữa history/outbox: chỉ ngày báo cáo phải trùng, giữ timestamp bản ghi
thắng. Không sửa snapshot đã có, kể cả nâng cấp từ thiếu vốn sang đủ vốn: bản ghi
khác/partial/tombstone vào conflict để đối soát riêng. Snapshot giàu dữ liệu đến sau
snapshot thiếu cũng cần can thiệp có kiểm soát, không tự chữa bằng overwrite.

## Dry-run, cursor và apply

**Phiên Task 5.4 không chạy export/apply lên dữ liệu thật.** Lệnh dưới đây là hướng dẫn
sau khi người dùng phê duyệt riêng phạm vi dữ liệu thật. Shared libs phải có dist như
quy trình dev; build hai package có thay đổi:

```bash
pnpm --filter @jewelry/sales build
pnpm --filter @jewelry/report build

# Cửa sổ UTC: đầu bao gồm, cuối không bao gồm; ví dụ một ngày Việt Nam.
pnpm --filter @jewelry/sales report:backfill:export -- \
  --from 2026-10-31T17:00:00Z --to 2026-11-01T17:00:00Z \
  --batch-size 100 --output /tmp/pos-report-001.jsonl

# Mặc định dry-run: không ghi bảng Report, vẫn ghi audit/cursor trên đĩa.
pnpm --filter @jewelry/report report:backfill:import -- \
  --input /tmp/pos-report-001.jsonl --batch-size 100 \
  --audit /tmp/pos-report-001.dry.audit --checkpoint /tmp/pos-report-001.dry.cursor

# Chỉ sau khi duyệt kết quả và được phép apply; dùng checkpoint RIÊNG.
pnpm --filter @jewelry/report report:backfill:import -- \
  --input /tmp/pos-report-001.jsonl --batch-size 100 --apply \
  --audit /tmp/pos-report-001.apply.audit --checkpoint /tmp/pos-report-001.apply.cursor
```

Export tối đa 500 đơn/lần, mặc định 100; file tạo độc quyền (`wx`), không ghi đè batch.
Phạm vi chính lọc thời điểm history chuyển COMPLETED. Đơn không có mốc COMPLETED được
khám phá theo ngày tạo trong cửa sổ để audit chưa trả tiền/thiếu lịch sử. Không thể
gán ngày nhận tiền chính xác cho đơn mất history; không tuyên bố đếm được mọi đơn mất
lịch sử trên toàn DB.

Lưu stdout export như manifest (`from/to/nextCursor/eligible/excluded`). Lần tiếp dùng
cùng from/to, `--after <nextCursor>` và file mới. Không dùng OFFSET, không tải toàn bộ
lịch sử vào RAM. `possiblyMore=true` chỉ là gợi ý, batch cuối trống là hợp lệ. Chọn cửa
sổ quá khứ đã ổn định: không có snapshot transaction xuyên toàn bộ lần chạy; đơn vừa
commit/đổi trạng thái có thể cần chạy lại cửa sổ từ đầu, unique business identity bảo
vệ việc chạy lại và live consumer vẫn xử lý đồng thời.

Importer đọc stream, tối đa 500 dòng/lần, file tối đa 32 MiB, dòng tối đa 1 MiB. Batch
export quá lớn thì giảm batch size. Chạy lại cùng lệnh import tiếp từ checkpoint;
SHA-256 file + mode phải khớp. Không sửa input đang nhập. Mỗi audit/checkpoint chỉ dùng
bởi một tiến trình. Crash sau commit nhưng trước checkpoint thì dòng thử lại trả
`EXISTS`, không cộng doanh thu. Mỗi đơn một transaction với lock timeout 3s, statement
timeout 5s; không gọi mạng trong transaction.

`backfill-file.ts` tách IO khỏi callback transaction. Unit `test/backfill-file.test.mjs`
kiểm filesystem thật, gồm resume, lỗi hạ tầng, lỗi ghi checkpoint sau callback mô phỏng
commit và chống dùng nhầm hash/mode. Test này không thay thế kiểm chứng DB concurrency.

Audit từng dòng có timestamp, file hash, line, orderId khi xác định được, status và
reason. Summary stdout đếm `NEEDED`, `EXISTS`, `CREATED`, `EXCLUDED`, `CONFLICT`,
`INVALID_OR_CONFLICT`, `incompleteCost`. Dry-run: hợp lệ = NEEDED + EXISTS, cần nhập =
NEEDED; thiếu/không đủ điều kiện nằm trong EXCLUDED (reason ở audit), lỗi input ở
INVALID_OR_CONFLICT. Conflict phát sinh ngay trong apply có thể ở INVALID_OR_CONFLICT;
dùng file hash/line truy lại input. Summary là lần gọi hiện tại, audit tích luỹ. Audit
fsync trước rename checkpoint. Lỗi DB/network dừng và không tiến cursor dòng đang lỗi.

Không tự retry dòng đã loại/conflict. Sau điều tra tạo batch/checkpoint mới; không
xoá ProcessedEvent, sửa lịch sử hay replay DLQ hàng loạt để ép backfill thành công.

## Integration độc lập và recovery 10 phút

Test không dùng thông tin DB/Rabbit từ `.env`. `tests/reporting/compose.yml` tạo project
`jewelry-phase54-test`, Postgres `127.0.0.1:55432`, RabbitMQ `127.0.0.1:55672`, database
`jewelry_phase54_test`, user từng schema và credential chỉ cho test. Postgres dùng
tmpfs; không dùng/xoá volume dev. Runner migrate deploy chỉ lên DB test này. Không
chạy hai bài integration đồng thời. Shared libs cần dist hiện hành.

```bash
pnpm --filter @jewelry/sales build
pnpm --filter @jewelry/report build
pnpm --filter @jewelry/inventory build

node tests/reporting/run.mjs backfill
node tests/reporting/run.mjs snapshot
node tests/reporting/run.mjs recovery

# Dừng riêng hạ tầng test, không purge hoặc down -v.
docker compose -f tests/reporting/compose.yml stop
```

- Backfill: fixture Sales thật, dry-run không ghi, live/backfill transaction song song,
  duplicate/khác eventId, snapshot thiếu không hạ cấp dữ liệu, so tổng nguồn, CLI
  checkpoint từng dòng và cursor export từng đơn.
- Snapshot: Inventory tạo close + outbox, worker publish qua RabbitMQ, consumer ghi
  Report/ProcessedEvent. Cùng eventId và eventId khác không nhân đôi; thiếu ngày báo
  incomplete; cùng close khác payload vào DLQ và không sửa snapshot. DLQ test giữ thư
  lỗi fixture để điều tra, không tác động DLQ dev/thật.
- Recovery: Report consumer hoạt động trước khi dừng; producer Sales ghi đơn/outbox
  nguyên tử ở đầu/giữa/cuối outage, worker publish và gửi trùng ba lần. Đo thời gian
  thực bằng `performance.now()`, chờ **>=600.000ms** sau khi dừng consumer/kết nối, log
  tiến độ mỗi nhịp tối đa 30s. Không mock timer hay tham số rút ngắn. Scheduler/startup
  có thể thêm mili-giây, không hứa chính xác tuyệt đối 600.000ms. Sau restart kiểm
  backlog, ProcessedEvent, đơn/dòng/tổng doanh thu/vốn so nguồn và eventId mới cùng đơn.
  Bài này chỉ gọi thủ công, không thuộc `pnpm test`.

Docker không hoạt động thì runner lỗi trước migrate/fixture. Không đánh dấu PASS chỉ
vì script tồn tại hoặc compose đã lên.

## DLQ trước observer

Queue bị ảnh hưởng: `inventory.events.dlq`, `sales.events.dlq`, `report.events.dlq`.
RabbitMQ không tự sao chép thư nằm sẵn trước binding `report.dlq.observer`.
Management API cho phép xem depth/trạng thái queue, không cung cấp snapshot nội dung
không tác động delivery. `basic.get`, Management `/get` kể cả requeue vẫn lấy thư tạm
thời, có thể đổi thứ tự/redelivery và tranh chấp vận hành; không dùng chúng để import.
Không thêm importer DLQ cũ vì chưa có nguồn archive bất biến và cách đọc an toàn từng
thư. Đây là đánh giá thiết kế, chưa kiểm chứng broker trong phiên này.

Vận hành: đối chiếu depth ba DLQ ở trang overview RabbitMQ Management, ghi rõ dashboard
Report chỉ phủ bản sao từ observer. Giữ nguyên thư cũ, không purge/replay để làm số
dashboard khớp. Nếu cần xem từng thư lịch sử, chuẩn bị backup/archive sẵn có trong môi
trường riêng và duyệt quy trình import riêng. Sales export giải quyết doanh thu thiếu,
không giả làm migration DLQ. `REPUBLISHED` vẫn chỉ có nghĩa broker đã nhận bản sao.
