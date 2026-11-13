# Checkpoint 4.0R — điều tra restart Control Plane

**Kết luận: HOLD. Chưa đủ điều kiện build/load hoặc triển khai Auth2.**

Ngày 13/11/2026, cluster `jewelry-lab`, Kubernetes v1.36.1; kubeconfig `/home/hung/.kube/jewelry-lab.config`. Chỉ chẩn đoán đọc thông tin và tạo báo cáo/bằng chứng; không thay đổi cấu hình hay tài nguyên chạy.

Đã phát hiện đợt restart mới **trước mẫu đầu 4.0R**: khoảng **05:55 UTC / 12:55 UTC+7**, controller-manager/scheduler tăng từ3 lên4, CNPG operator từ1 lên2 so với cuối4.0. Vì có lỗi tái diễn, không chạy tiếp cửa sổ theo dõi kéo dài để xin PASS; chỉ thu thập bằng chứng có timeout và mẫu cuối. Windows có bằng chứng sleep/resume sát đợt này; đợt05:21 còn có WAL fdatasync15.47s chưa giải thích hoàn toàn. Không đánh dấu PASS từ trạng thái Running/Ready sau hồi phục.

Tham chiếu giữ nguyên: [kế hoạch4.0](kubernetes-phase4-plan.md), [bằng chứng4.0](evidence/kubernetes-phase4-0/cluster-audit.json), [báo cáo3](kubernetes-phase3-report.md). Bằng chứng mới: [summary.json](evidence/kubernetes-phase4-0r/summary.json).

## 1. Timeline và restart count

Tất cả timestamp dưới đây là **UTC, ngày13/11/2026**; cộng7giờ để ra giờ Việt Nam/Thái Lan. Cột exit là thời điểm process cũ kết thúc, không lấy thời điểm event được ghi lại làm thời điểm lỗi bắt đầu.

| Thành phần | Count sau lần restart | Process cũ kết thúc UTC | Process mới / nguồn thời gian | Exit code / reason |
|---|---:|---|---|---|
| Controller-manager | 0→1 | 03:09:22.056 | 03:09:42.367: StartContainer thành công trong journal | 1; Kubernetes reason cũ không còn |
| Scheduler | 0→1 | 03:09:22.070 | 03:09:41.768: StartContainer thành công trong journal | 1; Kubernetes reason cũ không còn |
| Controller-manager | 1→2 | 03:13:46.701 | 03:14:16.695: StartContainer thành công trong journal | 1; Kubernetes reason cũ không còn |
| Scheduler | 1→2 | 03:13:52.790 | 03:14:16.828: StartContainer thành công trong journal | 1; Kubernetes reason cũ không còn |
| Controller-manager | 2→3 | 05:21:36 | startedAt05:21:48 | 1 / Error |
| Scheduler | 2→3 | 05:21:41 | startedAt05:21:48 | 1 / Error |
| CNPG operator | 0→1 | 05:21:46 | startedAt05:21:48 | 1 / Error |
| Controller-manager | 3→4 | 05:55:33 | startedAt05:55:43 | 1 / Error |
| CNPG operator | 1→2 | 05:55:35 | startedAt05:55:43 | 1 / Error |
| Scheduler | 3→4 | 05:55:37 | startedAt05:55:47 | 1 / Error |

Hai đợt đầu phục dựng bằng containerd journal: nối tên/attempt/container ID với `received container exit event` và `StartContainer ... returns successfully`. Timestamp StartContainer thành công là mốc log, **không khẳng định bằng actual startedAt**. Exit code lấy từ exit event. Logs process cũ của hai đợt đầu đã không còn trong `--previous` hoặc thư mục log container hiện còn, nên không gán chắc chắn termination reason/leader-election message cho chúng. [historical-lifecycle.json](evidence/kubernetes-phase4-0r/historical-lifecycle.json) giữ ID và nguồn dữ liệu.

Đợt05:21 dùng snapshot `lastState` và previous logs đã lưu trong4.0. Đợt05:55 dùng `lastState`, current/previous logs mới và Events. Kubernetes chỉ giữ một `lastState`/previous container gần nhất; không suy diễn bốn lần đều có nguyên nhân giống hệt nhau.

