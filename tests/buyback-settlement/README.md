# Task 7.3 isolated integration tests

`settlement.integration.mjs` chạy trên PostgreSQL thật, gọi Inventory HTTP loopback;
`rabbit.integration.mjs` dùng RabbitMQ thật và Report DB thật. Runner cố ý từ chối
chạy nếu thiếu `PHASE73_TEST_EXECUTE=I_ACKNOWLEDGE_ISOLATED_PHASE73_TEST` hoặc URL
khác DB `phase73_test` trên localhost port 55434, service roles/schema riêng.

Compose: `infra/phase7/compose.settlement-test.yml`. Dùng project/env/volume test
riêng, áp dụng migrations Sales/Inventory/Report trên DB test và build các package
liên quan trước khi chạy. Credentials nên tạo trong thư mục private ngoài repo;
không dùng `.env` dev/prod. Chạy hai runner tuần tự bằng Node v24.22.2:

```sh
node --env-file=<private-tests.env> tests/buyback-settlement/settlement.integration.mjs
node --env-file=<private-tests.env> tests/buyback-settlement/rabbit.integration.mjs
```

Runner tạo fixture với UUID riêng, không xóa/đặt lại volume. Sau test chỉ dừng
containers riêng bằng `docker compose -f infra/phase7/compose.settlement-test.yml stop`;
giữ evidence để kiểm tra, không `down -v`.
