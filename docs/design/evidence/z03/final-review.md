# Z03 最终独立复查证据

日期：2026-09-08
工作区：`41254dd87282277b34c2c3bf9f29b1c2038e1211 + dirty`
状态：**PASS**；BLOCKER 0 / HIGH 0 / MEDIUM 0；findings：none。

## 复查范围

1. 当前 diff 与用户既有 dirty 工作区边界，无无关实现、源 ZIP / `data/source/` 改动或手改生成数据。
2. 五页前端、三运行模式、静态目录独立性、单图协议和 prompt/image/sidecar 追溯。
3. API/Worker/PG/OIDC/session/对象授权/配额/错误/审计/恢复/优雅停机。
4. W06 后 ProviderAdapter 的 OpenAI-compatible 单图 multipart、prompt LF/hash 保真、allowlist/SSRF/redirect/timeout/outcome unknown/凭据隔离。
5. W06 必须是用户授权后恰好 1 次真实 Provider 请求，不能用 simulator、mock 或 queued-only smoke 冒充。
6. v7 五制品、production dependency closure、SESSION_SECRET 职责隔离、gitleaks 与本地凭据边界。
7. 全量 CI、PostgreSQL integration、恢复演练、Chromium E2E、本地栈、O04 容量和源档只读。
8. 权威 Markdown、JSON、派生 HTML、清单和最终交付记录一致。

## W06 后首轮独立复查

首轮独立复查结论为 FAIL：BLOCKER 0 / HIGH 0 / MEDIUM 2。两个 MEDIUM 均为交付收口问题，不是运行时代码缺陷：

1. 权威文档仍保留“W06 未授权/Provider=0/v5”旧状态；Z04 尚无最终记录。
2. `.vitest/json/output.json` 是未忽略的测试缓存，污染 Git-visible 工作区 fingerprint。

首轮复查同时直接确认以下技术项通过：

- 生产镜像内 ProviderAdapter 使用 `/v1/images/edits`、`multipart/form-data`、一个 `image` part 和 `model/quality/prompt/n/size/response_format` 字段；自构造 bytes 保持 prompt LF 与 SHA-256。
- W06 真实 Provider 请求恰好 1 次；输入/输出真实像素、下载、metadata、input/prompt/result hashes 和 sidecar 匹配；第二次请求发送前硬阻断。
- `.gitleaks.toml` 只精确 allowlist Git-ignored `.tmp/w06-provider.env`，默认规则仍启用；报告、日志和制品无凭据 finding。
- 完整 CI 41/292 unit、26/133 integration、recovery、E2E 44；local stack、O04 14/14、源档只读与 SESSION_SECRET 修复通过。

## MEDIUM 关闭动作

- 更新 `README.md`、`docs/architecture.md`、`docs/full-stack-architecture.md`、`docs/operations/local-stack.md` 和清单续接记录，明确 W06 已以 1/1 授权真实请求通过及其有限范围。
- 新增 `docs/design/evidence/z04/final-delivery.{md,json}`，列明运行命令、最终测试、v7 制品、残余风险和未授权操作边界。
- `.gitignore` 新增精确 `.vitest/`，使测试缓存不再进入 Git-visible diff/fingerprint；没有把 source、报告或制品排除出秘密扫描。
- 在文档同步与缓存忽略后重建 `.tmp/z04-final-artifacts-v7/`；四镜像与静态 tar checksum/gzip/load 通过，静态 tar 逐字节一致。构建时 fingerprint 为 `6ce80a41291f3b483eba147f951099bbc40c37c539b3aa07ff1608b84005c9d3`。
- O06 manifest/report 已更新为 v7；随后重新生成开发 handoff 与 engineering review HTML，并执行 Markdown/HTML/JSON 一致性检查。

## 最终独立复查结论

最终独立只读复查直接核验当前源码、W06 脱敏证据、v7 制品、production dependency closure、gitleaks、完整 CI、本地栈、O04、恢复、源档边界、权威文档和派生 HTML。结论：**PASS**；BLOCKER 0 / HIGH 0 / MEDIUM 0；findings：none。前述两个 MEDIUM 均已关闭。

**无阻断 finding，Z03 可勾选。** commit、push、registry push、deploy、生产 migration 和额外付费 Provider 调用仍是未授权操作边界，不是本次本地验收必须执行的动作。

机器可读记录见 [`final-review.json`](final-review.json)。
