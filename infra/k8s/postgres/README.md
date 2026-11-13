# PostgreSQL demo — storage và giới hạn

Mỗi instance dùng PVC 5Gi riêng, StorageClass `jewelry-demo-local` (local-path, Retain, WaitForFirstConsumer, RWO). Không đổi StorageClass mặc định. Volume có node affinity, dữ liệu nằm trong filesystem kind node `/var/local-path-provisioner`; không mount volume Compose hay workspace/Windows. Provisioner tạo thư mục, CNPG thiết lập ownership/PGDATA; xác minh quyền sau bootstrap.

**5Gi là capacity khai báo; local-path không áp quota 5Gi thực tế.** Hai PVC không có nghĩa dành trước 10Gi trên C:. Docker/WSL VHDX tăng theo dữ liệu thật; `df` Linux nhìn thấy virtual disk lớn không thay phép đo C:. Giám sát C:, PGDATA và WAL; dừng trước khi C: dự phòng dưới 15GiB. Không compact/prune tự động.

Dữ liệu demo dự kiến <0,5Gi/instance, WAL bình thường ~0,1–0,6Gi/instance; catch-up, migration, logs và images thêm dung lượng. Đây là ước lượng cần đối chiếu số đo. `max_wal_size` chỉ là mục tiêu checkpoint, không hard limit. Giới hạn retained WAL của slot có thể làm standby phải rebootstrap nếu bị bỏ lại quá lâu.

Retain giảm rủi ro xóa nhầm PV khi PVC bị xóa, không phải backup. Không xóa PVC/Cluster để rollback. Local PV không chịu được mất laptop/ổ cứng/kind node filesystem, không là storage HA. Hard anti-affinity DB bảo đảm khác Worker; Pod replacement có thể Pending khi chỉ còn một Worker.

Bootstrap 1 instance chỉ là checkpoint tạm đã duyệt; mục tiêu cuối vẫn 2. Gỡ hostname selector tạm trước khi thêm standby, giữ worker label và anti-affinity. Vai trò primary không pin cố định vào Pod/node sau bootstrap.

Không mở cổng PostgreSQL ra host/LAN. CNPG `jewelry-pg-rw` là endpoint primary, ứng dụng phải reconnect/retry có idempotency sau failover. Chỉ async replication trong demo: RPO có thể >0, không cam kết zero downtime/data loss. Failover/fencing thực tế chưa được thử ở Giai đoạn 3.

## Trạng thái đã triển khai

Giai đoạn3 PASS: Primary jewelry-pg-1 Worker1, Standby jewelry-pg-2 Worker2, PVC5Gi riêng/Retain, async streaming/lag0 ở mẫu kiểm tra. cluster.yaml là trạng thái cuối2instances; cluster-bootstrap.yaml chỉ lưu checkpoint lịch sử1instance, không đưa vào overlay. CNPG tự thay Primary Pod một lần khi gỡ hostname selector; vai trò primary giữ nguyên. Không promote/failure test.

DatabaseRole/Database CRDs là authority của roles/ownership/schema. privileges.sql chỉ quản lý ACL/default grants, transaction riêng mỗiDB, revoke runtime quyền trên _prisma_migrations nếu đã tồn tại; đã kiểm tra reapply sau migrations. Runtime/migration roles chỉ CONNECT ownDB; postgres/template0/template1 không PUBLIC CONNECT. CNPG metrics/streaming_replica được grant CONNECT postgres rõ ràng. Không áp dụng SQL này vào Compose hoặc cluster khác.

Hai PVC thuộc node locality, không phải disk/storage HA. Lease/isolation-check đã kiểm tra cấu hình/holder, chưa chứng minh fencing dưới network partition hoặc worker crash. Không tự xóa PVC/Cluster hoặc scale xuống để rollback.
