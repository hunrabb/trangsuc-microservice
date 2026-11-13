# CloudNativePG operator cho jewelry-lab

Upstream tag `v1.30.1`, file `releases/cnpg-1.30.1.yaml`.

Manifest SHA256: `37237f145d8138256ea25ae830f87759255665ff08f8d552fdd8224a5ec032fb`.

Operator: `ghcr.io/cloudnative-pg/cloudnative-pg:1.30.1@sha256:923c267ec29636db3bee20f993d0ec4973fa22998e1adad37da79e4d32b5bc07`.

Patch chỉ placement Control Plane với toleration riêng, resource requests/limits, image digest. Không bỏ taint. RBAC/CRDs/webhooks giữ nguyên upstream. Một operator không chịu lỗi Control Plane; mục tiêu ở đây là độc lập với hai Worker.

Apply sau preflight: `kubectl --kubeconfig /home/hung/.kube/jewelry-lab.config apply --server-side --field-manager=jewelry-phase3 -k infra/k8s/cnpg`. Không xóa CRDs khi có database/PVC.
