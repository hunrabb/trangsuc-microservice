# Giai đoạn 4 — kế hoạch và nghiệm thu checkpoint 4.0

Ngày kiểm tra: 13/11/2026, UTC+7. **Chỉ chuẩn bị, chưa triển khai.**

Kết luận 4.0: kiểm tra và bản nháp đã hoàn thành; **preflight triển khai FAIL/HOLD** vì có restart mới do mất lease/API timeout của control plane/operator ngay trước phiên kiểm tra. Tại thời điểm đo các thành phần đã Ready; chưa xác định nguyên nhân timeout. Không đánh đồng trạng thái Ready hiện tại với đủ bằng chứng ổn định để tăng tải. Auth còn cần rebuild runtime trước khi chạy 2 replicas. Không tự chuyển 4.1.

## 1. Kiến trúc chính thức và phạm vi

Tài liệu này áp dụng quyết định mới của người dùng, thay thế phần đề xuất NestJS Gateway/số replica cũ trong `docs/kubernetes-architecture-plan.md`; không chỉnh sửa tài liệu hoặc hạ tầng Giai đoạn 3.

Cluster `jewelry-lab`, kind v0.33.0/Kubernetes v1.36.1; kubeconfig `/home/hung/.kube/jewelry-lab.config`. Namespace ứng dụng `jewelry-demo` đã tồn tại. Không tạo cluster/namespace khác.

| Thành phần | Worker 1 | Worker 2 | Ghi chú |
|---|---:|---:|---|
| Auth | 1 | 1 | Chung DB/session và demo JWT keypair |
| Inventory | 1 | 1 | Consumer/outbox/schedulers cần nghiệm thu cạnh tranh |
| Sales + Payment | 1 | 1 | Payment nằm trong Sales |
| Report | 1 | 0 | Ưu tiên Worker 1; có thể reschedule sang Worker 2 |
| PostgreSQL | 1 | 1 | Primary/Standby hiện tại; vai trò có thể đổi sau failover |
| Kong Gateway | 1 | 1 | Gateway chính thức, DB-less, không NestJS Gateway |
| Nginx | 1 | 1 | Mỗi Pod chứa cả Backoffice và Storefront |
| Tổng | 7 | 6 | **13 Pod**, không tính broker/operator/system |

CNPG operator nằm control plane; RabbitMQ demo là container độc lập trên Docker network `kind`, ngoài Kubernetes và ngoài hai Worker. Không thêm Redis, Kong database, ingress controller hay gateway ẩn vào số 13. Ba kind node là container dùng chung laptop, không phải ba máy vật lý độc lập.

Anti-affinity bắt buộc theo hostname cho mỗi Deployment 2 replicas, chỉ vào node có label `jewelry-lab-worker=true`. Khi một Worker chết, replica trên Worker còn sống tiếp tục phục vụ; replica thay thế có thể Pending do chỉ còn một Worker phù hợp. Không hứa khôi phục ngay đủ 2 replicas trên một Worker. Control plane đơn và laptop vẫn là điểm lỗi chung. Report một replica có gián đoạn khi reschedule.

## 2. Preflight đo thực tế

Nguồn dữ liệu: Windows CIM/PSDrive; `/proc/meminfo`, vmstat/PSI/load; Docker inspect chọn lọc; Kubernetes get/logs; SQL SELECT. Có timeout, không stress test. Các bản ghi có timestamp và kết quả kiểm tra nằm ở `docs/evidence/kubernetes-phase4-0/`.

| Chỉ số | Đầu phiên 05:22:57 UTC | Cuối phiên 05:51:42 UTC |
|---|---:|---:|
| Windows available | 4.58 GiB (4689 MiB) | 4.34 GiB (4449 MiB) |
| Windows CPU mẫu tức thời | 55% | 66% |
| WSL available | 3.47 GiB (3552.4 MiB) | 3.28 GiB (3362.1 MiB) |
| WSL used = MemTotal − MemAvailable | 4.24 GiB | 4.42 GiB |
| Swap used | 176.86 MiB | 208.29 MiB |
| Load average 1/5/15 phút | 14.99 / 12.12 / 7.34 | 2.33 / 2.72 / 3.91 |
| Memory PSI some/full avg10 | 0 / 0 | 0 / 0 |
| Kernel oom_kill | 0 | 0 |
| Ổ C trống | 33.79 GiB | 33.72 GiB |