API Server, etcd, hai CoreDNS và hai PostgreSQL vẫn restartCount0. CNPG operator chỉ được tạo khoảng03:51 nên không có mặt trong hai đợt đầu. Các kind node Docker containers đều startedAt **2026-11-12 19:38:44 UTC**, restartCount0, OOM=false; không có dấu hiệu Docker container node bị tạo/start lại tại các đợt trên. Docker events trong khoảng05:15–05:59 không trả die/start/restart/OOM; đây là kết quả từ lịch sử còn được daemon giữ, không phải bảo đảm lịch sử vô hạn.

## 2. Đối chiếu Windows, etcd, API và kubelet

### 03:08–03:14 UTC — sau Windows resume, có hai lần restart

- Windows Power-Troubleshooter Event1: sleep **12/11 23:05:50.382** → wake **13/11 03:08:38.008**, low-power state có dữ liệu hibernation. Kernel-General Event1 đồng bộ lại clock theo hardware clock.
- 03:08:43 Windows chuyển sang pin (`AcOnline=false`).
- 03:09:20 etcd WAL `slow fdatasync` **7.895s**; API Server có Handler timeout, kubelet có lease update timeout/http2 connection lost.
- 03:09:22 hai process control-plane exit1.
- 03:12:51 WAL fdatasync4.596s;03:13:36 thêm3.801s và nhiều spike>1s. Controller/scheduler exit03:13:46/52, hồi phục khoảng03:14:16.

Có tương quan rõ với host resume và độ trễ etcd. Không có CPU/physical-disk time series đúng những giây này để tách tác động resume, CPU contention và storage contention. Không khẳng định chỉ sleep gây ra toàn bộ đợt03:13.

### 05:21 UTC — độ trễ etcd/API xảy ra đồng thời mất lease

- 05:21:03.095 Windows Event105: nguồn AC chuyển sang pin (`AcOnline=false`). Không thấy một sleep/wake event tương ứng ngay05:21 trong truy vấn System logs đã thực hiện.
- etcd ghi fdatasync **15.470s** lúc05:21:22.509; thêm3.218s,2.179s và7.575s trong cùng đợt. ReadIndex chậm, lease revoke timeout và apply request chậm.
- API Server tự ghi gRPC DeadlineExceeded tới **127.0.0.1:2379**, Handler/request timeout trên các Lease của scheduler/controller/operator/PG và node. Điều này xác nhận API không hoàn tất yêu cầu đúng hạn, không chỉ là một client báo lỗi.
- Scheduler/controller/operator báo Failed to renew Lease và leader election lost; exit1. Kubelet cả ba node cũng gặp lỗi update lease/status; CoreDNS/PG/API/etcd/operator có probe timeout cùng khoảng.

Chuỗi bằng chứng mạnh: **độ trễ trên đường xử lý etcd/WAL → API trễ → clients hết hạn renew lease → process exit/restart**. Tác nhân nền của độ trễ WAL (I/O thật, CPU descheduling, power-state/virtualization) vẫn chưa được tách. Đổi sang pin là tương quan thời gian, **không phải bằng chứng rằng rút sạc trực tiếp gây lỗi**.

### 05:52–05:56 UTC — sleep/resume sát đợt tái diễn mới

- Windows Power-Troubleshooter Event1 ghi SleepTime **05:52:44.8443374**, WakeTime **05:55:06.9854599**: khoảng142.14giây.
- Kernel-Power Event42 ghi entering sleep, reason **System Idle**; Event107/131 ghi resume/S3. Wake source được ghi là **ACPI Lid**. Không suy diễn người dùng đã đóng nắp để gây sleep; đây là nguồn wake do Windows báo.
- Kernel-General Event1 ghi clock từ05:52:51.243 sang05:55:02.500. Vì clock được sửa sau resume, không xếp Event107 với timestamp cũ trước Event42 rồi kết luận Windows đã wake trước khi sleep. Dùng SleepTime/WakeTime trong payload để đối chiếu.
- etcd logs có khoảng trống qua resume, sau đó WAL fdatasync **4.089s** và **3.539s** lúc05:55:27/31; API Handler timeout/etcd RPC cancellation, lease renew failure cùng đợt.
- Controller exit05:55:33, operator05:55:35, scheduler05:55:37. Worker kubelet lease/status lỗi05:55:34; operator/controller/scheduler được khởi động lại05:55:43–47; lấy lại leader lease05:55:49–05:56:06.

