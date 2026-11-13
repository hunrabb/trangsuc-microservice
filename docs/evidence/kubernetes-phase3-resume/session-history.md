# Giai đoạn 3 — Báo cáo triển khai thực tế

Ngày **13/11/2026**, cluster `jewelry-lab`, kubeconfig `/home/hung/.kube/jewelry-lab.config`. **Kết quả: PARTIAL — dừng tại checkpoint 3.3 theo điều kiện swap. Chưa đủ điều kiện chuyển Giai đoạn 4.**

## 1. Điểm dừng và tài nguyên giữ lại

Monitor dừng bước triển khai tiếp theo lúc **10:54:50 giờ Việt Nam (03:54:50 UTC)** vì swap tăng qua ba khoảng đo liên tiếp:

| UTC | Swap used KiB | Swap used MiB | pswpout lũy kế (pages) |
|---|---:|---:|---:|
| 03:54:11 | 16820 | 16,43 | 3986 |
| 03:54:24 | 17264 | 16,86 | 4067 |
| 03:54:37 | 17352 | 16,95 | 4089 |
| 03:54:50 | 17508 | 17,10 | 4118 |

Tăng **688 KiB trong khoảng 39 giây**, có swap-out thực. Ngưỡng giám sát chọn bảo thủ: ba khoảng tăng liên tiếp, không có ngưỡng tối thiểu theo byte. Đây là cách vận hành điều kiện “swap liên tục tăng” trong yêu cầu; **không phải bằng chứng laptop hết RAM**. Ở thời điểm dừng Windows còn 4843 MiB available, WSL còn 3692,4 MiB, không OOM/Node pressure. Không tự nới quy tắc hoặc tiếp tục tạo Standby.

Sau khi dừng các bước mới, controller CNPG vẫn tự reconcile resource đã được áp dụng. Bootstrap/image pull đã được yêu cầu trước điểm dừng và sau đó tự hoàn thành; kiểm tra cuối phiên xác nhận **Primary Ready**. Không hibernate, scale xuống, xóa Cluster/PVC hoặc tắt Docker/WSL để rollback.

Chưa tạo Standby, RabbitMQ demo, bộ cấu hình ứng dụng/JWT hoặc migration Jobs. Không deploy NestJS/Gateway; không chuyển Giai đoạn 4.

## 2. Checkpoint

| Checkpoint | Kết quả thực tế |
|---|---|
| 3.0 Preflight | PASS cho phép bắt đầu: 3 Node/13 system Pods Ready, không Node pressure, còn RAM và ổ C; CPU tăng ngắn, chưa bão hòa kéo dài |
| 3.1 CNPG operator | PASS: operator Ready trên Control Plane, 0 restart; 11 CRDs Established; webhook có CA và xử lý server dry-run Cluster thành công |
| 3.2 Storage | PASS trong phạm vi 1 instance đã tạo: StorageClass riêng, dynamic provisioning, PVC Bound, PV node affinity Worker 1; quyền PGDATA 26:26 mode 0700 xác nhận sau bootstrap |
| 3.3 Primary | PARTIAL: Cluster/PVC đã tạo, cuối phiên Primary tự Ready, SQL read-only kiểm chứng version/recovery; dừng trước kiểm thử ghi và đánh giá ổn định đầy đủ |
| 3.4 Databases/roles | Chưa thực hiện; bootstrap chỉ tạo auth_db/auth_migrator, chưa schema auth hoặc isolation/grants đầy đủ |
| 3.5 Standby/replication | Chưa thực hiện; chưa thể gọi là PostgreSQL HA |
| 3.6 Connection budget | Chưa hoàn tất acceptance; có tính sơ bộ ở mục 7 |
| 3.7 RabbitMQ demo | Chưa tạo, chưa test connectivity; không dùng broker cũ |
| 3.8 ConfigMaps/Secrets | Chưa hoàn tất; chỉ có Secret demo bootstrap mới và Secrets CNPG tự quản |
| 3.9 Migration Jobs | Chưa tạo/chạy; chưa so sánh migration images với working tree |

## 3. Phiên bản, pin và placement