Trong chuỗi 12 mẫu 05:30–05:34 UTC: Windows available 4647–4834 MiB, WSL available khoảng 3411–3510 MiB; CPU Windows có spike 100%, không kết luận nghẽn kéo dài từ một mẫu. Không có restart tăng thêm trong chuỗi này. Swap tăng ít không phải lý do dừng: cuối phiên vmstat 4 khoảng 1 giây liên tiếp có si/so = 0/0, CPU idle 63–75%, iowait 1–2%; IO PSI some/full avg10 khoảng 3.45/1.95, CPU PSI some avg10 17.91. Không có MemoryPressure/DiskPressure/PIDPressure, OOMKilled hoặc áp lực bộ nhớ kéo dài tại các mẫu đã quan sát. Không đủ dữ liệu để khẳng định không có bất kỳ spike nào giữa các mẫu.

**Sự cố mới trước kiểm tra:** khoảng 05:21 UTC scheduler/controller-manager restart count từ 2 lên 3; CNPG operator từ 0 lên 1. Exit code 1/Error, không OOM. Previous logs báo API timeout và mất leader lease; events cùng thời điểm có readiness/liveness timeout ở API server, etcd, CoreDNS, PG và operator. API server/etcd/PG không có restart tương ứng. Nguyên nhân CPU/IO/host pause chưa được chứng minh, không tự quy cho thiếu RAM. Các Pod hiện phục hồi Ready không xóa bỏ sự cố này. Từ mẫu đầu 05:22:57 tới mẫu cuối 05:51:42 UTC (~29 phút), số restart không tăng thêm; bằng chứng previous logs được lưu riêng. Gate giữ nguyên vì chưa xác định nguyên nhân và chưa kiểm chứng dưới tải build/load.

Gate trước 4.1: đọc lại previous logs/host CPU/IO và theo dõi ít nhất 10–15 phút với tải nền thực tế, không restart tăng mới, lease renewal ổn định, probe timeout không lặp lại; nếu tái diễn, xử lý nguyên nhân và nghiệm thu lại trước build/load. Không tự nới lease/probe timeout để che lỗi, không thay `.wslconfig`, không dừng Compose.

## 3. Dependencies đã kiểm tra

- 3/3 Node Ready; 16 Pod Running/Ready gồm 13 system + CNPG operator + 2 PG. Bốn migration Pod Succeeded/Completed, không phải lỗi readiness. Chưa có Deployment business/Kong/Nginx.
- CNPG 1.30.1 Ready; Cluster `jewelry-pg` healthy, readyInstances=2. `jewelry-pg-1` primary Worker 1, `jewelry-pg-2` standby Worker 2, restart=0.
- Replication `streaming`, `async`, replay lag 0 byte tại phép đo; không bảo đảm RPO=0 với async. RW EndpointSlice Ready trỏ primary `jewelry-pg-1`; ứng dụng dùng `jewelry-pg-rw.jewelry-demo.svc.cluster.local:5432`, không Pod IP.
- Mỗi instance có PVC riêng 5 GiB RWO Bound. Storage local-path/Retain trên kind không chịu mất laptop/cluster/PVC; không sửa storage hay dựng lại DB. Hai PG không tự chứng minh fencing/failover an toàn; operator/API ổn định là dependency, worker failure/reconnect/RTO/RPO chưa test ở 4.0.
- `auth_db`, `inventory_db`, `sales_db`, `report_db` đúng owner migrator và schema hiện tại; migration history 4/13/15/7, tổng 39, finished không rolled-back. SQL/schema trong runtime images khớp source và lịch sử Giai đoạn 3. Không chạy lại migrations.
- `jewelry-demo-rabbitmq` running/healthy, restart=0/OOM=false, vhost demo riêng, endpoint Service `rabbitmq.jewelry-demo.svc.cluster.local:5672`. Broker không nằm trên Worker, nên Worker failure không dừng broker; broker/laptop vẫn SPOF. Selectorless EndpointSlice cần kiểm tra/cập nhật ở checkpoint được duyệt nếu container được tạo lại và đổi IP; không thay trong 4.0.

## 4. Audit images và working tree

