# syntax=docker/dockerfile:1
# Build từ THƯ MỤC GỐC repo:   docker build -f apps/gateway/Dockerfile .
# Phiên bản Node phải khớp .nvmrc và `engines` trong package.json; phiên bản pnpm khớp `packageManager`.
ARG NODE_VERSION=26.13.0
ARG PNPM_VERSION=12.16.1

# ---------------------------------------------------------------- Nền: Node LTS bản slim + openssl
FROM node:${NODE_VERSION}-slim AS runtime-base
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------- Tầng build
FROM runtime-base AS build
ARG PNPM_VERSION
# Node 26 không còn kèm corepack nên cài pnpm trực tiếp.
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app

# Tải thư viện theo lockfile trước: lớp này chỉ build lại khi lockfile đổi.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY . .
# Chỉ cài thư viện của app này + thư viện nội bộ nó dùng + công cụ ở gốc (typescript, nest cli).
RUN pnpm install --offline --frozen-lockfile --filter "@jewelry/gateway..." --filter "."
RUN pnpm --filter "@jewelry/gateway..." build
RUN pnpm --filter @jewelry/gateway deploy --prod /out/app

# ---------------------------------------------------------------- Đích: runtime
FROM runtime-base AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out/app ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
