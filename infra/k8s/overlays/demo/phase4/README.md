# Checkpoint 4.0 — draft only

Chỉ tổng hợp manifests mới; không tham chiếu lại base Giai đoạn 3, không chứa migration Jobs, database hoặc broker.

**Không apply toàn overlay để bắt đầu 4.1.** Placeholder images chưa build/load và còn control-plane/rate-limit/client-IP/entry gates. Đọc `docs/kubernetes-phase4-plan.md`, chờ duyệt từng checkpoint. Auth-only sau duyệt dùng thư mục `infra/k8s/apps/auth/`, thay tag bằng artifact đã kiểm chứng và recheck dependencies trước rollout.

Kiểm tra đọc được phép trong 4.0:

```sh
kubectl --kubeconfig /home/hung/.kube/jewelry-lab.config kustomize infra/k8s/overlays/demo/phase4
```

Namespace `jewelry-demo` và Secret/ConfigMap references lấy từ Giai đoạn 3; không include Secret values trong Git. Kong ConfigMap chỉ chứa public RSA key. Mỗi Nginx có đủ hai bộ SPA artifacts qua init containers; không cần thay Dockerfile hiện tại để phục vụ hai SPA.