Repository có nhiều tracked/untracked thay đổi từ trước. Không reset, không build từ HEAD cũ; source hiện tại trong working tree là đầu vào kiểm tra. Hash tracked diff trước/sau không đổi: `1bc26187bcda7657f3811026acc13b83c3998bd9c8376cd06c2f331067a42610`.

Phương pháp: inspect metadata; tạo container kiểm tra **không start**, copy chọn lọc `/app/dist`, common/contracts dist, Prisma files hoặc frontend artifacts/plugin Lua rồi gỡ đúng container tạm của phiên. Không khởi chạy binary ứng dụng, không mount dữ liệu cũ, không build image. TypeScript compiler emit vào bộ nhớ để đối chiếu hash JS, không ghi `dist`/generated client/source. Số expected app JS: Auth48, Inventory70, Sales77, Report43; common30/contracts21. So sánh bao gồm JS generated Prisma và `prisma/schema.prisma`/migration SQL. Migrations đã chạy được đối chiếu ở Giai đoạn 3 và kiểm tra finished ở phiên này.

| Image hiện tại | Content ID sha256 (viết tắt) | Kết quả | Hành động tương lai |
|---|---|---|---|
| `jewelry/auth:dev` | `744417b6170f` | Own app/common/Prisma khớp; contracts lệch `inventory-api.js`, `openapi.js` | **Rebuild runtime** tại 4.1 |
| `jewelry/inventory:dev` | `b60fb9329a8b` | App/common/contracts/Prisma đều khớp | Dùng lại content, tạo alias riêng/load Worker ở 4.2 |
| `jewelry/sales:dev` | `e727db111d43` | App lệch `online/online-orders.service.js`; contracts lệch `inventory-api.js`, `openapi.js` | **Rebuild runtime** tại 4.3 |
| `jewelry/report:dev` | `9042bfe63bf8` | Own app/common/Prisma khớp; contracts lệch/thiếu `customer-account.js`, `index.js`, `inventory-api.js`, `openapi.js` | **Rebuild runtime** tại 4.4 |
| `jewelry/kong-candidate:dev` | `af47135d1052` | 8 plugin Lua khớp source; builtin JWT có verified-token context/priority phù hợp | Dùng lại có điều kiện, parse/runtime/security tests trước 4.5 |
| `jewelry/backoffice:dev` | `421a1ede22db` | Artifacts khớp local dist, ngoài `50x.html` mặc định; chưa chứng minh current TSX/build args | **Rebuild artifacts demo có kiểm soát** trước 4.6 |
| `jewelry/storefront:dev` | `079e08317192` | Như trên; không đủ provenance current source | **Rebuild artifacts demo có kiểm soát** trước 4.6 |

Full image IDs, timestamp, kiến trúc amd64, UID và hash/mismatch nằm trong `image-audit.json`. Hash match xác minh nội dung đã so sánh, không phải attestation đầy đủ cho toàn bộ dependency supply chain. Runtime compatibility vẫn phải nghiệm thu sau deploy.

Dockerfile Auth/Inventory/Sales/Report dùng Node24.22.2, context repo root, build common/contracts và generated Prisma; frontend cũng context root, Nginx unprivileged 1.30.6. `.dockerignore` loại secrets/.env/node_modules/dist/infra/docs khỏi context. Kong dùng `infra/kong` context, base Kong3.9.4, custom plugins. Không đổi Dockerfile trong 4.0. Không dùng image migration thay runtime chỉ vì cùng schema.

Container Kong Compose cũ exit127 có `.State.Error` vì host bind source `/kong/kong.yml` là directory thay vì file, xảy ra trước startup. Đây không phải bằng chứng binary/plugin lỗi; không sửa/start lại Compose. Draft Kubernetes mount ConfigMap thành directory `/kong` để không lặp lỗi bind host này.

Danh sách rebuild đã xác định: **Auth, Sales, Report, Backoffice, Storefront**. Inventory không cần rebuild dựa trên nội dung đã kiểm tra; Kong không cần rebuild chỉ vì lỗi bind mount cũ, nhưng phải qua runtime gates. Không rebuild/rerun bốn migration images/Jobs.

### Quy trình build/load đề nghị (chưa chạy)

