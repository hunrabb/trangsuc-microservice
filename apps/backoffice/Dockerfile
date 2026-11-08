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

# Client ID của Google (công khai, nhúng vào bản build). Thiếu thì trang đăng nhập báo rõ chứ không hỏng.
ARG VITE_GOOGLE_CLIENT_ID=
ENV VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID}
ARG VITE_POS_BANK_BIN=
ARG VITE_POS_BANK_ACCOUNT=
ARG VITE_POS_BANK_NAME=
ENV VITE_POS_BANK_BIN=${VITE_POS_BANK_BIN}
ENV VITE_POS_BANK_ACCOUNT=${VITE_POS_BANK_ACCOUNT}
ENV VITE_POS_BANK_NAME=${VITE_POS_BANK_NAME}

COPY . .
RUN pnpm install --offline --frozen-lockfile --filter "@jewelry/backoffice..." --filter "."
RUN pnpm --filter @jewelry/backoffice build

# ---------------------------------------------------------------- Tầng chạy: web server file tĩnh
# Frontend không có Prisma nên dùng được bản alpine nhẹ.
FROM nginxinc/nginx-unprivileged:${NGINX_VERSION}-alpine AS runtime
COPY apps/backoffice/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/backoffice/dist /usr/share/nginx/html
EXPOSE 8080
