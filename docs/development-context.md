# 渐进式上下文索引

## L0：每次续接

读取适用的 [AGENTS.md](../AGENTS.md)、[GOAL.md](../GOAL.md)，然后只读 [开发清单](development-checklist.md)开头的续接记录及当前阶段。核对 Git 分支、工作区差异与所需服务。Goal 是交接提示，不会自动启动本任务或修改现有规则。

## L1：按任务加载

| 任务 | 必读文档/章节 | 用途 |
|---|---|---|
| 基线、范围、选型 | [README](../README.md)、[当前架构](architecture.md)、[目标架构](full-stack-architecture.md) §1–4、§10、[ADR 0001](adr/0001-phase1-scope-and-consistency.md)、[ADR 0002](adr/0002-dependency-baseline.md) | 区分事实与方案，确认禁止边界、目录、技术选型与依赖基线 |
| 五页与状态 | [目标架构](full-stack-architecture.md) §5、[设计/代码规范](frontend-backend-standards.md)前端章节、[DESIGN 规范](design/DESIGN.md)、[重建设计图](design/ui-rebuilt-2026-09-06/)（含 prompt/metadata/SHA256SUMS）、[UI prompt 持久副本](design/ui-2026-09-05-prompts/) | 页面职责、交互与状态管理；视觉基准为 DESIGN.md，重建图为参考（非原图恢复、非像素级验收） |
| API、数据、任务 | [目标架构](full-stack-architecture.md) §6–9、[设计/代码规范](frontend-backend-standards.md) API/后端章节、[设计模式](design-patterns.md)相关模式、[ADR 0001](adr/0001-phase1-scope-and-consistency.md)、[后端数据字典](design/backend-data-dictionary.md)与[接口 schema](design/backend-schemas/) | 契约、状态机、幂等、所有权、安全、字段/约束/错误码 |
| 模板与生成追溯 | [数据模型](data-model.md)、[提示词协议](prompt-protocol.md)、[来源说明](source-provenance.md)、[预览入库说明](../data/generated-previews/README.md) | 编译协议、示例与运行时区别、哈希和来源 |
| 授权、来源及许可证 | [NOTICE](../NOTICE.md)、[LICENSE](../LICENSE)、[第三方许可目录](../third_party/) | 保留归属，不复用上游应用 |
| 测试、上线准备 | [目标架构](full-stack-architecture.md) §8–10、[设计/代码规范](frontend-backend-standards.md)测试/Git 章节、[README](../README.md) | 安全、验证和发布界限 |
| 人类评审 | [设计评审 HTML](engineering-review.html)、[样式](engineering-review.css)、[本清单 HTML](development-handoff.html) | 派生视图，不重复加载为模型上下文；Markdown 是权威 |

以上覆盖当前 docs 全部已有文档。[HTML 链接转换器](render-handoff.lua)仅在渲染交接页时使用。新建 ADR、契约、DESIGN、runbook 和测试证据后，必须加入本索引对应行；只引用实际存在的文件，不预造链接。

## L2：按需读代码与证据

- 编译/导入：`scripts/prompt_protocol.py`、`build_library.py`、`import_source.py`、`validate_library.py` 和相关 tests；仅抽查当前样例，禁止整库全文塞入上下文。设计契约示例由 `scripts/validate_design_schemas.py`（需 jsonschema，见 requirements-dev.txt）校验。
- 预览：`scripts/install_generated_previews.py`、manifest 的相关条目及对应 sidecar；不可手改 public 生成文件。
- 当前前端：`public/index.html`、`public/assets/app.js`、`styles.css`、`fx.js` 的相关函数和选择器。
- 运维：`package.json`、`scripts/ci-verify.sh`、`package-site.sh`、`serve.py`、`ops/` 与实际存在的 CI 配置。不要读取或输出密钥。
- U12 响应式/无障碍对照截图：[docs/design/evidence/u12/](design/evidence/u12/)（15 张 PNG，320/768/1440 × 五页，DESIGN.md 基线口径）。
- 新代码：按当前任务精读模块及相邻测试；恢复时先看该任务证据，不重复扫描全库。工作区布局（F01 起）：根 package.json 定义 npm workspaces（`apps/web|api|worker`、`packages/contracts|client`），`npm run build:workspaces` 按依赖顺序构建；`packages/contracts` 为 API 信封与任务状态类型先导，OpenAPI 源与运行时校验由 F05 建立；Python 编译器与 `public/` 静态站独立于工作区，不受其影响。

## 设计与冲突处理

现有 Markdown 是方案，不是完整可执行契约。原已知待收敛问题（目录 API 边界、状态机 outcome_unknown、队列/outbox 与媒体过期、OIDC 与运行模式）已由 D02 收敛为 [ADR 0001](adr/0001-phase1-scope-and-consistency.md)，目标架构 §6/§8/§9 与设计模式文档已同步修订，相互引用一致。

D03 更新（2026-09-06）：原五张设计图确认不可恢复后，用户批准以其他方式重建视觉基准（ADR 0003），重建产物已落盘 [docs/design/ui-rebuilt-2026-09-06/](design/ui-rebuilt-2026-09-06/)：五张 1672×941 PNG、逐张实际请求 prompt、生成 metadata（记录模型/端点/请求与实际尺寸/哈希）及 SHA256SUMS.txt 校验值；全部通过哈希比对与 PIL 解码核验，路径未被 gitignore。该目录是重建版而非原图恢复，不宣称 4K 或像素级保真；README 中"实现纠正项"不得照搬进实现。UI prompt 文本持久副本仍保留于 [docs/design/ui-2026-09-05-prompts/](design/ui-2026-09-05-prompts/)。

授权只覆盖当前用户明确提出的生命周期步骤。后端设计可细化，但 AGENTS 边界批准之前，不实施代理、账号或数据库运行时。已批准事项记录一次即可，不重复询问；缺失的安全/生产授权不可推断。