Từng image một, đúng Dockerfile/context hiện tại; tạo tag demo duy nhất gắn source fingerprint + ngày build, ghi full image ID và explicit public build args; không tái dùng `:dev`. Fingerprint phải bao gồm dirty/untracked source liên quan, Dockerfile, lockfile, common/contracts, Prisma; chỉ Git commit SHA không đủ. Sau build đối chiếu artifacts một lần nữa rồi load vào từng Worker tuần tự, verify image ID trong containerd. Không đẩy registry/retag ảnh cũ trong 4.0.

Ngân sách đề nghị: builder giới hạn khoảng 0.75–1 CPU và 1.5 GiB RAM, parallelism=1; build tuần tự, theo dõi Windows/WSL/IO/control-plane. Đây là budget cần cấu hình/xác minh ở 4.1, không phải giới hạn đã được áp vào Dockerfile hiện tại. Không coi NODE_OPTIONS trên host là đã giới hạn toàn bộ Docker build. Nếu không đạt budget thì dừng và báo, không build không giới hạn hoặc tự dừng Compose. Dự trù thêm 3–6 GiB đĩa tổng cho layers/cache/load là **ước lượng**, C còn 33.72 GiB; giữ tối thiểu 15 GiB trống, không tự prune. Không tải image mới trong 4.0.

Backoffice: build args Google ID để trống (OAuth chưa cấu hình), các `VITE_POS_BANK_*` để trống hoặc giá trị demo công khai đã duyệt, không nhúng thông tin ngân hàng thật. Storefront tên cửa hàng demo nếu cần; xác minh Dockerfile/Vite thực sự nhận giá trị trước khi ghi nhận provenance. Cả hai dùng API cùng origin `/api`. Không cần sửa Dockerfile để dual-SPA: dùng init containers sao chép hai bộ artifacts vào mỗi Nginx Pod.

## 5. Manifest mới, chưa apply

| Đường dẫn | Nội dung |
|---|---|
| `infra/k8s/apps/{auth,inventory,sales,report}/` | Mỗi app Deployment, Service, kustomization riêng để triển khai từng checkpoint |
| `infra/k8s/apps/kustomization.yaml` | Tổng hợp 4 app, không dùng cho bước Auth-only |
| `infra/k8s/kong/` | Deployment2, Service8000, ConfigMap DB-less + public key demo, kustomization |
| `infra/k8s/nginx/` | Deployment2, 2 init containers/Pod, ConfigMap full nginx.conf, NodePort Service, kustomization |
| `infra/k8s/overlays/demo/phase4/` | Bản tổng hợp chỉ 14 tài nguyên mới, tách hoàn toàn overlay Giai đoạn 3 |

Tất cả namespace `jewelry-demo`; labels `app.kubernetes.io/name`, `part-of=jewelry-demo`, `managed-by=phase4-draft`; selectors không đụng CNPG/broker/migration Jobs. **Không include/apply lại base Giai đoạn 3**. Mỗi app dùng Service DNS port3000. Không dùng Pod IP làm upstream. Không có Secret credentials trong manifests; chỉ ConfigMap public RSA verification key cho Kong, không private key.

Image tags `phase4-build-required`/`phase4-web-build-required` và alias Inventory/Kong trong draft **chưa tồn tại/chưa load**; imagePullPolicy Never để không pull nhầm tag ngoài ý muốn. Trước checkpoint tương ứng phải thay placeholder bằng artifact đã kiểm chứng. Không áp toàn overlay để bỏ qua checkpoint.

Security: business UID/GID1000; Kong1001 theo `/etc/passwd` image; Nginx101; runAsNonRoot, readOnlyRootFilesystem, drop ALL, no privilege escalation, RuntimeDefault, không mount service-account token. Writable tmp/prefix/assets dùng emptyDir có giới hạn, assets dùng disk chứ không memory-backed. Secret mode0440 + fsGroup runtime. Apps grace45s, startup tối đa180s; rolling update maxSurge0/maxUnavailable1 tránh Pod surge trên máy nhỏ. Không chạy migration/seed trong init/startup ứng dụng.

Apps: startup/liveness `/health/live`; readiness `/health/ready` DB+broker, period5s/timeout3s, source readiness timeout2s chạy song song. Liveness không phụ thuộc DB/broker để tránh restart storm. Timeout readiness không hủy query DB đang chạy: cần quan sát pool sau fault, không coi bounded HTTP đồng nghĩa query đã cancel. Shared bootstrap bật shutdown hooks; preStop3s drain trước SIGTERM, grace45s; consumer/outbox dừng phải được nghiệm thu, không đổi business code.

