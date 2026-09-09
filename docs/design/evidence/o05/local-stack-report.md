# O05 容器、本地启动、健康与优雅停机证据

- 日期：2026-09-07
- 工作区：`41254dd + dirty`（未 commit）
- 真实/付费 Provider 调用：0
- 机器可读容器 smoke：[`local-stack-smoke.json`](local-stack-smoke.json)

## 实现

- `Dockerfile`：独立 `api`、`worker`、五页 `web`、原 `public/` 的 `static` 四个 target；Node 服务以非 root 用户运行；运行镜像包含 migrations、contracts OpenAPI、共享 managed runtime。
- API production target 携带不可变 importer bundle（`catalog.json`、576 个 prompt TXT、`templates.json`）；仅 `managed-generation` 在监听前 fail-closed 执行 migration/import，并以 PostgreSQL advisory lock 串行化并发副本。
- `RUN_MODE` 同时约束启动副作用与路由：`catalog-only` / `direct-byok` 即使保留 DB/OIDC 环境也不迁移、不导入、不开放 managed routes；managed readiness 还验证 schema v5、576 versions 与 `case-532@1`，不完整或 PG 失联返回 HTTP 503/degraded。
- `compose.yaml`：PostgreSQL 16、API、Worker、Nginx Web；默认 `catalog-only` 不写 schema 且 generation consumer 关闭；`static-only` profile 不依赖后端。
- `ops/nginx/*.conf`：`/api/` 反代，五页 history fallback，`data/`、`previews/` 静态读取；修正源文件 0600 权限后以 `chmod a+rX` 保证 Nginx worker 可读。
- `packages/managed-runtime/`：API/Worker 共用 Provider allowlist/SSRF/redirect/credential boundary、Sharp 图像校验和本地存储；API 历史路径保留兼容 re-export。
- `apps/worker/src/config.ts`：generation 显式 opt-in，拒绝缺失凭据、非 loopback HTTP、非法 URL/模型/时序配置；错误只含字段和问题，不回显 secret。
- `apps/worker/src/runtime.ts` + `index.ts`：每 slot 独立 `PoolClient` 的 claim/execute loop、heartbeat、连接失败重连、内部 health/metrics、SIGTERM/SIGINT 停止新 claim。
- `apps/worker/src/execute.ts`：Provider `AbortSignal` 传递；发送前回调记录 attempt；generation provider id 必须匹配服务端 Worker 配置。
- 宽限期耗尽时，已可能发送到 Provider 的工作先 CAS 为 `generation.outcome_unknown`、`job.dead`，再 abort；不会回到 pending 盲目重发。
- `scripts/verify-local-stack.sh` / `npm run verify:local-stack`：唯一 Compose project/ports/volumes 的干净 smoke，成功后删除自身容器和卷并写 JSON 证据。
- `docs/operations/local-stack.md`、`apps/worker/.env.example`：默认无付费路径、managed 启用边界、健康端点、静态独立运行与停机规则。

## 验收证据

### 干净容器启动、健康和深链接

```bash
npm run verify:local-stack
```

退出码 0。脚本实际执行并断言：

- `docker compose config --quiet` 和 `docker build --check .`；
- 干净、隔离的 PostgreSQL/API/Worker/Web 构建与启动；
- API liveness/readiness 和 Worker 内部 readiness；
- `/`、`/discover`、`/studio`、`/workspace`、`/guide` 直接请求/刷新均返回 SPA；
- `catalog.json`、`case-532.txt` 可读取；
- 无 API 依赖的 static target 单独启动并读取相同目录/提示词；
- Worker 收到容器 SIGTERM 后输出 `worker_stopped`；
- `public/` 没有 `.DS_Store`、AppleDouble 或 `*.tmp`；
- 测试 project 的容器和卷已删除。

结果见 `local-stack-smoke.json`，Docker 29.5.3 / Compose 5.1.4，全部断言 `true`。

### 生产 API 镜像的 managed 目录绑定

```bash
npm run verify:managed-image
```

