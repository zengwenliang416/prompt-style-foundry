# 前后端架构设计

## 1. 状态与边界

本文件同时记录已实现架构和仍需外部授权的上线门禁。后端边界已由 2026-09-06 的 ADR 0003 批准；当前仓库已经包含 Vue 五页前端、Fastify API、PostgreSQL migrations/job table、独立 Worker、共享 managed runtime、受控 Provider adapter、容器/CI/恢复自动化。它们已在隔离本地 PG、LocalDiskStorage、loopback simulator 和 Chromium 中验证；另在用户明确授权最多 1 次付费请求后完成 W06 真实 Provider 最小单图验证。当前仍未部署。

当前有三种模式：`catalog-only`、`direct-BYOK`、`managed-generation`。前两种保持无账号可用；managed mode 必须配置受信 OIDC 和 server-side opaque session，未配置时拒绝开启。禁止 telemetry、隐式上传、任意 baseUrl 服务端转发、支付/会员/团队系统。
必须保留的约束：上游 ZIP 和 data/source 只读；Python 编译器是提示词唯一权威；公共模板要求一张参考图、无必填文本、保持比例和方向；私人生成结果不自动进入 public/previews；API 不可用时仍可浏览和复制提示词。

## 2. 推荐拓扑

```text
Browser -> Static CDN/Nginx
       -> HTTPS API/BFF -> Catalog module
                         -> Generation module
                         -> PostgreSQL metadata
                         -> Private object storage
                         -> PostgreSQL job table + Worker
                         -> Provider adapters
```

首期采用模块化单体 API 加独立 Worker，不引入微服务、Kubernetes、Redis 或独立服务网格。目录继续由现有 Python import/build/validate 流水线生成，API 只读取不可变版本，不在运行时修改源数据。

## 3. 技术选型

| 层   | 推荐                                                                            | 原因                                                            |
| ---- | ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 前端 | Vue 3、TypeScript、Vite                                                         | 五页共享表单和异步任务需要组件化，同时可继续静态部署            |
| 状态 | Vue Router、Pinia、query 缓存                                                   | 搜索条件可分享，任务状态不重复存储                              |
| API  | TypeScript、Fastify                                                             | 轻量模块化单体；Controller 与领域层易分离                       |
| 契约 | OpenAPI 3.1、JSON Schema                                                        | 输入输出运行时校验并生成客户端类型                              |
| 数据 | PostgreSQL、SQL migrations                                                      | 任务、配额、审计需要事务；SQLite 只用于本地演示                 |
| 队列 | 首期 PostgreSQL job 表和 Worker 租约                                            | 减少基础设施；吞吐不足时再替换队列适配器                        |
| 文件 | 当前 phase-one `LocalDiskStorage` 端口实现；生产目标 S3-compatible 私有对象存储 | 图片不写数据库、Git 或 public；真实 S3 adapter/恢复演练尚未完成 |
| 部署 | Nginx 同域 API、API/Worker 两进程                                               | 减少跨域和部署拓扑复杂度                                        |

## 4. 模块与代码边界

```text
apps/web/src/{app,pages,features,entities,shared}
apps/api/src/modules/{catalog,generation,media,identity,workspace,policy}
apps/api/src/{bootstrap}
apps/worker/src/
packages/contracts/
packages/client/
packages/test-support/
scripts/
ops/
```

Controller 只做协议转换和鉴权；Application 编排用例；Domain 定义不变量、端口和状态机；Infrastructure 实现数据库、对象存储和供应商。页面不得导入后端内部类型，领域层不得依赖 HTTP 框架、SQL driver 或 provider SDK。

## 5. 五页职责

| 路由                | 当前实现                                                                     | 服务端边界                                                                     |
| ------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| /                   | 目录统计、推荐模板、最近项、模式入口                                         | catalog-only 不上传；managed 任务信息只来自本人会话                            |
| /discover           | 静态 catalog 搜索/分类/蓝图类型、按需 prompt、收藏                           | 首期不重复建设模板 API；目录版本/hash 由静态发布物提供                         |
| /studio/:templateId | 单图上传/预审/提交/轮询/取消/下载；catalog-only、direct-BYOK、managed 三模式 | managed 使用隔离上传、幂等任务、异步状态、signed result；direct key 不进服务端 |
| /workspace          | 浏览器本地收藏/集合/最近/导入导出；显式导入服务器入口                        | API 已实现本人收藏、集合、历史分页与导出；不自动迁移本地记录/密钥              |
| /guide              | 来源、单图协议、模式和真实数据去向                                           | 静态可读；managed 文案必须反映存储/保留策略                                    |