Kong: DB off, proxy8000, status8100; Admin API off, status không expose qua Service. Live/start `/status`, ready `/status/ready`. Prefix/tmp writable, một Nginx worker, cache32m/LMDB32m/shared rate dict8m. Dữ liệu ConfigMap cùng public key cho cả hai replicas, không mount JWT private key. Cấu hình/probe dựa trên Kong3.9.4 source; `kong config parse`, startup, quyền readonly/memory footprint vẫn pending 4.5.

Nginx: mỗi Pod có 2 init containers từ các image frontend đã build, copy + kiểm tra index không rỗng vào `/web/backoffice` và `/web/storefront`; main process dùng Nginx từ Backoffice image nhưng override **full** nginx.conf và bỏ entrypoint template writes. Cổng8080/8081 phục vụ hai SPA tại root riêng, tránh xung đột `/assets` hoặc yêu cầu sửa React base. Missing assets/catalog-images trả404, deep link fallback index, index no-cache. Startup/live health trên8080, ready health trên8081, assets immutable sau init. Proxy `/api/` giữ path/query tới Kong FQDN, DNS re-resolve bằng kube-dns **ServiceIP 10.96.0.10** đã đo, không Docker resolver. `/internal` và `/webhooks` bị chặn tại web entry; bank webhook cần kiểm tra bảo vệ và mở có chủ đích nếu demo sau này cần. Không retry tự động POST khi upstream lỗi. Phải chạy `nginx -t` và kiểm tra cả hai SPA ở từng replica trước nghiệm thu.

## 6. ConfigMap, Secret và connection pools

| Runtime | Tham chiếu đã kiểm tra | Mount/cấu hình |
|---|---|---|
| Cả 4 app | `jewelry-common`, `<app>-config` | NODE_ENV/PORT/JWT issuer/audience/upstream Service DNS |
| Từng app | `<app>-runtime-creds`: DATABASE_URL | Đúng own DB/schema trên CNPG RW; password có, không xuất giá trị |
| Cả 4 app | `rabbitmq-demo-app`: RABBITMQ_URL | Đúng Service/vhost demo, không Compose broker cũ |
| Cả 4 app | `jwt-verification`: public.pem | `/run/secrets/jwt-public/public.pem`, read-only |
| Chỉ Auth | `auth-jwt-signing`: private.pem | `/run/secrets/jwt-private/private.pem`, read-only; không đọc/in key |
| Cả 4 app | `jewelry-pg-ca`: **chỉ ca.crt** | `/run/secrets/postgres/ca.crt`, verify-full, không mount CA private key |

Public key fingerprint SHA256 `ea18fe0c071b4aa202541cef643cfe092209882658c40d134c07244a49aaf8c9`. Keypair consistency dựa trên Auth-specific probe PASS Giai đoạn 3, không xoay key và không đọc lại private key trong 4.0. Kong public key draft khớp byte của `jwt-verification`. Không copy credentials/migration URL vào tài liệu/Git. Runtime không nhận migration credentials.

Auth DATABASE_POOL_MAX=5 (không consumer), Inventory/Sales/Report=15 (prefetch10 + reserve5). Một Prisma pool chung/app, không tạo pool riêng cho từng scheduler. Tổng trần 2×5+2×15+2×15+1×15 = **85** runtime connections. PG max_connections128: dự trù migration2 + ops10 + reserved3 =>100, còn28; WAL senders là budget process riêng. Role connection limits hiện tại Auth16/Inventory35/Sales35/Report20. Không tăng pool khi tăng replicas mà chưa tính lại. Readiness cũng dùng pool nên cần headroom thực tế, max_connections đơn thuần chưa bảo đảm latency.

Google Client ID placeholder chỉ cho phép health và luồng không Google: customer register/password login/refresh/logout/me, staff password login khi có fixture demo hợp lệ. Không dùng tài khoản thật, không tự seed/create-admin trong 4.0; kế hoạch fixture cần duyệt riêng trước test login. Không tuyên bố Google OAuth PASS.

## 7. Scale safety qua source review