- kind 0.33.0; Kubernetes 1.36.1; kiến trúc cuối vẫn 1 CP + 2 Worker, 7 business + 2 database Pods. Một instance hiện tại chỉ là checkpoint bootstrap tạm theo yêu cầu, không thay đổi baseline cuối.
- CloudNativePG **1.30.1**, stable release upstream 23/09/2026; nhánh 1.30 hỗ trợ Kubernetes 1.36 theo [supported releases](https://cloudnative-pg.io/docs/1.30/supported_releases/). Đã kiểm tra manifest upstream và API releases chính thức; không dùng snapshot/latest.
- Operator image `ghcr.io/cloudnative-pg/cloudnative-pg:1.30.1@sha256:923c267ec29636db3bee20f993d0ec4973fa22998e1adad37da79e4d32b5bc07`.
- Upstream manifest tag `v1.30.1`, SHA256 `37237f145d8138256ea25ae830f87759255665ff08f8d552fdd8224a5ec032fb`. Patch riêng placement, tài nguyên, digest; RBAC/CRDs/webhooks giữ upstream. Dùng server-side apply để tránh annotation CRD quá lớn.
- PostgreSQL **16.15**, cùng major/patch với Compose hiện tại. SQL xác nhận `PostgreSQL 16.15 (Debian 16.15-1.pgdg13+2)`.
- PostgreSQL image `ghcr.io/cloudnative-pg/postgresql:16.15-system-trixie@sha256:1546be7d23066aaf9eb75b07df17c843c98483cede7afdbaf01dca785fb3bf60`.

| Pod | Namespace | Node | Trạng thái cuối | Restart |
|---|---|---|---|---:|
| cnpg-controller-manager-7df6db7d87-hx7hk | cnpg-system | jewelry-lab-control-plane | 1/1 Ready | 0 |
| jewelry-pg-1 | jewelry-demo | jewelry-lab-worker | 1/1 Ready, Primary | 0 |
| Standby | — | dự kiến jewelry-lab-worker2 | Chưa tạo | — |
| 13 system Pods | kube-system / local-path-storage | Cả 3 Node | Ready | Scheduler/controller-manager vẫn 2 mỗi Pod; còn lại 0 |

Cuối phiên còn **15 Pods** (13 system + operator + Primary); bootstrap Job đã hoàn thành, Pod initdb không còn trong danh sách cuối. Không phải 15 application Pods.

Operator có nodeSelector CP và toleration đúng taint CP; không gỡ taint. Vì tách khỏi hai Worker, mất một Worker không trực tiếp làm mất Pod operator. **Chưa thử Worker failure**, operator/Control Plane vẫn có single point of failure.

Manifest đã review trước apply; dry-run ban đầu với namespace chưa tồn tại báo NotFound, chưa tạo workload. Đã tạo namespace riêng, dry-run lại thành công rồi apply. Không force-conflict.

## 4. PostgreSQL, storage và endpoint

- Cluster `jewelry-demo/jewelry-pg`, spec.instances=1; cuối phiên healthy/readyInstances=1. Chưa có Standby.
- `pg_is_in_recovery() = false`; `transaction_read_only = off`. **Chưa kiểm thử ghi dữ liệu sau safety stop.**
- `jewelry-pg-rw.jewelry-demo.svc.cluster.local:5432`, ClusterIP `10.96.246.205`, endpoint `10.244.1.5` trên Primary. `-r` cũng có Primary; `-ro` không có endpoint vì chưa có Standby. Không có hostPort/NodePort/public LoadBalancer.
- PVC `jewelry-pg-1`: **5Gi, RWO, Bound**; PV `pvc-cd2c8353-2082-43ef-bb19-d285d5f3c3d2`, node affinity `jewelry-lab-worker`.
- StorageClass mới `jewelry-demo-local`: rancher.io/local-path, **Retain, WaitForFirstConsumer**, không expansion. Giữ nguyên default `standard` vốn Delete. Retain không thay backup.
- Provisioner tạo thư mục dưới `/var/local-path-provisioner` trong kind node. Đã xác minh dynamic provisioning và PGDATA owner UID/GID **26:26**, mode **0700**. Không mount volume Compose, workspace, Windows system directories.
- PGDATA cuối phiên khoảng **62,6 MiB**, SQL đo WAL **32 MiB**. Dung lượng DB auth_db khoảng 7,49 MiB. Phép `du` parent gồm WAL; không cộng trùng hai số.
- **5Gi là capacity khai báo, local-path không áp quota cứng**. `df` trong node thấy VHDX khoảng 1007GiB là virtual capacity, không thể dùng thay số C: free.
- WAL retention dự kiến: wal_keep_size=128MB, max_slot_wal_keep_size=512MB, max_wal_size=512MB. max_wal_size không hard cap; slot WAL vượt giữ tối đa có thể buộc rebootstrap replica. Chưa quan sát catch-up hoặc WAL dài hạn.
- 5Gi/PVC dự kiến đủ dữ liệu demo nhẹ, nhưng cần theo dõi images, WAL, logs và C: thật. Hai PVC dự kiến không reserve trước 10Gi trên C:. Disk reserve giám sát phiên: 15GiB.
- Local PV trên kind không chịu được mất laptop/ổ vật lý/node filesystem. Anti-affinity cứng dự kiến cho 2 DB sẽ có thể khiến Pod replacement Pending nếu chỉ còn một Worker.

Image PostgreSQL lần đầu gặp `unexpected EOF` và DNS `ghcr.io ... server misbehaving`; kubelet tự retry sau điểm dừng và pull thành công. Chưa sửa DNS/Docker settings; không dùng tag thay thế.

## 5. Databases, quyền và Secrets

| Database/schema đích | Thực tế |
|---|---|
| auth_db / auth | Database đã có do initdb; schema auth **chưa có** (mới information_schema/pg_catalog/pg_toast/public) |
| inventory_db / inventory | Chưa tạo |
| sales_db / sales | Chưa tạo |
| report_db / report | Chưa tạo |

`auth_migrator` do bootstrap tạo là non-superuser, không CREATEDB/CREATEROLE. Chưa tạo runtime roles riêng, chưa revoke PUBLIC CONNECT/cross-database isolation hoặc default privileges; **không sử dụng Secret này như runtime config Giai đoạn 4**.

Secret `auth-migration-creds` dùng credentials demo mới sinh trong bộ nhớ; không copy `.env`/password cũ. Chỉ gửi qua stdin tới Kubernetes API; không in giá trị hoặc lưu credentials trong Git/YAML. CNPG tự sinh CA/TLS/replication/operator-auth Secrets. Không đọc/in nội dung của các Secrets. JWT mới và app ConfigMaps chưa chuẩn bị.

Không chạy migration, seed, restore hay dump dữ liệu cũ. Migrations working tree: Auth **4**, Inventory **13**, Sales **15**, Report **7**, cần kiểm tra image/schema/hash trước checkpoint 3.9 khi được tiếp tục. Chưa kiểm chứng `_prisma_migrations`, tables/constraints hoặc extension bằng Job.

## 6. Replication, failover và RabbitMQ

`pg_stat_replication` trả **0 dòng** vì chưa có Standby; lag chưa có để đo. Chưa có kiểm chứng sao chép bốn DB, promotion, fencing hoặc reconnect của ứng dụng.

Thiết kế mục tiêu vẫn async (RPO có thể >0), service `-rw` theo primary, khác Worker/PVC, không pin vai trò vào Pod name. CNPG 1.30 có cơ chế primary Lease/election theo [automated failover](https://cloudnative-pg.io/docs/1.30/failover/); chưa kiểm chứng trong cluster này. Không thử shutdown Worker/destructive primary failure/promote thủ công. Hai Pod/PVC cùng laptop vẫn không đồng nghĩa HA hoàn chỉnh.

RabbitMQ demo chưa tạo, chưa test TCP/auth/publish/consume. Broker Compose cũ giữ nguyên, không dùng thay broker demo. Sau khi xử lý điều kiện dừng mới có thể tiếp tục xem xét broker mới độc lập hai Worker; một broker vẫn SPOF.

## 7. Connection budget sơ bộ — chưa acceptance checkpoint 3.6

Source xác nhận `CONSUMER_PREFETCH=10`, `CONSUMER_POOL_RESERVE=5` và chặn pool dưới **15**. PrismaPg dùng `DATABASE_POOL_MAX`, một pool mỗi process; outbox/consumer/background workers dùng chung client/pool hiện tại, không cộng nguyên một pool nữa cho mỗi worker.

7 business Pods theo baseline: Auth2 + Inventory2 + Sales2 + Report1:

| Pool tối đa/Pod | Tổng trần business connections |
|---|---:|
| 15 | 105 |
| 20 | 140 |

Primary bootstrap cấu hình `max_connections=128`, shared_buffers=128MB, work_mem=2MB, maintenance_work_mem=32MB. Pool 20 không phù hợp trần này khi cộng admin/migration/operator; **chưa cho phép deploy ứng dụng bằng cấu hình đó**. Pool 15 còn 23 slot trước các kết nối và reserved slots khác; cần budget rõ admin/operator/migration/monitoring và rollout surge trước Giai đoạn 4. WAL senders cần theo dõi ngân sách replication riêng. Không tự tăng max_connections hoặc giảm pool dưới 15 để vượt blocker.

Hiện không có business/migration connections; query cuối thấy 7 backend/background entries trong pg_stat_activity, gồm chính truy vấn kiểm tra, không có replication sender. Trần pool không đồng nghĩa tất cả connections luôn mở. Không suy RAM đủ chỉ từ phép tính 105×work_mem: một query có thể dùng work_mem cho nhiều thao tác, còn backend/shared/buffers/OS/cache.

## 8. Số đo tài nguyên thực tế

Windows/WSL available khác nhau, không cộng hai số làm tổng RAM. “WSL used” bảng dưới là MemTotal−MemAvailable để thể hiện lượng chưa available, khác cột used của một số phiên bản free. CPU Windows là mẫu tức thời; load Linux không phải phần trăm CPU.

| Mốc | Windows available MiB | WSL available MiB | WSL unavailable MiB | Swap used MiB | Windows CPU % | Linux load 1/5/15m | C: free GiB |
|---|---:|---:|---:|---:|---:|---|---:|
| 3.0 / trước operator | 4854 | 3771.8 | 4120.8 | 15.39 | 42 | 3.81 / 3.10 / 3.77 | 37.32 |
| 3.1 / sau operator | 4669 | 3714.4 | 4178.1 | 16.35 | 81 | 5.33 / 4.04 / 4.04 | 37.96 |
| 3.2 / sau StorageClass | 5088 | 3706.4 | 4186.2 | 16.43 | 66 | 4.78 / 4.10 / 4.05 | 37.93 |
| 3.3 / trước tạo Primary | 5034 | 3639.1 | 4253.4 | 16.43 | 35 | 2.89 / 3.68 / 3.91 | 37.93 |
| 3.3 / kiểm tra sau dừng | 4628 | 3649.9 | 4242.6 | 17.32 | 98 | 7.88 / 4.97 / 4.34 | 37.58 |
| Cuối phiên / Primary tự Ready | 4236 | 3573.6 | 4318.9 | 19.41 | 57 | 2.73 / 4.58 / 4.45 | 36.84 |

Preflight sáu mẫu Windows đầu: 3480–3526 MiB available, CPU 46–93%, C: 37,32GiB; mẫu gần lúc apply operator có Windows available 4854MiB. Background Windows thay đổi theo thời gian; không quy toàn bộ thay đổi RAM/ổ C cho Kubernetes.

Linux vmstat preflight: si/so=0 qua 11 khoảng 3 giây; CPU có đợt tăng ngắn, các khoảng idle khoảng 18–77%. Sau Primary Ready, ba khoảng 2 giây: CPU busy (us+sy) 45%, 21%, 21%; si/so=0 tại cửa sổ ngắn này. Điều đó không hủy safety stop đã xảy ra hoặc chứng minh ổn định dài hạn. Swap cuối 19,41MiB (tăng khoảng 4MiB từ đầu); memory PSI avg10=0,01%, không kernel OOM.

Operator request/limit **100m/500m, 128Mi/256Mi**; working set đo sau Ready **17,1MiB**, CPU mẫu khoảng 2,4m. PostgreSQL request/limit **200m/1000m, 384Mi/768Mi**; working set cuối **52,0MiB**, CPU mẫu khoảng 189m. Đây là số đo lúc rất ít dữ liệu/không application load; không dự báo được migration/standby catch-up hoặc 7 business Pods.

Container stats sau operator/storage và tại điểm dừng lưu `/tmp/jewelry-phase3/*-docker-stats.txt`. Cuối thời điểm dừng: node CP ~1,20GiB, Worker1 ~348MiB, Worker2 ~260MiB (trước Primary hoàn tất); gồm system/container overhead, không cộng thêm lần nữa vào Docker tổng.

Không có OOMKilled, Node MemoryPressure/DiskPressure hoặc tăng restart system trong phép so sánh trước/cuối. Không metrics-server được cài; RAM/CPU workload lấy CRI stats. Monitoring stop sau safety trigger; các snapshot cuối là read-only, không tiếp tục deployment.

## 9. Bảo vệ môi trường cũ và kiểm tra

- Tất cả container ID/status/start time/restart count/OOM/mount metadata ban đầu đối chiếu vẫn giống nhau tại kiểm tra sau điểm dừng. Không dừng/restart Compose hoặc thay volume. Đây là đối chiếu metadata, không phải checksum dữ liệu DB cũ.
- Không lệnh ghi SQL vào DB cũ, không dùng old RabbitMQ, không xem secrets/password/private key.
- Git tracked diff trước/kiểm tra sau điểm dừng giữ checksum `1bc26187bcda7657f3811026acc13b83c3998bd9c8376cd06c2f331067a42610`. Chỉ thêm cấu hình/tài liệu Giai đoạn 3 và cập nhật architecture doc do phiên trước tạo. Không reset thay đổi có sẵn, không commit/push.
- Namespace mới `cnpg-system`, `jewelry-demo`; StorageClass mới phân biệt rõ. Bootstrap Secret mới. Không `.wslconfig`, `.env`, business source/schema/migration thay đổi.
- YAML đã parse và operator/Cluster đã server dry-run trước áp dụng. Operator Ready, CRDs Established, webhook CA hiện diện; Cluster được webhook chấp nhận. SQL cuối chỉ SELECT/SHOW; chưa write probe hoặc runtime acceptance.

## 10. File tạo/sửa và bằng chứng

Tạo:
- `infra/k8s/cnpg/cnpg-1.30.1.yaml` — manifest upstream đã pin.
- `infra/k8s/cnpg/kustomization.yaml`.
- `infra/k8s/cnpg/operator-demo-patch.yaml`.
- `infra/k8s/cnpg/README.md`.
- `infra/k8s/postgres/storageclass.yaml`.
- `infra/k8s/postgres/cluster-bootstrap.yaml` — **checkpoint tạm 1 instance, không final HA manifest; không apply nhầm vào cluster 2 instances sau này**.
- `infra/k8s/postgres/README.md`.
- `docs/kubernetes-phase3-report.md`.
- `docs/evidence/kubernetes-phase3/resource-samples.json` — số đo không chứa secrets.
- `docs/evidence/kubernetes-phase3/safety-stop.json` — lý do và chuỗi mẫu kích hoạt dừng.

Sửa: `docs/kubernetes-architecture-plan.md` để ghi trạng thái triển khai thực tế, giữ nguyên kiến trúc đích.

Bằng chứng chi tiết tạm ở `/tmp/jewelry-phase3`: metadata, nodes/pods/PV/PVC, events, operator/worker CRI stats, SQL read-only, resource samples. Không dùng /tmp làm backup dữ liệu hoặc credentials.

## 11. Điều kiện để tiếp tục

**Giai đoạn 3 PARTIAL; Giai đoạn 4 chưa đủ điều kiện.** Primary một instance hiện tại không phải HA và chưa có đủ dependency/schema/migrations cho Auth, dù RAM tức thời còn headroom.

Trước lần tiếp tục cần đánh giá lại swap-in/out, memory PSI, CPU/Node/control-plane stability ở trạng thái idle đủ lâu; phân biệt swap nền rất nhỏ với swapping do thiếu RAM. Nếu muốn đổi quy tắc “liên tục tăng” thành ngưỡng thực dụng hơn, cần chốt rõ điều kiện trước khi chạy lại, không tự bỏ safety stop trong phiên này. Không mặc định cần tăng WSL RAM hoặc dừng Compose dựa trên 688KiB tăng swap.

Khi được tiếp tục, bắt đầu bằng kiểm tra resource **đã tồn tại**, giữ PVC/data/Secret, không chạy lại script sinh credential/bootstrap một cách mù quáng. Sau đó hoàn tất write probe checkpoint 3.3, bốn DB/least-privilege roles, Standby/replication, connection budget, broker demo, cấu hình và image/migration verification/Jobs theo thứ tự. Không tạo lại cluster hoặc xóa PVC để “làm sạch”.


## Tiếp tục Giai đoạn 3 — phiên đã được phê duyệt

Phần trên là lịch sử phiên đầu. Trạng thái tiếp tục nằm ở phần này.

<!-- RESUME-CHECKPOINT-TABLE -->

| Checkpoint | Trạng thái | WSL available MiB | Windows available MiB | Swap MiB | CPU Windows % | C: GiB |
|---|---|---:|---:|---:|---:|---:|
| 3.3R | Hoàn thành đo; xem acceptance bên dưới | 3520.7 | 3544 | 20.86 | 19 | 36.82 |


### 3.3R — PASS

Đã theo dõi ít nhất 5 phút, ít nhất 10 mẫu nhẹ. Dùng quy tắc mới đã phê duyệt: swap tăng nhỏ không tự kích hoạt stop; RAM thấp kéo dài ~60 giây, swap IO >1MiB/s kèm full memory PSI >5% kéo dài, OOM/Node pressure/restart liên tiếp mới dừng. Có cả snapshot Node/Pod và counter swap; không stress test. Primary/PVC cũ giữ nguyên, không bootstrap lại.
| 3.4 | Hoàn thành đo; xem acceptance bên dưới | 3502.7 | 3378 | 23.43 | 71 | 36.82 |


### 3.4 — PASS

4 Database + 8 DatabaseRole CRDs reconciled; owner mỗi DB/schema là `<service>_migrator`, bootstrap auth_db giữ nguyên. Migration roles có connectionLimit=2, runtime roles auth=16/inventory=35/sales=35/report=20. ACL/default privileges do privileges.sql quản lý, không cạnh tranh ownership với CRDs. 8 roles đăng nhập thật qua endpoint -rw/TLS, 24 kiểm tra quyền CONNECT chéo đều false; runtime có USAGE, không CREATE schema. Write probe transaction rollback hoàn tất. Migrations không yêu cầu CREATE EXTENSION; chưa chạy migration. Credentials demo riêng trong Secrets, không in/lưu Git.


| Checkpoint | Trạng thái | WSL available MiB | Windows available MiB | Swap MiB | CPU Windows % | C: GiB |
|---|---|---:|---:|---:|---:|---:|
| 3.5 | Hoàn thành đo; xem acceptance bên dưới | 3468.1 | 3168 | 32.91 | 95 | 35.6 |


### 3.5 — PASS

Hai PostgreSQL instances Ready trên hai Worker, hai PVC Bound/PV riêng. Gỡ hostname selector bootstrap, giữ required anti-affinity/worker label; vai trò primary không pin node. Recovery false/true, streaming async kiểm chứng bằng SQL. Ghi probe bằng runtime roles vào bảng do migrator tạo ở cả bốn schema, Standby đọc đúng token; đã xóa đúng bốn bảng probe và kiểm tra cleanup trên Standby. Ba mẫu replication lag được lưu trong bằng chứng. Không promote/shutdown/failure test. Endpoint -rw theo Primary. RPO có thể >0; local PV và một laptop không là storage HA, required anti-affinity có thể để replacement Pending khi chỉ còn một Worker. CNPG 1.30.1 có primary Lease/isolation liveness check; chưa kiểm chứng fencing/failover thực tế.


| Checkpoint | Trạng thái | WSL available MiB | Windows available MiB | Swap MiB | CPU Windows % | C: GiB |
|---|---|---:|---:|---:|---:|---:|
| 3.6 | Hoàn thành đo; xem acceptance bên dưới | 3425.8 | 3171 | 32.91 | 35 | 35.6 |


### 3.6 — PASS cho ngân sách demo nhẹ

Source hiện tại: Auth không có consumer nên pool=5 hợp lệ; Inventory/Sales/Report có consumer prefetch10+reserve5, chọn pool=15. Report DLQ observer prefetch1 dùng chung PrismaService; outbox/recovery workers không tạo pool riêng. CLI/admin/backfill không chạy trong app replica, cần tính riêng nếu bật sau này.

| Workload | Replicas | Pool/Pod | Trần |
|---|---:|---:|---:|
| Auth | 2 | 5 | 10 |
| Inventory | 2 | 15 | 30 |
| Sales | 2 | 15 | 30 |
| Report | 1 | 15 | 15 |
| Tổng | 7 | | 85 |

Cùng pool15 cho cả7 là105, pool20 là140. Đã giữ max_connections=128, không tăng database parameters. Budget mục tiêu85 + migration Job tuần tự2 + operator/admin/monitoring10 + reserved slots3 =100/128, dư28. Replication WAL sender có max_wal_senders riêng, vẫn tính thêm RAM/process (~1 sender hiện tại). Runtime connectionLimits tổng106 + 8 migration-role ceilings + reserved/admin dự phòng vẫn cần kiểm soát CLI/monitor ngoài dự kiến.

Profile chuẩn bị maxSurge=0, maxUnavailable=1 để tránh vô tình thêm cả replica/pool trong rollout; đây là dữ liệu cấu hình, chưa Deployments. Pool là trần, chưa có business connections thực tế. shared_buffers128MB, work_mem2MB, maintenance32MB, PG limit768Mi: đủ budget demo nhẹ theo số đo hiện tại, không bảo đảm85 truy vấn nặng đồng thời. Một query có thể nhiều work_mem operators, bộ nhớ backend/shared accounting không cộng RSS đơn giản. Không load/stress test; Giai đoạn4 phải deploy tuần tự và tiếp tục giám sát.



| Checkpoint | Trạng thái | WSL available MiB | Windows available MiB | Swap MiB | CPU Windows % | C: GiB |
|---|---|---:|---:|---:|---:|---:|
| 3.7 | Hoàn thành đo; xem acceptance bên dưới | 3426.2 | 2737 | 97.16 | 63 | 35.2 |


### 3.7 — PASS

Broker RabbitMQ4.4.0 riêng ngoài kind Worker, Compose project jewelry-demo-deps/container jewelry-demo-rabbitmq/volume jewelry-demo-rabbitmq-data; network kind, không host ports. Memory limit768Mi CPU0.75, watermark384Mi, logs5Mi×2. Vhost jewelry-demo và credentials mới; app configure ^$ nên topology provision riêng từ topology.json. Password hashes chỉ ở file protected ngoài Git, mật khẩu ở Kubernetes Secrets, không in. Pod Node UID1000 dùng image gateway local nhưng không chạy NestJS: TCP/AMQP login bằng demo app credential qua ClusterIP/DNS, publish confirm và consume đúng message PASS. Test queue/Pod/ConfigMap đã cleanup. EndpointSlice chứa Docker IP hiện tại, phải reconcile nếu broker recreate đổiIP; không failover broker. Broker1instance vẫn SPOF, không RabbitMQ HA.


| Checkpoint | Trạng thái | WSL available MiB | Windows available MiB | Swap MiB | CPU Windows % | C: GiB |
|---|---|---:|---:|---:|---:|---:|
| 3.8 | Hoàn thành đo; xem acceptance bên dưới | 3318.6 | 2796 | 96.98 | 47 | 35.2 |


### 3.8 — PASS

4 runtime/migration URLs riêng tới CNPG -rw trong demo Secrets; giữ nguyên passwords đã provision. Runtime pg dùng sslrootcert+verify-full; Prisma migrate dùng sslcert+require+strict và connection_limit2. ConfigMaps common/4service/resource profiles đã có. JWT RSA2048 mới: auth-jwt-signing private chỉ Auth-specific probe/future Auth mount; jwt-verification chỉ public. UID1000/fsGroup1000/mode0440 kiểm thử đọc và sign/verify PASS; PostgreSQL CA/hostname TLS verification PASS. Volume CA chỉ project ca.crt, tuyệt đối không mount ca.key. Auth-specific probe không chạy NestJS, đã cleanup. Không sửa .env/keys cũ. GOOGLE_CLIENT_ID là placeholder vô hiệu chủ đích; Google OAuth cần clientID demo hợp lệ trước khi kiểm thử flow đó, không dùng ID/key môi trường cũ. Upstream app URLs là cấu hình cho Giai đoạn4, Services business chưa deploy.


| Checkpoint | Trạng thái | WSL available MiB | Windows available MiB | Swap MiB | CPU Windows % | C: GiB |
|---|---|---:|---:|---:|---:|---:|
| 3.9-auth | Hoàn thành đo; xem acceptance bên dưới | 3405.6 | 2810 | 134.68 | 37 | 35.23 |


### 3.9 / auth — PASS

Job Completed; 4 history rows có checksum trùng SQL working tree, finished_at đầy đủ/không rollback. Tables/constraints được kiểm tra read-only; runtime không có quyền sửa _prisma_migrations. Job tuần tự, không reset/db push/seed. Image content ID và hash đối chiếu lưu bằng chứng.


| Checkpoint | Trạng thái | WSL available MiB | Windows available MiB | Swap MiB | CPU Windows % | C: GiB |
|---|---|---:|---:|---:|---:|---:|
| 3.9-inventory | Hoàn thành đo; xem acceptance bên dưới | 3351.6 | 2649 | 152.70 | 22 | 34.86 |


### 3.9 / inventory — PASS

Job Completed; 13 history rows có checksum trùng SQL working tree, finished_at đầy đủ/không rollback. Tables/constraints được kiểm tra read-only; runtime không có quyền sửa _prisma_migrations. Job tuần tự, không reset/db push/seed. Image content ID và hash đối chiếu lưu bằng chứng.


| Checkpoint | Trạng thái | WSL available MiB | Windows available MiB | Swap MiB | CPU Windows % | C: GiB |
|---|---|---:|---:|---:|---:|---:|
| 3.9-sales | Hoàn thành đo; xem acceptance bên dưới | 3390.9 | 2629 | 177.72 | 44 | 34.36 |


### 3.9 / sales — PASS

Job Completed; 15 history rows có checksum trùng SQL working tree, finished_at đầy đủ/không rollback. Tables/constraints được kiểm tra read-only; runtime không có quyền sửa _prisma_migrations. Job tuần tự, không reset/db push/seed. Image content ID và hash đối chiếu lưu bằng chứng.


| Checkpoint | Trạng thái | WSL available MiB | Windows available MiB | Swap MiB | CPU Windows % | C: GiB |
|---|---|---:|---:|---:|---:|---:|
| 3.9-report | Hoàn thành đo; xem acceptance bên dưới | 3413.0 | 2641 | 190.06 | 23 | 33.89 |


### 3.9 / report — PASS

Job Completed; 7 history rows có checksum trùng SQL working tree, finished_at đầy đủ/không rollback. Tables/constraints được kiểm tra read-only; runtime không có quyền sửa _prisma_migrations. Job tuần tự, không reset/db push/seed. Image content ID và hash đối chiếu lưu bằng chứng.


| Checkpoint | Trạng thái | WSL available MiB | Windows available MiB | Swap MiB | CPU Windows % | C: GiB |
|---|---|---:|---:|---:|---:|---:|
| FINAL | Hoàn thành đo; xem acceptance bên dưới | 3464.9 | 2639 | 190.83 | 10 | 33.89 |
