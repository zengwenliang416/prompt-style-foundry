# W06 真实 Provider 最小单图验证

- 日期：2026-09-08
- 结论：**PASS**
- 用户授权：明确授权最多 1 次真实付费生图请求
- 实际 Provider 请求：**1**
- Provider：`motion-cover` / `https://new-api.motion-cover.com`
- 模型：`gpt-image-2`，`quality=high`
- 模板：`case-409`，version 1

## 授权与调用边界

在调用前，用户明确选择“授权一次调用”，范围限定为：最多 1 次真实生图请求，只验证像素、哈希与 sidecar，不部署、不提交、不执行生产迁移。

凭据仅保存在被 `.gitignore` 排除的 `.tmp/w06-provider.env`，验证脚本从本机文件读入内存。报告和 `/tmp/onepic-w06-real-provider.log` 均逐字节检查不含该 key。脚本通过 `ONEPIC_W06_PAID_AUTHORIZED=YES_ONE_REQUEST` 显式门禁，并用计数 fetch 在第二次请求前强制失败。

调用前只执行了不产生图片的 `GET /v1/models` 能力探测，HTTP 200，返回 26 个模型；其中包含 `gpt-image-2`。真实图片 endpoint 只请求一次。

## 兼容修复与调用前验证

真实 OpenAI-compatible image edits 使用 `multipart/form-data`。此前共享 `ProviderAdapter` 发送自定义 JSON，不足以证明真实 Provider 兼容；W06 调用前已修复为：

- `POST /v1/images/edits`
- Bearer key 仅发往 server-owned allowlist origin
- multipart 字段：`model`、`quality`、`prompt`、`n=1`、`size=auto`、`response_format=b64_json`、单个 `image` 文件
- 自行构造 multipart bytes，避免标准 `FormData` 把 prompt 的 LF 规范化为 CRLF，保持“发送 prompt 与不可变 snapshot 哈希一致”
- 继续禁止 redirect，保留 timeout/outcome_unknown、SSRF 和凭据隔离规则

调用前验证：

- managed-runtime 与 API Provider adapter unit：11/11 通过
- Worker `execute` + workbench flow PostgreSQL integration：8/8 通过
- 隔离 loopback mock 全链路预演：上传 → 预审 → 生成提交 → Worker claim/execute → 下载 → sidecar，Provider 请求严格为 1，PASS；该预演不计作 W06
- 未设置显式授权变量时，脚本在建立数据库和发起网络请求前拒绝执行

## 真实单图结果

输入是脚本本地生成的单张非私密 PNG 测试图，不包含用户图片或文本输入：

- MIME：`image/png`
- 512 × 320
- 5030 bytes
- SHA-256：`d3756d7e30daf0586b69c2b7ff62ea2669cece458fb76c320b9b43912be55231`

真实 Provider 输出：

- 解码成功：是
- MIME：`image/png`
- 1600 × 983
- 881388 bytes
- orientation：1，横向方向与输入一致
- SHA-256：`fdbb25ca07f530444dd8fa10091162a72f0609a51ba12746e799c1dba0593961`

API generation result 的 MIME、bytes、width、height、SHA-256 与实际下载 bytes / Sharp 解码结果完全一致。Sidecar `schemaVersion=1.0.0`、`kind=onepic-generation-sidecar`，且：

- input hash 匹配
- compiled/effective prompt hash 均匹配 `case-409` 公共 prompt
- result hash 匹配下载结果
- 下载 bytes 与数据库/API metadata 匹配

机器证据：`docs/design/evidence/w06/real-provider-report.json`。

## 残余风险

- Provider 输出保持横向 orientation，但 `1600/983` 相对输入 `512/320` 的宽高比偏差约 **1.7294%**。公共 prompt 已明确要求保持源图比例和方向，本次 `size=auto` 的真实结果证明方向保持、比例近似但非逐像素完全相同；未获第二次付费调用授权，不做额外请求。该事实作为 Provider 行为限制保留，不虚报精确比例。
- 本次只证明该 allowlisted Provider、`gpt-image-2/high`、一个 PNG 和一个模板的最小兼容性，不代表所有模型、质量、格式、并发、S3 或生产网络均已验证。
- 使用临时 PostgreSQL 与 phase-one `LocalDiskStorage`，未执行生产迁移、部署、registry push、commit 或 push。