| Thành phần | Cơ chế đã thấy | Acceptance còn thiếu |
|---|---|---|
| Auth | Session/refresh trong DB; staff rotation transaction, customer refresh updateMany CAS; keys/issuer/audience chung | Cạnh tranh refresh/replay, login/chuyển replica, không phụ thuộc sticky session |
| Shared outbox | Claim atomic + FOR UPDATE SKIP LOCKED/lease; publish confirmation | Lease expiry/crash/retry khi 2 publishers, backlog không kẹt |
| Consumers | Inbox/ProcessedEvent unique, mutation cùng transaction, ACK sau commit | Duplicate delivery/rollback/retry và không nhân đôi side effects; at-least-once, không exactly-once |
| Inventory | Reservation expiry row locks/SKIP LOCKED; daily close advisory transaction lock + unique DB + outbox; exchange expiry dựa lock/CAS | Hai scheduler quét cùng dữ liệu, expiry/close không nhân đôi |
| Sales | Online recovery SKIP LOCKED, POS recovery lease + Inventory idempotency, settlement recovery row locks/idempotent ops | Biến running trong process không là distributed lock; test settlement/payment concurrency, crash window và retries |
| Report | Chỉ 1 replica theo kiến trúc, inbox dedup vẫn cần khi broker redelivery | Consumer pool15/readiness, projection không nhân đôi, replay/outbox consistency |

Không thấy lý do phải sửa business logic ngay để tạo manifest, nhưng source review không chứng minh an toàn toàn bộ concurrency. Mọi rủi ro logic phát hiện khi test phải báo và dừng checkpoint tương ứng; không tự sửa trong 4.0. Kết nối lại PostgreSQL sau promotion phải test bằng readiness và truy vấn mới; không được hứa tự reconnect chỉ từ PG Service DNS.

## 8. Kong policy và browser entry

DB-less draft được tạo từ hàm `generateConfig` hiện tại (không chạy CLI đọc `.env`/key cũ), đổi upstream sang Service FQDN demo; RS256 demo issuer/audiences đúng. Builtin JWT priority1450 kiểm tra signature; custom policy1400 dùng verified-token context, kiểm tra iss/aud/sub/exp/nbf; chỉ Bearer header, không query/cookie token. Route guard, request boundary và correlation ID giữ theo source; strip spoofed identity headers. Routes giữ auth/public shop/protected my-orders/pos/admin/report, regex priority và prefix boundary, retries=0. Cả hai Kong dùng cùng ConfigMap; không đụng gateway Compose.

**Gate P0 trước 4.5:** `jewelry-rate-policy` dùng ngx.shared dict **cục bộ mỗi Kong Pod**. Hai replicas không chia sẻ counters; traffic phân bố có thể nhận tổng quota cao hơn và counter mất khi restart. Không gọi đây là global rate limiting. Cần người dùng chấp thuận semantics per-Pod cho demo, hoặc thiết kế store chung/plugin thay đổi trong scope riêng; không tự thêm Redis hoặc sửa plugin.

**Gate IP trust trước 4.5/4.6:** draft `KONG_TRUSTED_IPS=127.0.0.1,::1` bảo thủ; không copy static Docker Nginx IP cũ, không trust toàn Pod CIDR khi chưa có kiểm soát mạng thực thi. Nginx ghi đè X-Forwarded-For bằng remote_addr. Với draft này Kong nhìn peer proxy thay vì browser và các user có thể chung rate bucket. Client-IP parity chưa đạt; phải chốt trust chain cùng external entry. Không mở Kong trực tiếp ra Windows, Admin API không expose. TLS/domain/cookie Secure/origin cần xác minh trong 4.6/4.7; không tắt auth cookie security bằng thay code âm thầm.

### Windows/Browser → Cluster

Hiện kind không có extraPortMappings cho web; không recreate kind hoặc thay port mappings. Draft `nginx-web` NodePort30080→8080 và30081→8081, externalTrafficPolicy Cluster; đây là Service config, **không tự xuất Windows host port**. Các cổng Compose hiện tại3000/8080/8081 đang dùng, dự kiến demo dùng loopback18080/18081 (đã kiểm tra trống, phải kiểm tra lại lúc triển khai).

Port-forward Service18080:8080/18081:8081 chỉ dùng kiểm tra chức năng tạm thời: kubectl chọn một Pod, connection/forward có thể dừng khi Pod đó chết. **Không dùng port-forward này làm bằng chứng HA**.

