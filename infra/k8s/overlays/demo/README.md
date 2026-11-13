# Reconcile hạ tầng demo đã tồn tại

Overlay chỉ gồm Cluster2instances, StorageClass, Database/DatabaseRole, ConfigMaps và RabbitMQ Service/EndpointSlice. Không business Deployments, không Gateway, không Secret values, không migration Jobs hoặc config probe.

Render: `kubectl kustomize infra/k8s/overlays/demo`.

Chỉ reconcile cluster jewelry-lab đã provision theo checkpoint, với đúng demo Secrets còn nguyên và broker external IP còn đúng. Operator/CRDs cài riêng tại infra/k8s/cnpg, không cài lại checkpoint đã hoàn thành. Không apply cluster-bootstrap.yaml lên cluster2instances. Không apply recursively infra/k8s vì gồm cả bootstrap/test/migration manifests.

Role/database/schema ownership do CRDs quản lý; privileges.sql quản lý ACL/default privileges sau CRDs đã applied. Sau migrations phải bảo đảm runtime không có quyền sửa _prisma_migrations; quyền đó được revoke ở acceptance. Không dùng SQL đổi ownership trái CRD.

Không dùng overlay này thay quy trình bootstrap mới có placement Primary ban đầu Worker1; không reset, delete PVC/Cluster hoặc regenerate secrets. Không tự deploy Giai đoạn4.