运行模式为 catalog-only、direct-BYOK、managed-generation。模式切换必须重新展示数据去向；不得自动把浏览器旧密钥转发到服务器。

## 6. API 约定

Base path 为 /api/v1。成功响应为 data 和 meta，错误为 error.code、error.message、details 和 correlationId。JSON 使用 camelCase，数据库使用 snake_case，时间使用 UTC ISO-8601，ID 使用 UUID/ULID，分页使用 cursor。

| 方法                | 路径                                                 | 语义                                              |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| GET                 | /health/live、/health/ready                          | 进程存活与 PostgreSQL/配置就绪                    |
| GET                 | /auth/login、/auth/callback                          | OIDC PKCE 浏览器重定向登录与回调                  |
| GET / POST          | /auth/me、/auth/refresh、/auth/logout                | 当前主体、opaque session 轮换与注销               |
| GET                 | /media/{bucket}/{objectKey}                          | 会话、属主和短期签名共同约束的私有图片下载        |
| POST / PUT / POST   | /uploads、/uploads/{id}/bytes、/uploads/{id}/confirm | 上传会话、同进程 quarantine bytes、解码确认       |
| POST                | /prechecks                                           | 单图/模板版本/hash/能力预审                       |
| GET / POST          | /generations                                         | 本人历史 cursor 分页、幂等创建任务                |
| GET / DELETE        | /generations/{id}                                    | 本人状态/结果、显式删除                           |
| GET                 | /generations/{id}/sidecar                            | prompt/input/result 哈希与 metadata-only 追溯记录 |
| POST                | /generations/{id}/cancel                             | 取消可取消任务                                    |
| GET / POST / DELETE | /collections、/collections/{id}                      | 本人集合分页、创建、删除                          |
| POST / DELETE       | /collections/{id}/items[/...]                        | 幂等收藏/集合项写入与删除                         |
| GET                 | /exports/workspace                                   | 本人私人记录导出                                  |

首期没有 `/templates` API：目录继续由静态 JSON/TXT/WebP 经 CDN/Nginx 分发（ADR 0001 D-1）。OpenAPI 权威文件是 `packages/contracts/openapi/api-v1.yaml`；实现、generated client 和漂移检查必须同步。

创建任务必须携带 templateId、templateVersion、promptSha256、sourceObjectId、settings 和 Idempotency-Key。服务端重新读取不可变提示词并校验哈希，不接受浏览器任意正文替换公共模板。不能把 provider 超时直接当失败重试。

## 7. 数据一致性与图像关联

Generation 必须记录 templateId、templateVersion、catalogReleaseId、compiledPromptSha256、effectivePromptSha256、inputObjectId、inputSha256、providerId、model、settings 和 idempotencyKey。Attempt 记录真实发送的提示词哈希、上游 request ID、状态和错误码。结果记录实际 MIME、字节数、宽高、哈希和 Attempt ID。

预审需要改变提示词时必须阻断请求，由维护流程创建候选版本、差异和新哈希；前台不能偷偷缩短、翻译或重写再冒用旧版本。默认 effective prompt 等于编译 prompt。请求 high/4K 不等于实际输出 high/4K。

## 8. 身份、安全、隐私

统一服务器密钥的生图上线前必须完成身份、对象级授权和配额。managed-generation 模式必须配置受信 OIDC（授权码 + PKCE）加服务端 opaque session，未配置身份源时该模式拒绝开启；catalog-only 与 direct-BYOK 不需要服务端身份，direct-BYOK 密钥仅存在浏览器 localStorage，模式切换不迁移、不转发（ADR 0001 D-4）。游客只能读目录，成员只能访问 ownerId 资源，管理员默认不能读取用户图片。

