# Z04 最终交付记录

日期：2026-09-08
工作区：`41254dd87282277b34c2c3bf9f29b1c2038e1211 + dirty`
状态：**完成**；所有必选项有可复查通过证据，Z03 最终独立复审 PASS（BLOCKER/HIGH/MEDIUM 0/0/0）。

## 1. 交付范围

- 五页 Vue 前端：首页、模板库、工作台、工作区、使用指南；支持 `catalog-only`、`direct-BYOK`、`managed-generation`。
- 原 `public/` 静态目录继续零后端独立运行，目录 metadata 与完整 prompt 分离，prompt 按需加载。
- Fastify API/BFF、PostgreSQL metadata/job table、可信 OIDC + opaque session、对象级授权、配额/并发、统一错误与审计。
- 独立 Worker：PG claim/lease/heartbeat/CAS、dead-letter、outcome unknown 防盲重发、结果图校验、保留/删除重放和优雅停机。
- 共享 managed runtime：单图 OpenAI-compatible multipart Provider adapter、HTTPS origin allowlist、禁止重定向、结果 URL SSRF 防护、超时/中止、真实图片解码、本地私有存储端口。
- OpenAPI、类型客户端、容器、CI、本地栈、容量、备份/恢复、确定性静态制品和操作文档。
- 上游 ZIP 与 `data/source/` 保持只读；公共提示词继续由 Python 编译器生成并满足单图协议与可追溯要求。

## 2. 运行命令

### 静态目录（零后端）

```bash
npm ci
npm run dev
# http://127.0.0.1:4173
```

等价入口：`python3 scripts/serve.py`。API、数据库或身份源不可用时，目录浏览、筛选与 prompt 复制仍可用。

### 五页前端开发服务器

```bash
npm ci
npm run dev -w @onepic/web -- --host 127.0.0.1
```

### 默认本地容器栈（无付费路径）

```bash
docker compose build --pull
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:4173/internal/health/live
curl -fsS http://127.0.0.1:4173/api/v1/health/live
```

默认 API 为 `catalog-only`，Worker 不调用 Provider。完整配置、managed 启动、静态-only profile、健康检查和停机步骤见 [`../../../operations/local-stack.md`](../../../operations/local-stack.md)。

### 非容器 managed 开发

```bash
npm ci
npm run build:workspaces
DATABASE_URL='postgresql://...' node apps/api/dist/db/migrate-cli.js
node --env-file=apps/api/.env apps/api/dist/server.js
node --env-file=apps/worker/.env apps/worker/dist/index.js
```

managed mode 必须配置可信 OIDC、强 `SESSION_SECRET`、PostgreSQL、私有媒体目录和服务端 Provider allowlist；缺失任一关键项必须 fail-closed。后续真实/付费调用仍需单独授权。

## 3. 最终验证

| 范围              | 命令/证据                                                                             | 结果                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 完整仓库门禁      | `CI=true ONEPIC_PG_BIN=/opt/homebrew/opt/postgresql@16/bin bash scripts/ci-verify.sh` | PASS；Python 23，unit 41 files / 292 tests，integration 26 / 133，recovery PASS，Chromium E2E 44/44；`Repository verification passed.`    |
| 本地完整栈        | `npm run verify:local-stack`                                                          | PASS；PG/API/Worker/Web/static、managed 双副本、503/degraded、单图 precheck/create/sidecar、静态独立、SIGTERM 和清理通过；外部 Provider 0 |
| 容量回归          | `npm run benchmark:capacity`                                                          | 14/14 本机回归预算 PASS；外部 Provider 0                                                                                                  |
| W06 真实 Provider | `npm run verify:real-provider` + 显式授权门禁                                         | PASS；付费请求恰好 1 次，输入/输出像素、MIME、下载 bytes、数据库 metadata、input/prompt/result SHA-256 与 sidecar 一致                    |
| 秘密扫描          | `gitleaks detect --no-git --source . --redact --exit-code 1`                          | PASS；约 76.38 MB，0 findings；仅精确 allowlist Git-ignored `.tmp/w06-provider.env`                                                       |
| 最终制品          | `.tmp/z04-final-artifacts-v7/`                                                        | 四镜像 + standalone static tar checksum/gzip/load 通过；静态 tar 连续构建逐字节一致                                                       |
| 源档边界          | Z01 + `git status -- data/source`                                                     | 576 templates、529 case previews、493 reviewed generated previews、45 sidecars；`data/source/` 无变化，archive SHA-256 不变               |

日志：`/tmp/onepic-z04-ci-final.log`、`/tmp/onepic-w06-local-final.log`、`/tmp/onepic-w06-capacity3.log`、`/tmp/onepic-w06-real-provider.log`。日志是本机辅助证据；权威脱敏机器数据位于仓库内 evidence JSON。

## 4. 最终制品