Đề nghị cho 4.6 cần duyệt: một external entry proxy riêng ngoài kind Workers, trên Docker network kind, publish127.0.0.1:18080/18081, backends là NodePort của các kind nodes qua node IP đã kiểm tra lại, có health checks và loại backend lỗi. Không cần đổi kind; không thêm Kubernetes Pod vào tổng13, nhưng thêm container host và tài nguyên phải tính riêng. Không viết/chạy proxy này trong 4.0. Windows không được mặc định truy cập trực tiếp Docker bridge IP. Proxy vẫn SPOF cấp laptop; chỉ chứng minh chịu Worker failure. Trust chain/TLS/cookie và retry theo HTTP method phải nghiệm thu cùng entry; không retry ghi tiền/đơn hàng mù quáng.

## 9. Requests/limits và dự trù tài nguyên

Các số sau là **budget đề xuất**, chưa đo trên các Pod mới.

| Workload | Replicas | Request CPU/RAM mỗi Pod | Limit CPU/RAM mỗi Pod |
|---|---:|---|---|
| Auth | 2 | 100m / 192Mi | 500m / 384Mi |
| Inventory | 2 | 100m / 256Mi | 750m / 512Mi |
| Sales | 2 | 100m / 256Mi | 750m / 512Mi |
| Report | 1 | 100m / 256Mi | 500m / 512Mi |
| Kong | 2 | 100m / 256Mi | 750m / 512Mi |
| Nginx | 2 | 25m / 64Mi | 250m / 128Mi |
| Nginx init containers (tuần tự mỗi Pod) | 2/Pod | 25m / 32Mi | 250m / 64Mi |

11 Pod mới request **2304Mi RAM + 950m CPU**, limit tổng **4608Mi RAM + 6500m CPU**; không tính thêm init RAM cộng dồn vào main vì init chạy tuần tự. Mỗi container có ephemeral request32Mi/limit256Mi; tmp/assets/prefix có sizeLimit riêng. Requests không phải mức sử dụng đã đo, limits không được coi đã có sẵn headroom. WSL nhìn khoảng7.7Gi tổng; ba kind nodes cùng chia sẻ host chứ không tạo thêm RAM/CPU. Limits CPU cộng > CPU laptop chỉ là ceiling cgroup, không phải khả năng xử lý thật.

Đã chạy PG/operator/system/broker/Compose nằm trong baseline RAM hiện tại, không cộng hai lần. Ước lượng tăng thêm khi idle/normal nhẹ cho 11 Pod mới khoảng1.45–2.25Gi (business1.0–1.4Gi, Kong0.4–0.7Gi, web0.05–0.15Gi); WSL available có thể chỉ còn khoảng1.0–1.8Gi. Startup/build/PG catch-up/failure có thể vượt budget, full13 chưa được cấp GO từ số đo idle. Không giảm kiến trúc13 để che giới hạn; triển khai từng checkpoint, đo lại rồi mới tiếp. Một Worker chết không làm giảm tổng chi phí của laptop ngay và có thể tạo catch-up/retry/CPU spike.

Giữ WSL hiện tại trong 4.0. Không kết luận bắt buộc tăng WSL RAM khi Windows chỉ có16Gi và còn Docker/IDE/Compose. Auth-only dự trù384Mi request/768Mi limit tổng cộng: có cơ sở để thử có kiểm soát sau khi CP ổn định và image mới được duyệt, chưa đủ cơ sở bảo đảm toàn bộ13 Pod.

Guard cho checkpoint sau: Windows available<1Gi hoặc WSL<1.5Gi kéo dài qua nhiều mẫu; OOMKilled mới, Node pressure, swap in/out lớn liên tục kèm PSI/latency xấu, lease loss/API timeouts mới ⇒ dừng tăng tải và báo. Không dừng chỉ vì swap used tăng vài MiB, không tự xóa cache/volume hoặc tắt môi trường cũ. C reserve15Gi là ngưỡng đĩa đề nghị bổ sung. Mỗi build/load/rollout/probe có timeout; không startup tất cả đồng thời.

## 10. Checkpoint order và acceptance criteria

