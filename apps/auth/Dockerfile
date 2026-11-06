# syntax=docker/dockerfile:1
# Build từ THƯ MỤC GỐC repo:   docker build -f apps/auth/Dockerfile .
# Hai đích (target):
#   migrate  → chạy `prisma migrate deploy` rồi thoát (dùng cho container auth-migrate)
#   runtime  → chạy dịch vụ (đích mặc định, là tầng cuối cùng)
#
# Phiên bản Node phải khớp .nvmrc và `engines` trong package.json; phiên bản pnpm khớp `packageManager`.
ARG NODE_VERSION=24.22.2
ARG PNPM_VERSION=12.16.1

# ---------------------------------------------------------------- Nền: Node LTS bản slim + openssl
# Không dùng alpine: Prisma cần glibc và openssl.
FROM node:${NODE_VERSION}-slim AS runtime-base
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------- Tầng build
FROM runtime-base AS build
ARG PNPM_VERSION
# Cài đúng phiên bản pnpm bằng npm (không phụ thuộc corepack).
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app

# Tải thư viện theo lockfile trước: lớp này chỉ build lại khi lockfile đổi.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY . .
# Chỉ cài thư viện của app này + thư viện nội bộ nó dùng + công cụ ở gốc (typescript, nest cli).
RUN pnpm install --offline --frozen-lockfile --filter "@jewelry/auth..." --filter "."
RUN pnpm --filter @jewelry/auth exec prisma generate
RUN pnpm --filter "@jewelry/auth..." build

# Tách phần cần để chạy ra thư mục riêng (kèm thư viện nội bộ đã build).
#   /out/app     = chỉ dependencies (không có prisma CLI)
#   /out/migrate = thêm devDependencies của app (prisma CLI) để chạy migrate
RUN pnpm --filter @jewelry/auth deploy --prod /out/app
RUN pnpm --filter @jewelry/auth deploy /out/migrate

# ---------------------------------------------------------------- Đích: migrate
FROM runtime-base AS migrate
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/migrate ./
USER node
# Không có DATABASE_URL thì dừng ngay và nói rõ tên biến (thay vì để Prisma báo lỗi chung chung).
CMD ["sh", "-c", ": \"${DATABASE_URL:?DATABASE_URL chưa được đặt}\" && exec node_modules/.bin/prisma migrate deploy"]

# ---------------------------------------------------------------- Đích: runtime (mặc định)
FROM runtime-base AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out/app ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