制品目录：`.tmp/z04-final-artifacts-v7/`
构建时 Git-visible fingerprint：`6ce80a41291f3b483eba147f951099bbc40c37c539b3aa07ff1608b84005c9d3`

| target            | image ID / 格式                                                           |     bytes | SHA-256                                                            |
| ----------------- | ------------------------------------------------------------------------- | --------: | ------------------------------------------------------------------ |
| API               | `sha256:3b9a19a4c214f89df00bcf6b25317bbe86165461179741485a6c9ca9f2305aef` | 100211368 | `5878fedef5a6c0b1279f8a8859ed8903951177f4519972b71ee699384c192e99` |
| Worker            | `sha256:d0cdd47b9d6d6f0ac0412b17be66b1bfbda19f72470ca5cb9f9c1180495920ea` |  97102029 | `e0a93acb27867043fd5247ed1e353e87a3dab218d568ab8aa56e85ac1ab0ca3b` |
| Web               | `sha256:a187162c25e292ef957cf66ad25a2e6dc6b21d19f35669decf473e55293d86c7` |  80158393 | `ee7183c430c781b032a2f18c7a6b6800b90762cf1fa069e0308c71f41e70db62` |
| static image      | `sha256:1660d5410257fe836db8e1d94bc0950e0c5f87e5e0c033c1bdeee5e5479f27e2` |  80095429 | `251e3aefd5899636778aa93b6f17d32ff266b864de5354b02a98fc50f5b448d8` |
| standalone static | deterministic tar+gzip / 1203 members                                     |  29154700 | `145f3555b08252be147b5223e6faed82b9b065c84410a4b6e5cf25dca21ce3a1` |

该 fingerprint 是制品构建瞬间的源快照；本记录、最终复审、清单和派生 HTML 在构建后写入，因此 live fingerprint 预期不同。未执行 registry push 或部署。

## 5. W06 真实性与限制

用户明确授权最多一次真实 Provider 最小单图付费调用；实际请求计数为 1，第二次请求在发送前由脚本硬阻断。使用脚本生成的非私密 PNG 和公共 `case-409` prompt，没有上传用户私图或私有文本。输出 PNG 可由 Sharp 解码，generation、media metadata、下载内容和 sidecar 的 hashes 全部一致。

该验证只覆盖 `motion-cover`、`gpt-image-2/high`、PNG 和一个模板。输入 512×320，输出 1600×983，方向保持横向，但宽高比相对偏差约 1.7294%；这是已记录的 Provider 行为限制，不宣称像素级比例完全保持，不外推为并发、限流、全格式、长时稳定性或生产容量。

## 6. 残余风险与未执行动作

- Phase one 仍为 `LocalDiskStorage`；真实 S3-compatible adapter、私有 bucket、签名 URL 和对象恢复尚未做生产集成验证。
- 未运行远端 GitHub Actions/Woodpecker，未执行生产 TLS/多实例/生产 PG 参数验证。
- 2026-09-05 原五张设计图不可恢复；视觉验收基于用户批准的 2026-09-06 重建基线，不宣称原图像素级保真。
- 工作区基于 `main` 的 dirty 快照交付，保留了既有与本次改动；未创建 commit。
- 未执行 commit、push、registry push、deploy 或生产 migration。它们需要逐项单独授权，不是本次本地代码交付的完成条件。
- 不包含支付、会员、团队系统或 telemetry；没有扩大批准边界。

## 7. 最终验收结论

- `docs/development-checklist.md` 所有必选项均已勾选；未勾选项为 0。
- Z03 最终独立复审 PASS：BLOCKER 0 / HIGH 0 / MEDIUM 0，findings none。
- W06 真实 Provider 请求恰好 1 次，未追加收费请求。
- 残余风险、未验证生产范围和未授权动作均已列明，不把 mock、设计稿、LocalDiskStorage 或本地验证冒充生产上线。
- 因此 Z04 满足验收，可勾选；本地代码/测试/文档交付完成。

## 8. 证据索引

- Z01 数据与生成回归：[`../z01/final-regression.md`](../z01/final-regression.md)
- Z02 文档同步：[`../z02/documentation-sync.md`](../z02/documentation-sync.md)
- Z03 独立复审：[`../z03/final-review.md`](../z03/final-review.md)
- W06 真实 Provider：[`../w06/real-provider-report.md`](../w06/real-provider-report.md)
- O04 容量：[`../o04/capacity-report.md`](../o04/capacity-report.md)
- O05 本地栈：[`../o05/local-stack-report.md`](../o05/local-stack-report.md)
- O06 制品：[`../o06/release-report.md`](../o06/release-report.md)
- O07 恢复：[`../o07/recovery-report.md`](../o07/recovery-report.md)

机器可读摘要：[`final-delivery.json`](final-delivery.json)。
