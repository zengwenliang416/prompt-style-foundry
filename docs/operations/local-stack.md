# OnePic 本地启动、容器与优雅停机

## 运行边界

本仓库支持三条互不替代的运行路径：

1. **静态目录**：`public/` 零后端独立运行，目录、提示词复制和 direct BYOK 保持可用；
2. **五页 Web + API**：Vue 五页前端由 Nginx 提供，`/api/` 反代模块化单体 API；
3. **受控生图 Worker**：仅在显式开启并配置可信 OIDC、PostgreSQL、私有媒体目录和服务端 allowlist Provider 后消费 generation job。

默认 `docker compose up` 使用 `catalog-only` API，Worker 仅运行清理与内部健康/指标，不会调用 Provider。W06 已在单次授权下完成真实 Provider 最小兼容验证，但本地 loopback 测试替身仍只用于回归，不能冒充真实调用或容量证明；后续任何真实/付费调用仍需另行授权。

## 前置条件

- Docker Engine 及 Compose；
- 本地端口 4173 可用，或设置 `ONEPIC_WEB_PORT`；
- 首次构建需要访问 npm 与 Docker 镜像源；
- 不要把真实 `.env`、OIDC secret、session secret 或 Provider key 提交到仓库。

配置示例位于：

- `apps/api/.env.example`
- `apps/worker/.env.example`

## 干净启动（默认无付费路径）

```bash
docker compose build --pull
docker compose up -d

docker compose ps
curl -fsS http://127.0.0.1:4173/internal/health/live
curl -fsS http://127.0.0.1:4173/api/v1/health/live
curl -fsS http://127.0.0.1:4173/api/v1/health/ready
```

`catalog-only` / `direct-byok` API 即使配置 `DATABASE_URL` 也只做连接健康检查，不执行 migration 或 catalog 写入。只有 `managed-generation` production entrypoint 会在监听前顺序执行 migration 与 catalog import；任一步失败立即退出，migration/import 使用 PostgreSQL advisory lock 收敛并发副本。managed readiness 同时要求 schema v5、576 个 template version 与 `case-532@1` 已存在；不满足或 PG 不可达时返回 HTTP 503 + `status=degraded`，Compose 因 `curl -f` 将副本摘出健康流量。`worker` 的内部健康端点只绑定容器内 `127.0.0.1:9090`，不发布到宿主机；Compose healthcheck 会访问：

```text
/internal/health/live
/internal/health/ready
```

查看脱敏日志：

```bash
docker compose logs --no-color api worker web
```

停止并保留本地卷：

```bash
docker compose down
```

删除本地测试数据库和媒体卷是破坏性操作，只在确认无需保留后手工执行：

```bash
docker compose down --volumes
```

该命令不得用于生产数据。

## 深链接与静态资源

Web 容器对未知前端路径使用 `try_files ... /index.html`，以下路径刷新必须返回五页 SPA，而不是 Nginx 404：

```bash
curl -fsS http://127.0.0.1:4173/discover
curl -fsS http://127.0.0.1:4173/studio
curl -fsS http://127.0.0.1:4173/workspace
curl -fsS http://127.0.0.1:4173/guide
```

目录数据仍由独立 `public/` 内容提供：

```bash
curl -fsS http://127.0.0.1:4173/data/catalog.json
curl -fsS http://127.0.0.1:4173/data/prompts/case-532.txt
curl -fsS http://127.0.0.1:4173/previews/case-1.webp -o /dev/null
```

## 原静态包独立运行

不需要 Docker、数据库或 Node 服务：

```bash
python3 scripts/serve.py --host 127.0.0.1 --port 4174
```

也可只构建静态容器 profile；它不启动 API、Worker 或 PostgreSQL：

```bash
ONEPIC_STATIC_PORT=4174 docker compose --profile static-only build static
docker compose --profile static-only up -d --no-deps static
curl -fsS http://127.0.0.1:4174/data/catalog.json
```

