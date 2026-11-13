# Giai đoạn 1 — kind jewelry-lab

Ngày nghiệm thu: 13/11/2026 (Asia/Saigon). Kết quả: **PASS cho cluster nền**.
Đây là kiểm tra ngắn sau startup, không phải soak test hoặc chứng nhận đủ tài
nguyên cho toàn bộ workload. Chưa triển khai ứng dụng, PostgreSQL, CNPG,
RabbitMQ, gateway hoặc Metrics Server vào cluster.

## Phiên bản và phạm vi

- Host: Windows 10 build 19045.6456, Ubuntu 26.04.1 LTS / WSL 3.0.5.0.
- Docker Desktop Engine 29.9.2, Docker context `default`.
- kind 0.33.0: `/home/hung/.local/bin/kind` (không sửa shell profile/PATH).
- SHA-256 Linux amd64 binary đã khớp cả checksum asset và GitHub release API:
  `aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d`.
- Kubernetes và kubectl: 1.36.1.
- Image trên cả ba node:
  `kindest/node:v1.36.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5`.
- Digest image được công bố trong release kind 0.32.0; dùng với binary 0.33.0
  đã tạo cluster thành công trong lần nghiệm thu này. Không suy rộng thành
  bảo đảm tương thích mọi image giữa các release kind.
- Tài liệu CNPG 1.30.x liệt kê Kubernetes 1.36 được hỗ trợ; CNPG chưa được cài
  hay kiểm thử trên cluster này.

Nguồn xác minh:

- <https://github.com/kubernetes-sigs/kind/releases/tag/v0.33.0>
- <https://github.com/kubernetes-sigs/kind/releases/tag/v0.32.0>
- <https://kubernetes.io/releases/version-skew-policy/>
- <https://cloudnative-pg.io/docs/1.30/supported_releases/>

## Cluster và kubeconfig

- Cấu hình: `infra/k8s/kind/kind-config.yaml`.
- Cluster: `jewelry-lab`; context: `kind-jewelry-lab`.
- Kubeconfig riêng: `/home/hung/.kube/jewelry-lab.config`, mode `0600`.
  File này chứa credential quản trị: không commit hoặc in nội dung.
- API server: `https://127.0.0.1:35219` tại lần tạo này; cổng sẽ có thể khác
  nếu sau này tạo lại cluster. Không có port mapping workload ra LAN.
- Một control plane và hai worker; hai worker có label
  `jewelry-lab-worker=true`. Cột ROLES của worker hiển thị `<none>` là bình thường.

Lệnh đã sử dụng, chỉ ghi lại để tái lập; không chạy lại khi cluster còn tồn tại:

```bash
/home/hung/.local/bin/kind create cluster \
  --name jewelry-lab \
  --config infra/k8s/kind/kind-config.yaml \
  --image kindest/node:v1.36.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5 \
  --kubeconfig /home/hung/.kube/jewelry-lab.config \
  --wait 180s --retain
```

Lệnh tạo được bọc timeout tổng 600 giây và lưu output vào
`/tmp/jewelry-kind-phase1/create.log`. Không chạy lại hoặc xóa cluster tự động.

## Nghiệm thu

- 3/3 node Ready, đều chạy Kubernetes 1.36.1 và containerd 2.3.1.
- 13/13 system Pods Running/Ready, tổng restart count bằng 0.
- CoreDNS: 2 Pod Ready và Service EndpointSlice có hai địa chỉ ready.
  Chưa tạo Pod test để kiểm DNS query/cross-node traffic end-to-end.
- kindnet: 3 Pod Ready; kube-proxy: 3 Pod Ready.
- API `/readyz?verbose`: mọi check PASS; `cluster-info` phản hồi thành công.
- Node MemoryPressure, DiskPressure, PIDPressure: False trên cả ba node.
- Docker node containers: restart 0, OOMKilled=false.
- Startup có FailedScheduling khi worker chưa sẵn sàng và CoreDNS readiness
  connection refused; sau đó tự phục hồi, không còn Pod Pending/CrashLoopBackOff
  trong các snapshot nghiệm thu.
- kind tự tạo StorageClass/local-path-provisioner mặc định. Chưa có PVC/PV
  nghiệp vụ hoặc storage HA. Không cấu hình extraMounts.

## Tài nguyên thực đo

Các snapshot không atomic và không phải mức tiêu thụ tối đa. Không cộng RAM
Windows, WSL và Docker vì có phần bao gồm nhau.

| Chỉ số | Trước tạo | Sau khi system Pods Ready |
|---|---:|---:|
| Windows available | 4.069 MiB | 2.048 MiB ở mẫu cuối |
| Linux available | 4.339 MiB | 3.726–3.754 MiB ở ba mẫu ổn định |
| Swap used | 0 MiB | 4,9 → 5,4 → 5,4 MiB |
| CPU Windows | 44 / 52 / 36 / 24% | 23 / 53 / 13% |
| CPU Linux, các interval vmstat | khoảng 5–10% busy | khoảng 13–18% busy |
| C: free | 39,76 GiB | 38,42 GiB |
| Docker containers running | 11 | 14 |

Docker stats ở mẫu cuối:

| Node | RAM | CPU theo thang Docker |
|---|---:|---:|
| control-plane | 1,003 GiB | 24,05% |
| worker | 278,5 MiB | 2,83% |
| worker2 | 277,2 MiB | 2,34% |

Có memory PSI và một lượng swap nhỏ trong startup. Mẫu cuối không có swap
in/out; full memory PSI avg10 bằng 0, some avg10 khoảng 0,03. Không khẳng định
không từng có memory contention hoặc đủ RAM cho startup đồng loạt ứng dụng.
Windows chỉ còn khoảng 2 GiB available: giai đoạn sau phải rollout tuần tự và
đo lại, chưa nên tăng WSL RAM hoặc chạy trùng toàn bộ stack mới.

## Bảo toàn môi trường cũ

- Đối chiếu 24 container cũ trước/sau: ID, state, StartedAt, RestartCount,
  OOMKilled và mounts không thay đổi; 11 container cũ vẫn Running/healthy.
- Không thiếu volume cũ. kind tạo ba anonymous volume mới cho `/var` của các
  node; không tái sử dụng volume PostgreSQL/RabbitMQ.
- kind chỉ có bind mount hệ thống `/lib/modules` read-only; không mount mã
  nguồn hoặc thư mục PostgreSQL hiện tại.
- Hash `git diff --binary` của các tracked changes trước/sau không đổi.
- Không sửa business code, `.env`, keys, `.wslconfig`, Docker Desktop settings;
  không chạy migrations, prune, reset, commit hoặc push.
- Metadata đối chiếu nằm tại `/tmp/jewelry-kind-phase1/`; đây là bằng chứng tạm,
  có thể mất sau reboot/dọn `/tmp`, không chứa kubeconfig/private key.

## Sử dụng và giới hạn chuyển giai đoạn

Luôn chỉ rõ kubeconfig riêng:

```bash
kubectl --kubeconfig /home/hung/.kube/jewelry-lab.config get nodes -o wide
kubectl --kubeconfig /home/hung/.kube/jewelry-lab.config get pods -A
kubectl --kubeconfig /home/hung/.kube/jewelry-lab.config cluster-info
```

Cluster nền đạt tiêu chí Giai đoạn 1. Việc kiểm thử workload, cross-node DNS,
replica placement, CNPG, PVC, backup, migration Jobs và failover thuộc giai đoạn
sau, cần được chốt phạm vi trước khi triển khai. Không tự dừng Compose để lấy
RAM và không triển khai workload thêm trong Giai đoạn 1.