| Checkpoint | Chỉ làm khi được duyệt | Acceptance để xin chuyển bước |
|---|---|---|
| **4.0** | Preflight/audit/draft/docs | Manifests render/schema/refs PASS; ghi rõ HOLD và gates; không build/apply |
| **4.1 Auth2** | Recheck CP + resource guard; rebuild Auth, unique tag/load; chỉ app Auth | Không restart/lease loss mới trong cửa sổ ổn định; 1Pod/Worker; probe Ready; ownDB/TLS/demo broker; demo JWT signing/verification; password/session flow và cạnh tranh refresh; không Google; fixture được duyệt; tài nguyên còn headroom |
| **4.2 Inventory2** | Reuse verified content alias/load; chỉ Inventory | Ready2, consumer pool15, inbox/outbox/expiry/daily-close concurrency và duplicate message không nhân đôi side effects |
| **4.3 Sales2** | Rebuild Sales runtime/load | Ready2, Inventory Service DNS, order/payment idempotency + recovery/settlement cạnh tranh, không nghiệp vụ thật |
| **4.4 Report1** | Rebuild Report runtime/load | Ready1 ưu tiênWorker1, pool15, projections/reports/demo DLQ, redelivery dedup |
| **4.5 Kong2** | Reuse candidate có điều kiện; parse DB-less/plugins, chốt rate/IP policy | Ready2; signature/iss/aud/expired/nbf/role/branch/identity-spoofing/route-boundary tests; public/protected parity; cả2replicas cùng config; per-Pod/global rate semantics được nghiệm thu; không Nest gateway |
| **4.6 Nginx2 + entry** | Rebuild2 React artifacts public demo args; dualSPA + entry được duyệt | nginx -t; mỗiPod phục vụ cả2SPA, deep links/assets/API/query đúng; browser cookies/CORS/CSRF/origin/TLS phù hợp; entry tiếp tục hoạt động khi mất Worker; không gọi Pod-bound forward là HA |
| **4.7 E2E/failover** | Kịch bản và phạm vi fault được duyệt riêng, không tự stop Worker ở4.0 | E2E demo accounts/orders/payment/report; Worker failure app availability, PG promotion/RW endpoint/reconnect; đo RTO/RPO async, duplicate/retry không nhân đôi nghiệp vụ; phục hồi replica và backlog; tài nguyên/Compose không bị ảnh hưởng |

Không checkpoint nào được tự động thông qua vì một checkpoint trước PASS. Nguyên trạng DB/PVC/broker/Compose là điều kiện bảo toàn xuyên suốt, không rollback bằng xóa dữ liệu hay chạy lại migrations.

## 11. Validation và giới hạn bằng chứng

`kubectl kustomize infra/k8s/overlays/demo/phase4` render thành14 resources: 6Deployments +6Services +2ConfigMaps. Client dry-run với schema validation PASS; **không apply**, không server dry-run ghi/admission. Logical validation kiểm tra số replicas, Service selectors, worker anti-affinity, probes, non-root, resources, demo DB/broker references, CA projection certificate-only, private JWT Auth-only, public-key match, Service DNS và không old Nest/Docker resolver. 61 kiểm tra logic PASS; kết quả trong `validation.json`.

Đối chiếu toàn bộ container cũ bằng ID/status/start time/restart/OOM/mounts không đổi; không còn container inspection. Tracked Git diff hash không đổi. Không sửa business code, Compose, .env, Phase3 manifests/report, original Secrets; không build/pull/load/deploy, migration, seed, stop/start Compose, delete image/volume/PVC, compact/WSL shutdown, git commit/push.

Client schema/static checks không thay thế Kong config parse, Nginx syntax/startup, app readiness, TLS/database reconnect hay HA fault tests. Các alias placeholder cố ý chưa triển khai; **preflight triển khai vẫn FAIL/HOLD**. Phải được người dùng duyệt checkpoint tiếp theo; không chuyển4.1 trong phiên này.

Tham khảo primary sources: [Kubernetes NodePort và external traffic](https://kubernetes.io/docs/concepts/services-networking/service/#type-nodeport), [Kong3.9.4 configuration source](https://github.com/Kong/kong/blob/3.9.4/kong.conf.default), [Kong3.9.4 status routes](https://github.com/Kong/kong/blob/3.9.4/kong/status/init.lua). Các kết luận image/runtime/repo bên trên dựa trên kiểm tra local, không từ tài liệu vendor.
