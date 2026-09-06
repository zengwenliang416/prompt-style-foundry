# OnePic 前后端设计模式

## 推荐模式

### Adapter

统一 `generate(input)`、`getCapabilities()`、`cancel(requestId)`，隔离
OpenAI-compatible、内部网关和其他供应商的字段差异。

### Strategy

按质量、尺寸、成本、延迟和 provider 能力选择生成策略；策略不能绕过提示词版本、单图校验和安全检查。

### State Machine

生成任务只允许 `created -> queued -> running -> succeeded/failed/cancelled/expired/outcome_unknown`（与目标架构 §9、ADR 0001 D-2 一致），非法转换拒绝，重复事件幂等。`outcome_unknown` 须经 request ID 对账或人工处置退出，禁止自动重发；`expired` 由清理流程在结果媒体过期后从 `succeeded` 转移，不改写历史成功事实。

### Repository

领域服务依赖 `TemplateRepository`、`GenerationRepository`、`MediaRepository` 接口；数据库、对象存储和测试替身分别实现。

### Hexagonal Architecture

领域核心不依赖 HTTP、数据库、队列或 SDK。API、队列消费者和 CLI 是输入适配器；数据库、对象存储和 provider 是输出适配器。

### Outbox

首期不使用独立 outbox 表：无外部消息系统，generation 记录与 PG job 行在同一事务写入即保证原子性（ADR 0001 D-3）。仅在将来经单独决策引入外部 broker 时，才改为 generation 与 outbox 事件同事务写入、由 dispatcher 投递，避免“数据库成功但任务未入队”。

### Saga / Compensation

上传、生成、结果保存和清理不使用长事务；每一步记录状态，失败时删除临时对象、标记失败并释放配额。

### BFF

需要组合模板、权限和生成状态时使用 BFF 做鉴权、聚合、字段裁剪和错误转换，不复制领域逻辑。

### CQRS-lite

目录读取可继续来自静态 JSON/CDN，生成写入走 API/队列。当前规模不需要独立读模型或事件溯源。

## 不推荐

- 页面、API、数据库和 provider 混在一个函数的 Big Ball of Mud。
- 业务规则散落在 Controller/SQL 的贫血模型。
- 共享数据库、同步强耦合、无法独立发布的分布式单体。
- 一个 `app.js` 或服务类承担所有边界的 God Object。
- 未经用户明确触发的隐式上传或隐藏代理。

## 选择原则

当前优先“模块化单体 + 队列 + 明确端口”，只在扩缩容、故障隔离或团队边界明确时拆服务。不要为了 576 条模板过早引入微服务、CQRS 或事件溯源。
