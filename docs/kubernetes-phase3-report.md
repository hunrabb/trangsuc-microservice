# Giai đoạn 3 — PostgreSQL HA & dependencies: PASS

Ngày **13/11/2026**. Tiếp tục từ cluster/PVC/Primary đã tồn tại, không bootstrap lại.
Kubeconfig `/home/hung/.kube/jewelry-lab.config`, context `kind-jewelry-lab`.
**Checkpoint 3.3R–3.9 đều PASS. Không deploy NestJS hoặc Gateway, không chuyển Giai đoạn 4.**

Báo cáo PARTIAL trước và log từng checkpoint được giữ tại [session-history.md](evidence/kubernetes-phase3-resume/session-history.md). Quy tắc swap cũ đã được người dùng thay thế trong yêu cầu tiếp tục.

## 1. Tài nguyên và phạm vi thực tế

| Thành phần | Phiên bản | Namespace/vị trí | Trạng thái |
|---|---|---|---|
| kind / Kubernetes | 0.33.0 / 1.36.1 | jewelry-lab: 1 CP + 2 Worker | 3 Node Ready |
| CloudNativePG | 1.30.1 | cnpg-system / Control Plane | Ready, cùng Pod cũ, 0 restart |
| PostgreSQL Primary | 16.15 | jewelry-demo / Worker1 | jewelry-pg-1 Ready, recovery=false |
| PostgreSQL Standby | 16.15 | jewelry-demo / Worker2 | jewelry-pg-2 Ready, recovery=true |
| RabbitMQ demo | 4.4.0-management | Docker project jewelry-demo-deps, ngoài Worker | healthy, 1 broker |
| Migration Jobs | Prisma7.10.1 | jewelry-demo / Worker1 | 4 Completed, không retry |

Giữ nguyên kiến trúc đích **Auth2/Sales2/Inventory2/Report1/PostgreSQL2 = 9 Pods**. Gateway, operator, broker, system và Jobs ngoài9. Hiện chưa có business Deployments/Services; có **16 Running/Ready Pods** (13 system + operator +2DB) và **4 Completed migration Pods**. Broker là Docker container, không tính thành Kubernetes Pod. Các Pod/ConfigMap/queue thử đã dọn.

Operator image giữ digest `sha256:923c267ec29636db3bee20f993d0ec4973fa22998e1adad37da79e4d32b5bc07`; PG image `ghcr.io/cloudnative-pg/postgresql:16.15-system-trixie@sha256:1546be7d23066aaf9eb75b07df17c843c98483cede7afdbaf01dca785fb3bf60`. Không cài lại operator hoặc sửa taint CP.

## 2. Primary/Standby, storage và replication

| Pod | Node | PVC / PV |
|---|---|---|
| jewelry-pg-1, Primary | jewelry-lab-worker | jewelry-pg-1 / pvc-cd2c8353-2082-43ef-bb19-d285d5f3c3d2 |
| jewelry-pg-2, Standby | jewelry-lab-worker2 | jewelry-pg-2 / pvc-dced64e8-81cc-4eff-829e-2a4980211f01 |

Hai PVC **5Gi/RWO/Bound**, StorageClass `jewelry-demo-local`, Retain/WaitForFirstConsumer. PV có node affinity tương ứng, không shared PGDATA hoặc mount volume Compose/workspace/Windows. PGDATA UID/GID26:26 mode0700 trên cả hai instance. Local-path không áp quota5Gi cứng, không reserve trước10Gi trên ổC; virtual `df` không thay sốC: free.

Đã gỡ hostname selector bootstrap, giữ worker label và required anti-affinity. **CNPG tự thay Primary Pod một lần để áp cấu hình affinity** sau khi có Standby; vai trò Primary vẫn Worker1. Pod mới có restartCount0, không diễn giải con số đó thành chưa từng có Pod replacement. Không delete/promote/restart thủ công để thử failover.

Base backup chờ checkpoint với checkpoint_timeout5min/completion_target0.9; thấy `CheckpointWriteDelay`/`waiting for checkpoint to finish`, rồi tự hoàn thành trong timeout. Không ép CHECKPOINT/benchmark.

