# ── 阶段 1：构建依赖 ──────────────────────────────────────
ARG NODE_IMAGE=node:20-alpine
FROM ${NODE_IMAGE} AS builder

ARG ALPINE_REPO_MIRROR=
ARG NPM_REGISTRY=

# 可选：切换 Alpine 包仓库镜像（解决国内/受限网络下 apk 下载慢或失败）
# 传参示例：--build-arg ALPINE_REPO_MIRROR=mirrors.aliyun.com/alpine
RUN if [ -n "$ALPINE_REPO_MIRROR" ]; then \
      m="$ALPINE_REPO_MIRROR"; \
      m="${m#http://}"; \
      m="${m#https://}"; \
      sed -i "s|dl-cdn.alpinelinux.org/alpine|$m|g" /etc/apk/repositories; \
    fi

# better-sqlite3 编译依赖（仅在构建阶段需要）
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./

# 安装依赖（npm 镜像可选）
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
  && npm install --production

# ── 阶段 2：运行时 ────────────────────────────────────────
FROM ${NODE_IMAGE}

ARG ALPINE_REPO_MIRROR=

# 运行时只需 ffmpeg（HLS 转码）和 ca-certificates（HTTPS 请求）
RUN if [ -n "$ALPINE_REPO_MIRROR" ]; then \
      m="$ALPINE_REPO_MIRROR"; \
      m="${m#http://}"; \
      m="${m#https://}"; \
      sed -i "s|dl-cdn.alpinelinux.org/alpine|$m|g" /etc/apk/repositories; \
    fi \
  && apk add --no-cache ffmpeg

WORKDIR /app

# 从构建阶段复制已编译的 node_modules（含 better-sqlite3 原生二进制）
COPY --from=builder /app/node_modules ./node_modules

# 复制应用源码
COPY . .

# 创建非 root 用户运行应用
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
  && mkdir -p /app/data \
  && chown -R appuser:appgroup /app/data

# 预建 .env（Docker 环境变量通过 compose environment 传入，.env 仅作回退）
RUN if [ -f env.example ]; then cp env.example .env; fi \
  && chown appuser:appgroup .env 2>/dev/null || true

USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

# 健康检查（使用 Node 内置 fetch，无需额外安装 wget/curl）
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;fetch('http://localhost:'+p+'/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
