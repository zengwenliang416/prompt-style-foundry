# 前后端架构设计

## 1. 状态与边界

这是待实施的目标方案，不代表后端已经存在。当前项目是静态前端：浏览器读取生成目录、提示词和预览，生图时直连用户配置的 BYOK 服务。项目规则目前明确禁止服务端代理、账号、数据库和遥测，因此实施本方案前必须单独批准并修订该边界。

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

| 层 | 推荐 | 原因 |
|---|---|---|
| 前端 | Vue 3、TypeScript、Vite | 五页共享表单和异步任务需要组件化，同时可继续静态部署 |
| 状态 | Vue Router、Pinia、query 缓存 | 搜索条件可分享，任务状态不重复存储 |
| API | TypeScript、Fastify | 轻量模块化单体；Controller 与领域层易分离 |
| 契约 | OpenAPI 3.1、JSON Schema | 输入输出运行时校验并生成客户端类型 |
| 数据 | PostgreSQL、SQL migrations | 任务、配额、审计需要事务；SQLite 只用于本地演示 |
| 队列 | 首期 PostgreSQL job 表和 Worker 租约 | 减少基础设施；吞吐不足时再替换队列适配器 |
| 文件 | S3-compatible 私有对象存储 | 图片不写数据库、Git 或 80 服务器长期磁盘 |
| 部署 | Nginx 同域 API、API/Worker 两进程 | 减少跨域和部署拓扑复杂度 |

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

| 路由 | 任务 | 当前静态能力 | 目标服务端能力 |
|---|---|---|---|
| / | 总览、最近模板、入口 | 目录统计、本地最近项 | 本人任务、配额和状态 |
| /discover | 搜索、分类、蓝图类型、收藏 | 静态 catalog、按需提示词 | 版本和能力验证，首期不重复建目录 API |
| /studio/:templateId | 单图、预审、生成、结果 | 提示词、预览、direct BYOK | 上传隔离、幂等任务、异步状态、下载 |
| /workspace | 收藏、集合、历史、重试、导出 | localStorage 收藏 | 登录后的跨设备私人记录 |
| /guide | 来源、输入约束、隐私 | 静态文档 | 展示真实存储和保留策略 |

运行模式为 catalog-only、direct-BYOK、managed-generation。模式切换必须重新展示数据去向；不得自动把浏览器旧密钥转发到服务器。

## 6. API 约定

Base path 为 /api/v1。成功响应为 data 和 meta，错误为 error.code、error.message、details 和 correlationId。JSON 使用 camelCase，数据库使用 snake_case，时间使用 UTC ISO-8601，ID 使用 UUID/ULID，分页使用 cursor。

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | /templates | 目录元数据和筛选（后续阶段，首期见下方说明） |
| GET | /templates/{id} | 模板与不可变提示词版本（后续阶段，首期见下方说明） |
| POST | /uploads | 短期上传目标 |
| POST | /generations | 幂等创建任务，长任务返回 202 |
| GET | /generations/{id} | 状态和结果元数据 |
| POST | /generations/{id}/cancel | 取消可取消任务 |
| GET | /health/live | 进程存活 |
| GET | /health/ready | 依赖就绪 |

首期不实现目录 API：目录继续由静态 JSON/TXT/WebP 经 CDN/Nginx 分发（见 §5 与 ADR 0001 D-1），首期 API 仅包含上传、生成、取消与健康检查。

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

默认保留值是待产品确认的设计建议：未完成上传 1 小时；输入终态后 24 小时；结果 7 天；任务和提示词快照 30 天；脱敏安全事件 90 天。80 服务器只放服务、元数据和有界临时文件；磁盘 70% 告警、85% 停止新媒体写入，不自动删除业务数据。

## 10. 实施和验收

1. 单独批准架构、身份、隐私和 AGENTS 边界。
2. 先实现五页静态模式，真实处理 loading、空态、失败、重试和本地状态。
3. 建立 OpenAPI、OIDC、对象授权、配额和不可变 catalog 导入；此阶段关闭付费生图。
4. 打通一个模板的上传、预审、Worker、未知结果、存储、删除和审计。
5. 完成工作区、恢复演练、安全、压力和 E2E 后开放 managed-generation。

门禁包括契约 lint、类型检查、单元、PostgreSQL 集成、provider 合约、浏览器 E2E、越权/重放/上传绕过/日志泄漏/限流/删除测试，以及现有静态构建验证。迁移采用 expand/contract，破坏性 SQL 不随应用回滚。未完成实现前不得在 README 或 UI 宣称后端已上线。
