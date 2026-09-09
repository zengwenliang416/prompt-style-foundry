# 安全负例矩阵（O03）

九类安全负例 × 测试证据对应表。每类至少一个真实失败路径断言；新增用例集中在
`apps/worker/test/security-negative.integration.test.ts`（真实 PG + 真实 HTTP inject +
真实本地存储，不 mock 被测对象）。本表随实现演进更新；验收回归见开发清单 O03 执行记录。

| # | 类别 | 证据（文件 → 用例） | 覆盖方式 |
|---|------|--------------------|----------|
| 1 | 越权（IDOR/角色） | `apps/api/test/policy.integration.test.ts` →「denies user A every action on user B objects」「allows admin metadata inspection but denies admin media reads and writes」「enforces ownership at the SQL layer」（B04）；`apps/worker/test/workbench-cancel.integration.test.ts` → 跨用户取消 403；`apps/api/test/media-access.integration.test.ts` → 跨用户签名链接 404；`apps/worker/test/workspace.integration.test.ts` → 集合属主 | 既有（点名）；管理员默认无读图权在 B04 已测 |
| 2 | CSRF | `apps/api/test/identity.integration.test.ts` →「rejects cross-site mutating requests without the CSRF header pair」（无 Origin/错 Origin/缺自定义头均 403）、「rejects a callback whose state does not match」「enforces token issuer, audience, expiry, and nonce」（B03）；O03 新增 `security-negative.integration.test.ts` →「rejects a headerless cross-site POST even with a valid session cookie」（带有效 cookie 但无 CSRF 头 → 403 且集合未创建） | 既有 + 新增 |
| 3 | XSS/恶意元数据 | 新增：`security-negative.integration.test.ts` →「stores and returns markup-carrying names verbatim as application/json」（`<script>`/`<img onerror>` 集合名原样存取、content-type 恒为 application/json）；`apps/web/src/features/workspace/WorkspacePage.test.ts` →「renders a markup-carrying collection name as inert text」（Vue 插值转义，DOM 中无 script/img，全局副作用未触发） | 新增 |
| 4 | SQL 注入 | 新增：`security-negative.integration.test.ts` → 注入 cursor 400（签名 HMAC 校验失败）；注入集合名原样落库（参数化查询实证）；注入 itemKey 被格式校验干净拒绝 400 且 `collection_item` 无行；注入后表结构与其他端点完好 | 新增 |
| 5 | SSRF | `apps/api/test/provider-adapter.test.ts` →「refuses provider redirects (SSRF guard)」「rejects result URLs whose origin is not the allowlisted provider」（重定向拒绝 + 结果 URL 源白名单，含 169.254.169.254 内网地址用例）（J04）；服务端无任何取任意 URL 的路径（全仓 fetch 调用点仅 provider-adapter，baseUrl 来自部署配置非用户输入）；BYOK 为浏览器直连不走服务器（W05：BYOK 请求不带 cookie、不碰 /api/*） | 既有（点名） |
| 6 | 上传绕过 | `apps/api/test/upload.integration.test.ts` → 不支持 MIME/超限声明 415/413；`apps/api/test/validate-image.test.ts` → 假 MIME/魔数/像素上限（M02）；`apps/api/test/precheck.integration.test.ts` → 隔离区未确认不可用（M04）；O03 新增：`security-negative.integration.test.ts` → 篡改 confirm sha256 → 400 HASH_MISMATCH 且哈希未被记录、正确哈希可重试确认；伪装 Content-Type（text/html）PUT 字节 → 415 且字节未落盘；`apps/api/src/infra/storage/storage.test.ts` → 路径穿越（`../`、绝对路径、伪造 bucket）全部抛 FORGED_OBJECT_PATH | 既有 + 新增（含 O03 修复的 confirm 哈希校验弱点） |
| 7 | 配额竞争 | `apps/api/test/quota.integration.test.ts` →「keeps concurrent reserves within the limit」「releases exactly once for failed tasks」「never releases quota for outcome_unknown or succeeded」（B05）；`apps/api/test/generation-create.integration.test.ts` → 同键并发创建配额只计一次（J01/J02）；O03 新增 `security-negative.integration.test.ts` → HTTP 层配额耗尽 429 QUOTA_EXCEEDED + 取消释放后重获取成功 | 既有 + 新增 |
| 8 | session 重放 | `apps/api/test/identity.integration.test.ts` →「rotates sessions: old token revoked」「revokes the session on logout」「expires sessions server-side」（过期/撤销均 401）（B03）；交叉所有权：`workbench-cancel.integration.test.ts`（A 的 session 操作 B 的任务 403）、`media-access.integration.test.ts`（签名属主与会话属主交叉 404） | 既有（点名） |
| 9 | 日志泄漏 | `apps/worker/test/observability.integration.test.ts` → 哨兵五值（签名密钥/provider key/提示词正文/session token/URL signature）× 原始/URL 编码/base64 三形态全链路无泄漏，且错误日志保留 correlationId/statusCode（O02）；O03 新增 `security-negative.integration.test.ts` → 集合名哨兵不进入任何请求日志（请求体不打日志的实证） | 既有 + 新增 |

## O03 期间修复的真实弱点

1. **confirm 不校验字节哈希**：`upload-service.ts` 原样记录客户端声明的 sha256（哈希事实可被伪造，
   会污染 `generation.input_sha256` 哈希链）。已修：confirm 时对真实字节做 sha256 比对，不符 →
   400 HASH_MISMATCH，会话不消耗可重试。
2. **错误 Content-Type 的 PUT 字节返回 500**：fastify 对无解析器的 Content-Type 抛 415，统一错误处理
   原先只映射 413。已修：415 → `UNSUPPORTED_MEDIA_TYPE`（`errors.ts`）。
