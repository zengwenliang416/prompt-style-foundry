# ADR 0003：后端边界批准记录与规则修订范围

- 日期：2026-09-06
- 状态：已接受（用户已批准）
- 关联清单项：D00（门禁）；解除 F/B/M/J/W/O 的实现阻塞

## 批准来源

用户于 2026-09-06 在本任务会话中明确回复「我全部批准」。该回复直接针对两条待决项：(1) D00 后端边界范围（服务端、身份/OIDC、存储、隐私与 AGENTS 修订）；(2) D03 的替代处理（授权以 prompt 衍生基线重建视觉基准，代替缺失原图）。

## 批准范围（允许实施）

按目标架构 §1–10、ADR 0001（D-1～D-4）与 ADR 0002：

- 模块化单体 HTTPS API/BFF + 独立 Worker（不引入微服务、Redis、外部消息 broker、Kubernetes）。
- PostgreSQL 元数据与 job 表（首期队列即 PG job 表）。
- S3 兼容私有对象存储（无公共 ACL、短期签名 URL）。
- 受信 OIDC（授权码 + PKCE）+ 服务端 opaque session；managed-generation 未配置身份源时拒绝开启。
- 对象级授权、配额/速率/并发限制、统一错误与审计。
- managed-generation 模式：provider key 由 secret manager/受管密钥文件注入 Worker，禁止任意 baseUrl 转发。

## 明确不在本次批准内（仍需分别授权）

- 提交（commit）、推送（push）、部署（deploy）、付费 provider 调用、生产迁移——按 Goal 逐项分别取得授权。
- 支付、会员、团队系统；分析/遥测；上游品牌与应用代码复用；源档（ZIP 与 data/source）修改。
- 静态 catalog-only 与 direct-BYOK 模式必须保留且可用；不得自动把浏览器密钥迁移或转发到服务器。

## 规则差异（AGENTS.md 修订摘要）

- §7 原句「The project has no backend and no telemetry. ... Never add a server-side proxy, account system, or implicit upload path.」按批准范围拆分：允许上述批准范围内的受控后端；禁止项保留（遥测、隐式上传路径、任意转发、支付/会员/团队）。
- 新增 §11「已批准后端边界」，记录批准来源、范围与保留门禁。

## 隐私边界核对

- 图片与提示词仅在用户显式触发生成后离开服务器，且只发往 allowlist provider；direct-BYOK 模式密钥仅存浏览器 localStorage。
- 日志不落 Authorization、API key、图片 URL、完整提示词、图片正文或 provider 响应正文。
- 上传先隔离（quarantine），解码校验后才可用；输入/结果按保留策略自动过期并审计删除。
- 对象级授权：成员仅可访问 ownerId 资源；管理员默认无用户图片读取权。
- 私人生成结果不自动进入 public/previews；公共模板协议（单图、无必填文本、比例保持）不变。

## 后果

- D00 可勾选；F/B/M/J/W/O 的实现阻塞解除，按清单依赖顺序推进。
- D03 原图仍缺失：采纳 D04 草案作为用户批准的工作基线，像素级保真永久不可验，Z04 交付记录须列为残余风险。