**Độ tin cậy cao:** host đã thực sự sleep/resume và là tác nhân đóng góp rất mạnh cho đợt gián đoạn mới. Không có bằng chứng Docker daemon/kind node restart; VM/process bị tạm ngừng vẫn có thể giữ nguyên PID/start time/container ID. Chưa xác định phần trễ sau wake thuộc physical disk, virtual disk hay CPU contention.

Bằng chứng chính: [Windows power events](evidence/kubernetes-phase4-0r/windows-power-events.json), [WAL slow-fdatasync](evidence/kubernetes-phase4-0r/etcd-slow-fdatasync.json), [etcd selected](evidence/kubernetes-phase4-0r/etcd-selected.json), [control-plane excerpts](evidence/kubernetes-phase4-0r/control-plane-excerpts.txt), [Warning Events](evidence/kubernetes-phase4-0r/warning-events.json).

## 3. Nguyên nhân, mức tin cậy và điều chưa chứng minh

| Nhận định | Mức tin cậy | Bằng chứng / giới hạn |
|---|---|---|
| API thực sự trễ trong các đợt lỗi | Cao | API Handler timeout, RPC localhost etcd timeout, probe API500/TLS timeout, nhiều loại client gặp lỗi đồng thời |
| Độ trễ etcd/WAL nằm trong chuỗi lỗi | Cao | fdatasync1–15.47s, ReadIndex/apply chậm đúng thời điểm renew lease thất bại |
| Host sleep/resume liên quan đợt05:55 | Cao | Windows power/clock events + khoảng gián đoạn + cụm lỗi sau resume |
| Hibernation/resume góp phần đợt03:09 | Khá cao | Wake03:08:38, lỗi03:09; không có telemetry đầy đủ để định lượng tác động |
| Physical disk chậm/hỏng là nguyên nhân duy nhất | Chưa đủ | fdatasync elapsed gồm cả scheduling/VM pause; không có physical-disk latency tại đỉnh lỗi, không thấy disk error được trả về trong truy vấn provider đã chọn |
| CPU starvation hoặc power throttling | Có thể, chưa chứng minh lịch sử | Chỉ2core vật lý, chạy nhiều môi trường; pin chuyển trạng thái sát05:21; chưa có CPU/frequency time series đúng lúc lỗi |
| CFS CPU quota gây đói control-plane | Không có bằng chứng | Pod CP cpu.max=max, nr_throttled=0; vẫn có thể bị cạnh tranh CPU host/ancestor/hardware |
| Memory pressure/OOM là nguyên nhân | Không có bằng chứng hiện có | Kernel oom_kill0, Node pressureFalse, exit1/Error không OOMKilled; không có RAM/PSI lịch sử đủ chi tiết cho mọi đợt |
| Network/CNI độc lập là nguyên nhân chính | Ít được hỗ trợ | Lỗi cả Service IP, node IP và localhost etcd; etcd WAL có delay rõ; chưa có packet/drop capture lịch sử để loại trừ transient network hoàn toàn |
| Bug riêng của CNPG/operator/app | Ít được hỗ trợ | Nhiều controller và kubelet cùng mất lease; hai đợt đầu chưa có CNPG; previous operator xác nhận leader election lost, không thấy panic/OOM riêng |

`connection refused` trong Events chủ yếu ở **probe endpoint operator9443/controller10257/scheduler10259 khi process đã exit/đang khởi động lại**. Không coi các dòng này là bằng chứng API6443 từ chối kết nối gây ra lỗi ban đầu. API có timeout/HTTP500/TLS timeout riêng; etcd hiện vẫn cùng process.