静态发布归档仍使用：

```bash
scripts/package-site.sh .tmp/onepic-static.tar.gz
```

## 开启 managed-generation

只有在已经配置可信 OIDC 和经运维控制的 allowlist Provider 时才开启。Provider Base URL 只能来自 Worker 环境/secret manager，API 请求没有任意 baseUrl 转发字段。

至少设置：

```bash
export ONEPIC_RUN_MODE=managed-generation
export ONEPIC_OIDC_ISSUER=https://id.example.com
export ONEPIC_OIDC_CLIENT_ID=onepic-api
export ONEPIC_OIDC_CLIENT_SECRET='从 secret manager 注入'
export ONEPIC_OIDC_REDIRECT_URI=http://127.0.0.1:4173/api/v1/auth/callback
export ONEPIC_SESSION_SECRET='至少 32 字符的随机 secret'

export ONEPIC_WORKER_GENERATION_ENABLED=true
export ONEPIC_PROVIDER_ID=managed-primary
export ONEPIC_PROVIDER_BASE_URL=https://images.example.com
export ONEPIC_PROVIDER_API_KEY='从 secret manager 注入'
export ONEPIC_PROVIDER_MODELS='gpt-image-2:high+medium'

docker compose up -d --build
```

在不调用 Provider 的前提下验证 production API 启动链：

```bash
npm run verify:managed-image
```

该 smoke 启动两个并发 API 副本连接全新 PostgreSQL，断言 migration/import 串行收敛、一个 release/576 versions、managed readiness、`case-532` 单图 precheck/create/sidecar；另用缺失 catalog root 启动故障副本，断言非零退出且不出现 `api_started`。Worker 不启动，generation 保持 `queued`，Provider 调用为 0。
注意：Compose 不验证身份源或 Provider 是否属于生产批准清单；配置责任在部署方。Worker 自身会拒绝缺字段、非 loopback HTTP、带凭据/path/query 的 Base URL、非法模型列表，以及 heartbeat 不短于 lease 的配置。任何真实生图都会产生外部数据传输和潜在费用，未授权时不要开启。

## Worker 优雅停机语义

收到 `SIGTERM`/`SIGINT` 后，Worker：

1. 停止领取新 job；
2. 继续 heartbeat 并等待当前任务，默认 30 秒；
3. 在宽限期内完成的任务正常原子完成；
4. 宽限期耗尽且 Provider 请求可能已经开始时，先把 generation 置为 `outcome_unknown`、job 置为 dead，再中止请求；重启后不会把该 job 放回 pending 盲目重发；
5. 只有显式对账/人工处置才能结束 `outcome_unknown`。

`ONEPIC_CONTAINER_STOP_GRACE` 应大于 `ONEPIC_WORKER_SHUTDOWN_GRACE_SECONDS`，默认分别为 35 秒和 30 秒。若编排器强杀早于 Worker 宽限期，无法保证执行上述保护。

本地验证：

```bash
npx vitest run --config vitest.integration.config.ts apps/worker/test/runtime-shutdown.integration.test.ts
```

测试使用真实临时 PostgreSQL、真实租约/CAS/存储和可中止的本地 Provider double；它验证“可能已发送”的任务进入 unknown/dead，重启后 Provider 调用数仍为 0，并验证宽限期内成功完成。它不声称真实 Provider 兼容。

## 非容器开发启动

```bash
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
npm ci
npm run build:workspaces

DATABASE_URL='postgresql://...' node apps/api/dist/db/migrate-cli.js
node --env-file=apps/api/.env apps/api/dist/server.js
node --env-file=apps/worker/.env apps/worker/dist/index.js
```

五页前端开发服务器：

```bash
npm run dev -w @onepic/web -- --host 127.0.0.1
```

静态 `public/` 服务与 workspace Web 是独立入口；不要因启动后端而删除、覆盖或要求迁移浏览器中的 BYOK key。
