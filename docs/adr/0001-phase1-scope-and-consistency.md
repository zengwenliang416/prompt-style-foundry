# ADR 0001：首期范围与文档一致性决策

- 日期：2026-09-06
- 状态：已接受（设计决策；实施仍受 D00 边界批准门禁约束）
- 关联清单项：D02

## 背景

`development-context.md` 记录的已知待收敛问题：目标架构 §5 声明首期不重复建目录 API，§6 却列出目录接口；`design-patterns.md` 状态机缺少 `outcome_unknown`；队列/outbox 首期边界与媒体过期语义未统一；OIDC 与各运行模式的关系未明确。本 ADR 对上述四点做出决策，并同步修订相关文档。

## 决策

### D-1 目录 API 首期不实现

目录（模板元数据、提示词、预览）首期继续由现有 Python 流水线生成的静态 JSON/TXT/WebP 提供，经 CDN/Nginx 直接服务。目标架构 §6 的 `GET /templates`、`GET /templates/{id}` 保留为目标契约，标注为后续阶段；首期 API 仅包含上传、生成、取消与健康检查。理由：576 条模板为不可变发布物，静态分发成本低且已验证；API 读取不可变版本的需求在 managed-generation 上线时再评估。不引入读模型或独立目录服务。

### D-2 生成任务状态机以目标架构 §9 为准

`created -> queued -> running -> succeeded / failed / cancelled / expired / outcome_unknown`。
`outcome_unknown` 是一等终态前的悬挂态：provider 超时或连接中断且无法确认上游是否接受时进入，必须通过 request ID 对账或人工处置退出，禁止自动重发。设计模式文档的状态机定义同步补齐该状态。`expired` 为清理流程在结果媒体过期后将 `succeeded` 任务转移的终态；媒体过期不改变 attempt 记录中的历史成功事实，提示词快照与任务元数据保留至任务保留期结束。

### D-3 首期队列即 PG job 表，不引入 outbox 表与外部消息系统

创建 generation 与 PG job 行在同一数据库事务写入，原子性由事务保证；Worker 通过租约、心跳、CAS 与 dead-letter 字段领取任务。Outbox + dispatcher 模式仅在将来引入外部消息 broker（经单独决策）时启用。媒体过期与任务状态按 D-2 分离：任务终态不可变，媒体可用性独立过期。

### D-4 运行模式与身份耦合关系

- `catalog-only`：无身份、无服务端生图，纯静态浏览与复制。
- `direct-BYOK`：无身份；provider 密钥仅存浏览器 localStorage，请求从浏览器直连用户配置的端点；模式切换不得把密钥迁移或转发到服务器。
- `managed-generation`：必须配置受信 OIDC 身份源（授权码 + PKCE + 服务端 opaque session）；未配置身份源时该模式拒绝开启（对应 F03 校验）。游客只读目录，成员仅可访问 ownerId 资源，管理员默认无用户图片读取权。

## 后果

- 首期拓扑保持模块化单体 API + 独立 Worker + PostgreSQL + 私有对象存储，不静默引入微服务、Redis、消息 broker 或 Kubernetes。
- 目标架构 §6、§9 与设计模式文档已同步修订，相互引用一致。
- 取消语义维持“取消请求”模型（J08）：排队任务可立即取消，运行中任务向上游发取消请求但不保证成功，成功竞态如实上报，本地取消不承诺免计费。
- D00 批准前，本 ADR 不产生任何服务端实现。