Provider key 由 secret manager 或受管密钥文件注入 Worker，禁止任意 baseUrl 服务器转发。强制 TLS、严格 CORS、短期 signed URL、魔数和 MIME 校验、字节与像素上限、限流和 provider 并发限制。日志不得写 Authorization、API key、图片 URL、完整提示词、用户图片或 provider 响应正文。发送到外部 provider 前必须明确同意。

首期限额建议：输入 20 MiB、40 MP，仅 JPEG/PNG/WebP；结果 60 MiB、64 MP。上传先 quarantine，解码校验后才 ready；首期拒绝 SVG、HTML、动画和压缩包。输入和结果自动过期并审计删除。

## 9. 任务可靠性与运维

```text
created -> queued -> running -> succeeded
                         |-> failed / cancelled / expired / outcome_unknown
```

状态转换集中定义，重复事件幂等。Provider 超时或连接中断先进入 outcome_unknown，通过 request ID 查询或人工处置，避免重复计费。只有有证据的 retryable 错误才重试，耗尽后进入 dead-letter。`expired` 是结果媒体过期后由清理流程从 `succeeded` 转移的终态；媒体过期不改变 attempt 中的历史成功事实（ADR 0001 D-2）。

首期队列即 PG job 表：创建 generation 与 job 行在同一事务写入，Worker 通过租约、心跳、CAS、过期回收和 dead-letter 字段领取；不引入外部消息系统。将来引入 broker 时才以 outbox 事件同事务写入并由 dispatcher 投递（ADR 0001 D-3）。

生产 API 的数据库副作用也受模式边界约束：`catalog-only` 与 `direct-byok` 不执行 migration/import；`managed-generation` 在监听前按顺序执行 migration 与 catalog import，二者分别持有 PostgreSQL advisory lock 以串行化冷启动副本，任何失败都 fail-closed。managed readiness 除连接外还要求 schema v5、包含 576 个 template version 的 catalog release 与 `case-532@1` 已就绪；条件不满足或 PG 失联时返回 HTTP 503 + degraded，使 Compose/负载均衡健康检查摘除副本。

当前 Worker 已实现可配置默认保留值：未完成上传 1 小时；输入在关联任务终态后 24 小时；结果 7 天；可清理任务/提示词事实 30 天；脱敏审计事件 90 天。`outcome_unknown`、在途任务和仍受引用的媒体受结构性保护；实际生产值和合规要求上线前仍需环境级批准。服务主机只放运行程序、元数据和有界临时文件；容量预算要求磁盘 70% 告警、85% 停止新媒体写入，不自动删除业务数据。

## 10. 实施和验收

已完成且有本地隔离证据：

1. ADR 0003 已批准受控后端边界；上游只读、无 telemetry、无任意转发等保留约束仍生效。
2. 五页静态/catalog/direct-BYOK/managed UI、loading/空态/失败/取消/过期与本地状态已实现。
3. OpenAPI、opaque session/OIDC 门禁、对象授权、配额、不可变 catalog/hash 校验、上传/预审/生成/工作区 API 已实现。
4. Worker lease/heartbeat/CAS/dead-letter、unknown 保护、结果校验、清理、删除清单与审计已实现。
5. 安全负例、容量、本地容器栈、独立制品、backup/restore、旧应用兼容、Chromium E2E 已演练。

仍未完成的外部/生产验证：

- W06 已以 1 次授权真实 Provider 请求通过；仅覆盖 `motion-cover`、`gpt-image-2/high`、PNG 和一个模板，输出宽高比相对输入偏差约 1.7294%，不能外推为容量或全格式兼容。
- 当前对象适配器为 LocalDiskStorage；生产 S3-compatible adapter 与真实私有 bucket 恢复演练未完成。
- 未执行 commit/push/registry push/远端 CI/deploy/生产 migration；这些动作各自需要授权。

门禁包括契约 lint、类型检查、单元、PostgreSQL 集成、provider 合约、浏览器 E2E、越权/重放/上传绕过/日志泄漏/限流/删除测试，以及现有静态构建验证。迁移采用 expand/contract；应用回滚保留最新 schema，禁止自动 down migration 或把数据库恢复当普通应用回滚。实现存在不等于生产已上线。