Tài liệu etcd xác nhận disk latency và CPU starvation đều có thể gây apply/heartbeat delay; phải đo để phân biệt, không suy nguyên nhân phần cứng từ một warning. [etcd FAQ3.6](https://etcd.io/docs/v3.6/faq/#what-does-the-etcd-warning-apply-entries-took-too-long-mean), [etcd tuning: disk](https://etcd.io/docs/v3.6/tuning/#disk). Không áp bất kỳ tuning/timeouts/ionice/CPU governor nào trong phiên.

## 4. Trạng thái sau hồi phục và cửa sổ quan sát

Mẫu đầu khoảng **05:59 UTC**, mẫu cuối **06:06:59 UTC**. Đây là cửa sổ thu thập chẩn đoán khoảng8phút, không stress/build/load. Không có restart tăng thêm hoặc Warning Event mới sau05:59 trong những mẫu đã lấy. Không polling liên tục; không bảo đảm không có latency spike giữa mẫu.

29phút ổn định của4.0 kết thúc05:51:42 vẫn có giá trị lịch sử nhưng bị ngắt bởi sleep/restart05:55. **Không cộng hai cửa sổ thành một khoảng liên tục ổn định**. Phát hiện tái diễn tại mẫu đầu là lý do dừng cửa sổ theo dõi mở rộng và giữ HOLD.

| Kiểm tra | Kết quả |
|---|---|
| Nodes | 3/3 Ready, Memory/Disk/PIDPressureFalse |
| System / dependencies Pods | 16 Running/Ready, 4 migration Pod Succeeded; CNPG1.30.1 và PostgreSQL16.15 giữ nguyên |
| Node Ready transitions | CP19:39:53,Worker119:39:57,Worker219:39:57 ngày12/11; không transition mới được lưu ở trạng thái hiện tại |
| API readyz/livez verbose | Tất cả checks PASS, gồm etcd/etcd-readiness; GET có request timeout8s |
| etcd endpoint health | healthy, linearizable health request14.076ms tại mẫu |
| etcd endpoint status | v3.6.8, single member là leader, raftTerm2, raftIndex=appliedIndex32473; DB5,619,712byte/quota2GiB, không lỗi status |
| Leader leases | Scheduler/controller/operator vàPG có holder; renew age khoảng0.64–1.52s tại mẫu cuối, leaseDuration15s |
| PG | 2/2 Ready, primary jewelry-pg-1, standby jewelry-pg-2, restart0 |
| Replication/RW | streaming/async, lag0byte tại mẫu; RW EndpointSlice Ready trỏ jewelry-pg-1 |
| RabbitMQ demo | running/healthy, restart0, OOM=false |

Raft term/leader của etcd khác Kubernetes leader-election Leases: không gọi việc scheduler/operator mất Lease là etcd đã đổi Raft leader. Node Ready không đổi không chứng minh host chưa ngủ; khi cả control plane cùng dừng, việc phát hiện/ghi transition cũng có thể bị gián đoạn. Không có failover/promotion test, không bảo đảm async RPO0.

## 5. Tài nguyên thực đo

Windows sample **06:01:12 UTC**; Linux sample **06:01:37 UTC**. CPU/disk là mẫu ngắn, không phải lịch sử lúc lỗi.

| Chỉ số | Giá trị |
|---|---|
| CPU vật lý | Intel i5-7200U2.50GHz, **2cores/4threads** |
| Windows RAM | Total16283MiB; available3795MiB =3.71GiB |
| Windows CPU | 76% tại mẫu CIM |
| WSL RAM | Total7892.54MiB; available3492.90MiB =3.41GiB |
| Linux CPU2s | Busy27.02%, iowait1.44% |
| Load1/5/15 | 2.89 /6.71 /6.13; load không phải CPU% và gồm task chờ I/O |
| Swap used | 190.53MiB; delta swap in/out0page trong khoảng2s |
| vmstat4 khoảng1s | si/so0/0; idle16–77%, iowait1–11%, có spike ngắn chứ không kết luận nghẽn kéo dài |
| Memory PSI avg10 | some0/full0 |
| CPU PSI avg10 | some16.93%; không phải CPU utilization |
| I/O PSI avg10 | some2.48%/full1.33% |
| Kernel OOM | oom_kill0 |
| C free | 33.72GiB |
| Windows physical disk | 37IO trong mẫu ~1s, average transfer latency0.915ms từ raw-counter delta |
| Linux active virtual disk sde | 39read/write IO trong2s; mean4.923ms, busy160ms; không quy trực tiếp thành latency đĩaC vật lý |

Không có số đo Windows/Linux CPU, queue depth hoặc physical-disk latency đúng05:21/05:55; chỉ **etcd latency có timestamp** trùng restart. Không dùng disk latency hiện tại dưới1ms để phủ nhận WAL15s trước đó.

Docker stats một lần: CP **1.184GiB/41.43% CPU**, Worker1 **675.8MiB/3.95%**, Worker2 **407.6MiB/4.56%**, broker **114.2MiB/1.90%**. Docker CPU%100 tương đương một logical CPU; không so trực tiếp với Windows tổngCPU%. Ba node đều không có giới hạn memory/CPU host riêng trong inspect; cùng chia sẻ WSL, không có thêm3×7.7GiB RAM. BlockIO của Docker là counter tích lũy, không phải throughput/latency tại đỉnh lỗi.

Đo cgroup v2 trên từng node, đúng đường dẫn `kubelet.slice/...` và static-pod config-mirror UID, không dùng nhầm mirror-Pod UID. Memory dưới đây là **memory.current, có thể gồm cache**, không phải RSS/working set.

| Pod | Memory hiện tại MiB | CPU dùng xấp xỉ core trong mẫu3.6s | CPU limit |
|---|---:|---:|---|
| CNPG operator | 106.2 | 0.009 | 0.5core |
| PG primary | 188.9 | 0.057 | 1core |
| PG standby | 190.0 | 0.008 | 1core |
| etcd | 90.8 | 0.068 | Không quota ở Pod |
| API Server | 371.4 | 0.127 | Không quota ở Pod |
| Controller-manager | 79.4 | 0.040 | Không quota ở Pod |
| Scheduler | 46.5 | 0.032 | Không quota ở Pod |

Trong mẫu cgroup ngắn: tất cả có throttle-event delta0, throttled-time delta0. Counters tích lũy operator98periods/5.976s, PGprimary56/0.888s, standby28/0.666s; không có timestamp cho từng lần throttle nên không nối chúng vào đỉnh05:21. CP Pods nr_throttled0/cpu.max=max; memory.events oom/oom_kill0 ở các cgroup đã kiểm tra. Requests/limits hiện tại giữ nguyên (operator100m/128Mi→500m/256Mi; mỗiPG200m/384Mi→1CPU/768Mi).

## 6. Đánh giá Auth2 và build/load

**Auth vẫn cần rebuild runtime**, theo audit4.0: own app/common/Prisma khớp nhưng contracts `inventory-api.js` và `openapi.js` trong image cũ khác source. Không dùng tagdev cũ để né build; không build trong4.0R.

Requests/limits đề nghị **mỗi Auth Pod100m CPU/192Mi RAM, limit500m/384Mi** vẫn hợp lý làm budget demo ban đầu; chưa có runtime measurement để chứng minh384Mi là đủ cho startup/peak. Hai replicas tổng request200m/384Mi, ceiling1CPU/768Mi. Với WSL available3493MiB, trừ riêng ceiling768Mi còn khoảng2725MiB=2.66GiB, trước overhead/runtime variation. Windows available3.71GiB cũng chưa chạm guard. **RAM có headroom trên giấy cho hai replicas; điều này không giải quyết vấn đề latency control plane.** Không giảm mục tiêu2replicas.

Build tuần tự chỉ giảm tải đồng thời, không bảo đảm API không timeout. Budget cho một image Auth cần cấu hình/xác minh ở checkpoint được duyệt: khoảng **0.75–1CPU, tối đa khoảng1.5GiB RAM, parallelism1**, không coi giới hạn đã có sẵn trong Dockerfile. Máy chỉ2core vật lý; pnpm/TypeScript/Prisma và unpack/cache cùng storage với etcd có thể làm CPU/IO tăng đột ngột. Không build thêm image khác lúc Auth startup; đo RAM/PSI/lease/API sau build trước khi load/deploy. Build và hai Auth cùng ceiling sẽ lấy khoảng2.25GiB, để lại chỉ khoảng1.16GiB WSL trong phép trừ thô này, dưới guard1.5GiB; vì vậy không dựa trên idle headroom để cho phép chúng chạy đồng thời.

Load image vào kind cũng có CPU decompression, đọc/ghi archive/layers và nhân bản sang hai Worker; **chưa đủ bằng chứng an toàn để load ngay**. Nếu được duyệt lại, load một Worker mỗi lần với timeout, kiểm tra API/etcd giữa các lần; không load cảCP nếu workload chỉ vào Worker. C free33.72GiB có dư địa cho một bước Auth có kiểm soát, nhưng free capacity không chứng minh I/O latency an toàn. Không prune hay thay storage để tạo thêm headroom trong phiên này.

Kết luận riêng từng câu hỏi: rebuild **có**; RAM Auth2 **có cơ sở để thử sau khi bỏHOLD**; build/load không gây timeout **chưa chứng minh**; requests/limits **giữ làm budget ban đầu, cần đo runtime**; triển khaiAuth2 ngay **chưa**.

## 7. Đề xuất xử lý và điều kiện nghiệm thu lại

Đây là đề xuất, **chưa thực hiện**:

1. Duy trì host awake/nguồn điện ổn định suốt cửa sổ demo và build; tránh sleep/hibernate/đóng nắp gây suspend. Xác nhận Windows power policy phù hợp bởi người dùng trước phiên sau; không tự sửa power plan/WSL/Docker trong4.0R. Không gọi sleep của cả laptop là Worker failure demo.
2. Khi host awake, lấy cửa sổ đọc10–15phút mới, polling nhẹ15–30s: counts/UID/leases, API latency/readyz, WAL slow-fdatasync mới, CPU/PSI/vmstat và Windows disk counters. Sau một lần sleep/restart mới phải bắt đầu lại cửa sổ, không nối với29phút cũ.
3. Nếu tiếp tục có WAL>1s/API timeout/lease loss lúc awake: thu thập CPU frequency/power state và physical/virtual disk latency/queue cùng timestamp để tách storage contention/CPU descheduling. Không stress/fio, không ưu tiên CPU/IO hoặc nới leader-election timeout trong scope chẩn đoán. Không restart/dừng Compose để làm đẹp số đo.
4. Chỉ đề nghị CONDITIONAL PASS khi awake window không có lỗi mới, API/etcd latency ổn định, resource guard đạt và có kế hoạch builder giới hạn tài nguyên đã được kiểm chứng. Nếu cần thay builder/host/storage settings, mô tả thay đổi cụ thể và duyệt scope riêng; không tự áp vào cluster.
5. Khi được phép Auth checkpoint: build một image, giám sát trong build; dừng tăng tải nếu có lease/API timeout mới, OOM/pressure, Windows available<1GiB hoặc WSL<1.5GiB kéo dài, swap IO đáng kể liên tục kèm PSI/latency xấu. Không dùng swap-used tăng vàiMiB làm lý do duy nhất. Load tuần tự, đo lại rồi chỉ deployAuth2; nghiệm thu hai Worker/probes/demo dependencies trước bước khác.

Hiện chưa thỏa các điều kiện trên do **đợt tái diễn mới và WAL15s của đợt05:21 còn chưa giải thích hết**. Cửa sổ sau hồi phục ngắn không đủ nâng thành CONDITIONAL PASS một cách mặc định. Không thay requests/limits/lease timeouts hiện tại để che triệu chứng.

## 8. Phạm vi bảo toàn và file tạo/sửa

Chỉ tạo mới báo cáo này và thư mục `docs/evidence/kubernetes-phase4-0r/`. Không sửa tài liệu/manifests4.0 hoặc Giai đoạn3. Bằng chứng mới gồm summary, lifecycle, normalized pods/nodes/leases/events, Windows power/resources, Linux/cgroup metrics, etcd/API health, selected logs, Docker stats/metadata, vmstat và replication SELECT. Không lưu secrets/password/private keys hoặc raw Docker environment.

Đối chiếu tất cả Docker containers ban đầu: ID/status/startedAt/restart/OOM/mounts không đổi trong4.0R. Hash tracked diff giữ nguyên. Không build/load image, apply/patch/restart/delete tài nguyên, tạo container/Pod test, migrate/seed, sửaPVC/volume, start/stopCompose, đổiWSL/power settings, reset/commit/pushGit. Diagnostic `exec` chỉ chạy psql SELECT, etcdctl endpoint health/status, đọc cgroup/journal/log files; không ghi dữ liệu nghiệp vụ hoặc cấu hình.

**Kết thúc4.0R tại HOLD. Không thực hiện4.1.**
