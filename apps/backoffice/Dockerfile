# syntax=docker/dockerfile:1
# Build từ THƯ MỤC GỐC repo:   docker build -f apps/backoffice/Dockerfile .
# Frontend: build tĩnh bằng Vite rồi phục vụ bằng nginx (bản không cần quyền root, nghe cổng 8080).
# Phiên bản Node phải khớp .nvmrc và `engines` trong package.json; phiên bản pnpm khớp `packageManager`.
ARG NODE_VERSION=24.22.2
ARG PNPM_VERSION=12.16.1
ARG NGINX_VERSION=1.30.6

# ---------------------------------------------------------------- Tầng build
FROM node:${NODE_VERSION}-slim AS build
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install --offline --frozen-lockfile --filter "@jewelry/backoffice..." --filter "."
RUN pnpm --filter @jewelry/backoffice build

# ---------------------------------------------------------------- Tầng chạy: web server file tĩnh
# Frontend không có Prisma nên dùng được bản alpine nhẹ.
FROM nginxinc/nginx-unprivileged:${NGINX_VERSION}-alpine AS runtime
COPY apps/backoffice/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/backoffice/dist /usr/share/nginx/html
EXPOSE 8080