SQL xác nhận `streaming/async`; ba mẫu sau probe và mẫu cuối đều **lag0byte**, slot `_cnpg_jewelry_pg_2` active. Time-lag có thể NULL lúc idle, không coi NULL là đo được0ms. Dữ liệu thử ghi bằng runtime role trong từng schema do migrator sở hữu xuất hiện trên Standby ở cả4DB; đã drop đúng bốn bảng probe và xác minh cleanup trên Standby. Migration histories4/13/15/7 cũng đã catch-up.

Endpoint **jewelry-pg-rw.jewelry-demo.svc.cluster.local:5432** (ClusterIP10.96.246.205) trỏ Primary IP10.244.1.6 tại phép đo; client phải dùng DNS Service, không pin PodIP/name. Không hostPort/NodePort/LAN exposure.

Lease `jewelry-pg`: holder jewelry-pg-1, duration15s; isolation liveness check enabled, failoverDelay10s, synchronous_standby_names rỗng/minSync=maxSync0. Theo [CNPG1.30 failover](https://cloudnative-pg.io/docs/1.30/failover/), Lease/election và isolation là các cơ chế an toàn cần kiểm chứng trong tình huống lỗi; **chưa thử worker failure, promote, fencing dưới partition hoặc app reconnect**. Không khẳng định RPO0/zero downtime. Async có thể mất phần WAL chưa replicate khi failover.

WAL cuối SQL144MiB trên Primary; filesystem PGDATA khoảng201,4MiB Primary/137,4MiB Standby (bao gồm WAL). WAL riêng144/80MiB ở mẫu filesystem, không cộng trùng với PGDATA. Các giá trị có thể đổi theo checkpoint/retention. Slot retained limit512MB có thể khiến replica cần rebootstrap nếu tụt quá lâu. Chưa có backup/PITR hoặc storage HA; cùng laptop/ổC vẫn SPOF. Hard anti-affinity có thể để replacement Pending nếu chỉ còn một Worker.

## 3. Bốn database/schema, ownership và isolation

| Database | Schema | Migration owner | Runtime role | Migrations | Tables, gồm history |
|---|---|---|---|---:|---:|
| auth_db | auth | auth_migrator | auth_user | 4 | 10 |
| inventory_db | inventory | inventory_migrator | inventory_user | 13 | 24 |
| sales_db | sales | sales_migrator | sales_user | 15 | 29 |
| report_db | report | report_migrator | report_user | 7 | 12 |

Giữ nguyên auth_db/auth_migrator/password bootstrap. 4 Database và8 DatabaseRole CRDs đều `status.applied=true`; schema owners tương ứng migrator. Kiểm tra [CRD đang cài](https://cloudnative-pg.io/docs/1.30/declarative_database_management/) trước khi áp dụng; [DatabaseRole](https://cloudnative-pg.io/docs/1.30/declarative_role_management/) quản lý properties/password, Database quản lý DB/schema ownership. privileges.sql quản lý ACL/default privileges, transaction riêng mỗi DB; không SQL đổi ownership cạnh tranh CRDs.

Runtime: CONNECT ownDB, USAGE ownSchema, SELECT/INSERT/UPDATE/DELETE tables và USAGE/SELECT/UPDATE sequences; không schema CREATE/DB CREATE/role CREATE/superuser. Runtime không được sửa `_prisma_migrations`; conditional revoke trong ACL script làm reapply vẫn giữ chính sách, đã kiểm chứng sau migrations. Migrator sở hữu DB/schema, non-superuser/no CREATEDB/CREATEROLE; connectionLimit2. Runtime limits Auth16/Inventory35/Sales35/Report20.

PUBLIC CONNECT bị revoke trên4 app DB và postgres/template0/template1; chỉ grant ownDB cho từng service, giữ CNPG streaming_replica/metrics CONNECT postgres rõ ràng. 8 roles đăng nhập ownDB được; 24 kiểm tra CONNECT chéo giữa app DB false, thêm system DB checks false. Pod Node dùng **driver pg thực tế, credentials runtime/TLS verify-full** đọc schema riêng thành công và24 lần kết nối sang app/system DB khác bị từ chối (template0 vốn không nhận kết nối cũng bị revoke CONNECT). Không dùng business fixture thật hoặc old credentials.

## 4. Connection budget và RAM PostgreSQL

Auth không có consumer nên chọn pool5; Inventory/Sales/Report tối thiểu15 (prefetch10+reserve5). Report DLQ observer prefetch1 và outbox/recovery workers dùng cùng PrismaService/pool, không cộng nguyên pool mới mỗi worker. Các CLI/backfill nằm ngoài app phải budget riêng nếu chạy.

| Service | Replicas đích | Pool/Pod | Trần |
|---|---:|---:|---:|
| Auth | 2 | 5 | 10 |
| Inventory | 2 | 15 | 30 |
| Sales | 2 | 15 | 30 |
| Report | 1 | 15 | 15 |
| Tổng | 7 | | **85** |

Nếu đồng loạt15=>105, đồng loạt20=>140; không dùng cấu hình140 với max_connections128. **Không tăng max_connections**: 85 app + migration tuần tự2 + admin/operator/monitoring10 + reserved3 =100/128, dư28. WAL senders có trần10 riêng, hiện1 sender, vẫn dùng process/RAM. Thời điểm cuối không có app/migration client connections mở, chỉ truy vấn admin kiểm tra và background processes/sender.

PG requests384Mi/200m, limits768Mi/1000m; shared_buffers128MB, work_mem2MB, maintenance32MB. CRI working set cuối khoảng121,1Mi Primary/117,6Mi Standby; operator29,9Mi. Một query có thể dùng nhiều work_mem operations, không lấy85×2MB làm trần RAM toàn PG. Chưa stress/load test, không bảo đảm85 truy vấn nặng cùng lúc. Profile Giai đoạn4 maxSurge0/maxUnavailable1, migrations tuần tự; resource-profiles chỉ ConfigMap planning, chưa business Deployments.

## 5. RabbitMQ demo và networking

Project **jewelry-demo-deps**, container **jewelry-demo-rabbitmq**, volume **jewelry-demo-rabbitmq-data**, Docker kind IP172.19.0.5; image official pinned digest `sha256:af6f50d38098d8bd52fef7f3fa85015dd8b2bf6def58e995bf584ae9ba0f6407`. Ngoài hai Worker, không host ports; CPU0.75/RAM768Mi, watermark384Mi, log rotation5Mi×2. Không thay/dừng broker hoặc volume cũ.

Vhost jewelry-demo, demo app/admin users mới, durable topology được map từ source vào vhost mới. App configure `^$` (không tự provision topology). [Definitions import](https://www.rabbitmq.com/docs/definitions) có salted hashes chỉ ở `/home/hung/.local/share/jewelry-demo/broker-definitions.json`, parent0700/file0444 để RabbitUID đọc; không password/hash vào Git. Plain passwords nằm trong demo Secrets.

Pod UID1000/resource-limited tái sử dụng Node/amqplib trong gateway image, **không chạy NestJS/gateway entrypoint**: DNS/ClusterIP rabbitmq.jewelry-demo.svc.cluster.local:5672, TCP/AMQP authentication, publisher confirm, consume đúng test message đều PASS. Queue phase3.probe.connectivity, Pod và ConfigMap probe đã xóa; không event business/old queue được consume.

Đã sửa probe resolve pnpm realpath và dùng durable classic queue vì RabbitMQ4.4 chặn transient non-exclusive queues; không bật deprecated feature. Broker vẫn1instance/SPOF, không RabbitMQ HA. EndpointSlice selectorless phải cập nhật nếu recreate Docker broker đổi IP; không tự discovery vĩnh viễn. Worker/broker failure chưa thử.

## 6. Secrets/ConfigMaps cho Giai đoạn4

- 8 DB Secrets migration/runtime riêng, 2 RabbitMQ Secrets app/admin, 2 JWT Secrets; không in password/rawURL/private key hoặc commit secret values. Không sửa .env/keys cũ.
- Runtime DATABASE_URL: ownDB/schema, host-rw, pg sslrootcert/verify-full; migration URL: ownDB/schema, Prisma sslcert/require/strict, connection_limit2, connect_timeout5, pool_timeout10. Đã chạy thực tế cả hai đường TLS.
- JWT RSA2048 mới: auth-jwt-signing chỉ private, jwt-verification chỉ public. Auth-specific config probe UID1000/fsGroup1000/mode0440 đọc private và sign/verify PASS, private không mount service khác. Probe đã cleanup.
- PostgreSQL CA chỉ project item ca.crt từ jewelry-pg-ca, không mount ca.key. OpenSSL verify CA+hostname và Nodepg thực tế PASS.
- ConfigMaps jewelry-common, auth/inventory/sales/report-config và jewelry-resource-profiles trong jewelry-demo. Upstream URLs tương ứng tên Service cho giai đoạn4, chưa tạo business Services/Pods.
- GOOGLE_CLIENT_ID hiện placeholder vô hiệu; cần ClientID demo hợp lệ trước Google login end-to-end. Không tự copy ClientID/key từ môi trường cũ. Auth health/khởi động có cấu hình nonempty; login/refresh/fixture thuộc giai đoạn ứng dụng, chưa kiểm chứng tại đây.

## 7. Migration Jobs — PASS

4 image đã khớp toàn bộ8/17/19/11 relevant files (schema, SQL/migration_lock, Prisma config, wait script) và Prisma7.10.1. Không build image. Tạo alias theo Docker content ID, load vào Worker1, imagePullPolicy Never; IDs/aliases/history ở [migration-images.lock.json](../infra/k8s/jobs/migration-images.lock.json).

Auth → Inventory → Sales → Report, mỗi Job activeDeadline180s/backoffLimit0/UID1000, request128Mi/100m, limit384Mi/750m; chỉ own migrator Secret và CA public, không RabbitMQ/oldDB. Trước chạy schema demo không có application tables/history; đã review các ALTER DROP CONSTRAINT thay thế/DROP NOT NULL trong migrations trên DB mới trống, không DROP DATABASE/TABLE/COLUMN/TRUNCATE/reset.

**39 migration histories** finished_at đầy đủ, checksum đúng SQL source, không rollback/duplicate; tables/PK/FK/check/unique/constraint triggers được kiểm tra read-only. Standby có đủ history4/13/15/7. Không migrate reset/db push/seed dữ liệu thật. Job Completed giữ review, không đặt trong overlay reconcile hoặc application startup; apply lại Job Complete không tự rerun.

## 8. Tài nguyên trước/sau từng checkpoint

Đơn vị RAM/swap MiB, disk GiB; CPU Windows là mẫu tức thời, không trung bình. WSL/Windows available là hai góc nhìn cùng laptop, **không cộng chúng**. Ba kind nodes mỗi node báo RAM WSL nhưng không tạo thêm RAM vật lý để cộng allocatable thành24GiB.

| Checkpoint | Trạng thái | WSL available MiB | Windows available MiB | Swap MiB | Windows CPU % | C: free GiB |
|---|---|---:|---:|---:|---:|---:|
| 3.3R | PASS | 3520.7 | 3544 | 20.86 | 19 | 36.82 |
| 3.4 | PASS | 3502.7 | 3378 | 23.43 | 71 | 36.82 |
| 3.5 | PASS | 3468.1 | 3168 | 32.91 | 95 | 35.60 |
| 3.6 | PASS | 3425.8 | 3171 | 32.91 | 35 | 35.60 |
| 3.7 | PASS | 3426.2 | 2737 | 97.16 | 63 | 35.20 |
| 3.8 | PASS | 3318.6 | 2796 | 96.98 | 47 | 35.20 |
| 3.9-auth | PASS | 3405.6 | 2810 | 134.68 | 37 | 35.23 |
| 3.9-inventory | PASS | 3351.6 | 2649 | 152.70 | 22 | 34.86 |
| 3.9-sales | PASS | 3390.9 | 2629 | 177.72 | 44 | 34.36 |
| 3.9-report | PASS | 3413.0 | 2641 | 190.06 | 23 | 33.89 |
| FINAL-AFTER-CLEANUP | PASS | 3450.6 | 2521 | 184.51 | 72 | 33.91 |

Mẫu trước quan sát: Windows3223MiB, WSL3584.0MiB, swap19.91MiB, C:36.82GiB. Mỗi hàng trước là baseline cho checkpoint sau, và đã ghi sau từng Job.

Checkpoint3.3R: **16 mẫu/309giây**, không stress. Toàn phiên có80 mẫu monitor, minWindows2521MiB/minWSL3208.7MiB; peak swap IO khoảng959.84KiB/s theo khoảng lấy mẫu, peak full memory PSI avg10=1.73%. Swap có tăng khi import images/migrations, không coi là “đứng yên”; chưa có swapping đáng kể kéo dài kèm memory stalls/OOM/pressure. Mẫu cuối swap giảm về184.51MiB, fullPSIavg10=0,19%. Không kích hoạt safety stop mới.

CPU Windows median khoảng67.0% trong monitor, có đợt100% khi xử lý images/Jobs, không restart/NotReady kéo dài của control plane. Linux vmstat cuối bốn khoảng2giây: us+sy63/42/19/31%, si/so gần0; load cuối3.92/4.19/4.81, không phải phần trăm CPU. Không suy capacity cho tải lớn từ mẫu CPU ngắn.

**Mẫu sau cleanup lúc 2026-11-13T04:45:32.827831+00:00: Windows 2.46GiB, WSL 3.37GiB available; C: 33.91GiB.** ỔC giảm chủ yếu trong thời gian thêm image/PVC/broker; không quy mọi biến động cho Kubernetes vì Windows/background cùng sử dụng ổ đĩa. Không compact/prune/dọn images để đẹp số.

## 9. Bảo vệ môi trường cũ và giới hạn

Metadata ID/status/start/restart/OOM/mount của mọi Docker container ban đầu đối chiếu nguyên vẹn; Git tracked diff checksum trước/cuối giữ nguyên. Không dừng/restart Compose, không chạm volume/DB/broker cũ, không sửa business code/schema/migrations/.env/.wslconfig, không commit/push. Đây là metadata check, không checksum nội dung DB cũ; không chạy SQL ghi vào DB cũ.

Scheduler/controller-manager vẫn2restart lịch sử, không tăng trong phiên; operator0; PG Pod hiện tại0, có một replacement có chủ đích bởi CNPG như mục2. Không OOMKilled/kernelOOM, Node MemoryPressure/DiskPressure hoặc recurring PG restart. Test resources được dọn; Cluster/PVC/healthy infra và Completed Jobs giữ nguyên.

Giới hạn còn lại: laptop/Control Plane/local disk SPOF, RabbitMQ1instance, async RPO>0, chưa backup/PITR/failure/reconnect test, external brokerIP cần reconcile nếu recreate, chưa tải ứng dụng thật, GoogleClientID placeholder. Giai đoạn3 PASS không đồng nghĩa production-ready hoặc failover đã chứng minh.

**Đủ headroom để bắt đầu Giai đoạn4 với Auth2 triển khai tuần tự và giám sát**, sau khi kiểm tra runtime image/config/fixture theo phạm vi giai đoạn đó. Chưa bảo đảm chạy đồng loạt toàn bộ9Pod/Gateway hoặc startup/worker-failure peak. Phiên này dừng đúng hạ tầng Giai đoạn3.

## 10. File mới/cập nhật

- `infra/k8s/postgres/README.md` — cập nhật
- `infra/k8s/postgres/cluster-bootstrap.yaml` — đã có trước, giữ nguyên
- `infra/k8s/postgres/cluster.yaml` — mới
- `infra/k8s/postgres/databases.yaml` — mới
- `infra/k8s/postgres/kustomization.yaml` — mới
- `infra/k8s/postgres/privileges.sql` — mới
- `infra/k8s/postgres/roles.yaml` — mới
- `infra/k8s/postgres/storageclass.yaml` — đã có trước, giữ nguyên
- `infra/k8s/rabbitmq/README.md` — mới
- `infra/k8s/rabbitmq/compose.yaml` — mới
- `infra/k8s/rabbitmq/kustomization.yaml` — mới
- `infra/k8s/rabbitmq/probe.cjs` — mới
- `infra/k8s/rabbitmq/rabbitmq.conf` — mới
- `infra/k8s/rabbitmq/service.yaml` — mới
- `infra/k8s/rabbitmq/topology.json` — mới
- `infra/k8s/config/README.md` — mới
- `infra/k8s/config/auth-config-probe.yaml` — mới
- `infra/k8s/config/configmaps.yaml` — mới
- `infra/k8s/config/kustomization.yaml` — mới
- `infra/k8s/config/resource-profiles.yaml` — mới
- `infra/k8s/config/runtime-db-probe.yaml` — mới, probe đã PASS và cleanup, không trong overlay
- `infra/k8s/jobs/README.md` — mới
- `infra/k8s/jobs/auth-migration.yaml` — mới
- `infra/k8s/jobs/inventory-migration.yaml` — mới
- `infra/k8s/jobs/migration-images.lock.json` — mới
- `infra/k8s/jobs/report-migration.yaml` — mới
- `infra/k8s/jobs/sales-migration.yaml` — mới
- `infra/k8s/overlays/demo/README.md` — mới
- `infra/k8s/overlays/demo/kustomization.yaml` — mới
- `docs/kubernetes-phase3-report.md` — cập nhật thành báo cáo PASS này.
- `docs/kubernetes-architecture-plan.md` — cập nhật trạng thái thực tế, không đổi replica baseline.

Bằng chứng mới (không Secrets):

- `docs/evidence/kubernetes-phase3-resume/acceptance.json`
- `docs/evidence/kubernetes-phase3-resume/amqp-probe.log`
- `docs/evidence/kubernetes-phase3-resume/auth-config-probe.log`
- `docs/evidence/kubernetes-phase3-resume/auth-migration.log`
- `docs/evidence/kubernetes-phase3-resume/inventory-migration.log`
- `docs/evidence/kubernetes-phase3-resume/leases.json`
- `docs/evidence/kubernetes-phase3-resume/migration-image-verification.json`
- `docs/evidence/kubernetes-phase3-resume/pods.json`
- `docs/evidence/kubernetes-phase3-resume/postgres-metrics.txt`
- `docs/evidence/kubernetes-phase3-resume/replication.json`
- `docs/evidence/kubernetes-phase3-resume/report-migration.log`
- `docs/evidence/kubernetes-phase3-resume/resource-samples.json`
- `docs/evidence/kubernetes-phase3-resume/resource-summary.json`
- `docs/evidence/kubernetes-phase3-resume/runtime-db-probe.log`
- `docs/evidence/kubernetes-phase3-resume/sales-migration.log`
- `docs/evidence/kubernetes-phase3-resume/session-history.md`
- `docs/evidence/kubernetes-phase3-resume/storage.json`
- `docs/evidence/kubernetes-phase3-resume/vmstat-final.txt`
- `docs/evidence/kubernetes-phase3-resume/workload-resources.json`

CNPG manifests/patch tại infra/k8s/cnpg và kind config trước đó giữ nguyên. SQL ACL và các YAML đã parse/validate; overlay render có22 resources, không Secret/Deployment/Pod/Job. Static manifests chỉ tham chiếu Secret đã provision; không apply recursive cả infra/k8s vì chứa bootstrap/test/Jobs. Chi tiết reconcile và giới hạn ở READMEs từng thư mục.

Ngoài repo: `/tmp/jewelry-phase3-resume/` chứa helper/monitor/checkpoint scripts và raw metadata/logs của phiên; không dùng làm backup. File definitions chứa hashes tại `/home/hung/.local/share/jewelry-demo/broker-definitions.json` được giữ ngoài Git như mục5. Không tạo file chứa private JWT/password plaintext ngoài Kubernetes Secrets.
