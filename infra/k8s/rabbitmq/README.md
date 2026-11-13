# RabbitMQ demo độc lập

Compose project `jewelry-demo-deps`, container `jewelry-demo-rabbitmq`, volume `jewelry-demo-rabbitmq-data`, official RabbitMQ4.4.0 image pinned digest. Giới hạn CPU0.75/RAM768Mi, watermark384Mi. Network Docker `kind` external, không host ports, nằm ngoài hai Worker. Không sử dụng network/vhost/volumes/credentials của Compose cũ.

Vhost `jewelry-demo`, user demo riêng. topology.json chỉ topology durable, ánh xạ từ source sang vhost demo; không password/hash ở Git. Actual definitions có salted hashes được tạo tại `/home/hung/.local/share/jewelry-demo/broker-definitions.json`, parent0700/file0444 cho container đọc; không in/copy file đó vào Git. Plain passwords ở Kubernetes Secrets `rabbitmq-demo-app` và `rabbitmq-demo-admin`.

Để reconcile broker hiện có, set `JEWELRY_DEMO_RABBIT_DEFINITIONS` tới file protected đã tạo, rồi dùng `docker compose -p jewelry-demo-deps -f infra/k8s/rabbitmq/compose.yaml up -d --pull never`. Không tự tái tạo credentials, không down -v/prune. Thiếu file phải phục hồi/provision demo credentials theo quy trình riêng, không dùng .env cũ.

Service ClusterIP `rabbitmq.jewelry-demo.svc.cluster.local:5672` nối tới EndpointSlice selectorless, Docker kind IP hiện tại172.19.0.5. **Nếu recreate broker làm đổi IP, phải cập nhật service.yaml/EndpointSlice từ IP thực đo trước khi test/đưa app chạy**; không coi Docker IP là service discovery vĩnh viễn. Restart cùng container thường giữ endpoint, worker failure không dừng broker. Chưa thử failover; broker1instance vẫn SPOF.

probe.cjs đã PASS từ Pod UID1000/resource-limited bằng demo app credential qua DNS/ClusterIP. Queue classic durable `phase3.probe.connectivity` chỉ chứa message thử, đã xóa. Dùng durable vì RabbitMQ4.4 mặc định chặn transient non-exclusive queues; không bật deprecated feature. Pod/ConfigMap test đã xóa. Probe đầu lỗi symlink pnpm, đã sửa resolve realpath; không thay application code. Không event nghiệp vụ được publish/consume trong test.