`verify:local-stack` 会复用刚构建的 production API image 再执行此 smoke。它让两个 API 副本同时面对另一套干净 PostgreSQL，验证 migration session lock 与 catalog transaction lock 收敛为一个 release、576 个 `template_version` 和 `case-532@1`；随后将 release 计数临时改为 575，两个副本均返回 HTTP 503/degraded，恢复 576 后重新 ready。接着插入受控测试 session，经真实 HTTP 完成单图 upload/confirm、`case-532` precheck、generation `202 queued` 和 sidecar 读取，prompt/input SHA-256 均与 catalog/上传字节一致。另以缺失 catalog root 启动第三个副本，验证 import 非零退出、记录 `catalog_import_failed` 且从未记录 `api_started`。未启动 Worker，外部/付费 Provider 调用为 0。机器证据：[`managed-image-smoke.json`](managed-image-smoke.json)。

### 在途停机不盲目重发

```bash
npx vitest run --config vitest.integration.config.ts \
  apps/worker/test/runtime-shutdown.integration.test.ts
```

1 文件、2 例通过。测试使用真实临时 PostgreSQL、真实 job lease/CAS、真实本地存储：

1. Provider 请求开始后故意阻塞，40 ms 宽限期耗尽；`stop()` 报告 `activeAtSignal=1`、`markedOutcomeUnknown=1`、`aborted=1`、`remaining=0`；数据库为 `generation=outcome_unknown`、`job=dead`、`attempt=unknown`；启动第二个 runtime 后 Provider 调用仍为 0。
2. Provider 在 1 秒宽限期内结束，停机等待完成；数据库为 `generation=succeeded`、`job=done`。

该 Provider 是可中止的本地 test double，不是 W06 真实 Provider。

### 可部署 Worker 进程接线与 O04 回归

```bash
npm run benchmark:capacity
```

退出码 0，14 项预算全部 PASS。可部署 `apps/worker/dist/index.js` 经真实 PG claim/execute/complete、真实本地存储和隔离 loopback simulator 完成 1 个 job：`claim=1`、simulator request=1、`generation=succeeded`、`job=done`。随后 320-job harness 达到 8/8 并发、1060.73 jobs/s、0 重复；PG 峰值 17；真实/外部 Provider 调用 0。详见：

- `docs/design/evidence/o04/capacity-report.json`
- `docs/design/evidence/o04/capacity-report.md`

进程探针只证明至少一个真实执行路径，不能冒充多 slot Provider 容量或 W06。

### 全量回归

```bash
npm run lint
npm run typecheck
npm run format:check
npm run gen:api:check
npm run build:workspaces
npm run test:unit
npm run test:integration
npm run test:e2e
bash scripts/ci-verify.sh
```

Z03 独立审查修复后再次运行 `npm run verify:local-stack`，退出码 0；默认 catalog-only 对空 PG 零 schema 写入，PG/API/Worker/Web/static health、production managed 双副本 catalog 收敛、故障 fail-closed、`case-532` precheck/create/sidecar、五页深链接、静态独立、SIGTERM 和资源清理全部通过。随后 `CI=true ONEPIC_PG_BIN=/opt/homebrew/opt/postgresql@16/bin bash scripts/ci-verify.sh` 全量退出码 0：

- unit：41 文件、291 例；
- integration：26 文件、133 例；
- Playwright Chromium：44 例；
- Python：23 例；
- contracts lint 通过（OpenAPI 无错误，保留 5 条建议性 response warning）；
- 最终输出 `Repository verification passed.`。

## 残余边界

- O05 本地栈演练本身未调用真实 Provider（请求 0）；W06 后续已在单次授权下独立完成，见 [`../w06/real-provider-report.md`](../w06/real-provider-report.md)。O05 仍不作为真实兼容或容量证明。
- 未测试 S3-compatible 存储、生产 TLS/反向代理、生产 PostgreSQL，或真实编排器下的长期多实例运行；本地两副本 smoke 只覆盖冷启动 migration/import 竞争与 fail-closed。
- `ONEPIC_CONTAINER_STOP_GRACE` 必须大于 Worker 自身 shutdown grace；否则外部 SIGKILL 可打断 unknown/dead 的保护事务。
- 本项未执行 commit、push、deploy 或生产 migration。
