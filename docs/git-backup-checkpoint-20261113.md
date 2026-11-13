# Git backup trước Kubernetes4.1 — 13/11/2026

Checkpoint lưu working tree trước triển khai, không chứng nhận toàn bộ ứng dụng đã qua regression tests hoặc Kubernetes4.1 đủ điều kiện chạy. Branch dự kiến `backup/pre-k8s-phase4-1-20261113`, parent `48e469a2468c177c33fb7939c338105179503c16` từ `feat/sales-pos`. Repo đích `https://github.com/hunrabb/trangsuc-microservice`, visibility PUBLIC, không thay visibility.

Trước backup:85 tracked modified +5 tracked deleted,360 untracked; không staged changes/merge/rebase/cherry-pick/revert dang dở. Remote `feat/sales-pos` trỏ cùng HEAD, không có commit chưa push trên nhánh hiện tại. Không reset/stash/discard, không đổi business logic/migrations để tạo checkpoint.

Bao gồm source NestJS/React/common/contracts, migrations, scripts/tests, Dockerfiles/Compose, Kong plugins, Kubernetes kind/CNPG/PostgreSQL/config/job/app/Kong/Nginx manifests, architecture docs và báo cáo3/4.0/4.0R cùng Kubernetes evidence được kiểm tra. Source catalog images trong `apps/storefront/public` là assets ứng dụng và được giữ. Năm deletion đều đúng danh sách trong `docs/stocktaking-removal.md`; bảo toàn thay đổi gỡ kiểm kê hiện có. Không phục hồi hoặc xóa thêm file. Chỉ chuẩn hóa hai dòng trống có trailing whitespace trong `docs/phase7-appraisal-evidence.md` (dòng129/131) để staged whitespace check đạt; không thay nội dung nghiệp vụ.

Loại89 optional business/browser evidence trong `docs/evidence/` ngoài các thư mục Kubernetes3-resume/4.0/4.0r, và `apps/storefront/test/evidence/`: không cần để build/khôi phục source, chưa xác minh hết personal data/ảnh giao diện. File vẫn nguyên trên máy; không đưa chúng lên public GitHub. Chi tiết từng đường dẫn trong inventory kèm theo. Các logs bị Git ignore, env thật, keys, node_modules/build output và dữ liệu volumes/PVC không thuộc checkpoint. Không có bản báo cáo1/2 riêng trong repository để bổ sung; kind README/config và các báo cáo hiện có được giữ.

Kiểm tra an toàn: scanner local pattern trên tracked+untracked; so khớp giá trị credential hiện tại trong env bằng bộ nhớ, không in/lưu giá trị; structured YAML kiểm tra populated Secret/kubeconfig; Gitleaks8.30.1 lấy official release, xác minh checksum, quét Git `--all` và candidate tree bằng redaction100%. Gitleaks báo46commits được xử lý; Git có49reachablecommits, custom blob scan đi toàn `rev-list --objects --all`1524blobs để kiểm tra thêm private keys/token signatures. Không gọi số46 là đủ49commits nếu không giải thích phạm vi công cụ.

History có1 generic-api-key cảnh báo: `tests/phase6/contracts.test.mjs:151` là contract-test identifier, không secret. Candidate có129 cảnh báo đã review:124hash fields trong image-audit,3image aliases,1checksum tool,1test identifier. Không thấy unresolved secret, private key, live-env credential match, populated Kubernetes Secret hay kubeconfig trong phần chọn. Env interpolation, Secret references, public JWT verification key và isolated test fixtures không phải credential thật được đưa lên Git. Không in secret values. Quét không phải bảo đảm tuyệt đối không có mọi kiểu dữ liệu nhạy cảm.

Chi tiết file chọn/loại và đánh giá scanner: `docs/git-backup-checkpoint-20261113-inventory.json`. Trước commit kiểm tra staged diff/name-status, `git diff --cached --check`, và quét chính staged snapshot; sau push so remote branch SHA với local. Exact commit SHA/branch URL và kết quả push sẽ báo trong trả lời cuối; không sửa commit để nhét SHA của chính nó.

## Khôi phục sau này — chỉ hướng dẫn

Lấy SHA đã xác minh trong báo cáo cuối. Tạo worktree mới để giữ nguyên công việc hiện tại:

```sh
git fetch origin backup/pre-k8s-phase4-1-20261113
git worktree add --detach ../trangsuc-checkpoint-20261113 <CHECKPOINT_SHA>
```

Mở thư mục mới để xem/build lại phiên bản checkpoint. Không chạy lệnh trên trong checkpoint backup này. Muốn sửa tiếp có thể tạo branch mới từ worktree đó. Không dùng reset --hard/clean; không checkout đè lên dirty worktree. Secrets/env cần phục hồi bằng nguồn bí mật riêng, không từ Git. Git khôi phục source/config templates; **không phục hồi PostgreSQL/RabbitMQ volumes, PVC data hoặc Docker images**. Không áp manifests/migrate tự động khi mở checkout.

Kubernetes4.1 vẫn **HOLD theo4.0R** do restart/latency đã ghi nhận. Backup thành công không tự bỏ gate này. Không deploy/build/load/restart Docker/Kubernetes, không migration/seed, không thay env/Secrets/WSL config hoặc dữ liệu nghiệp vụ trong phiên Git backup.
