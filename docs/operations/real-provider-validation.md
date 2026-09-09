# 真实 Provider 最小单图验证

该流程只用于清单 W06。它会产生真实图片请求和费用，默认拒绝运行；mock、simulator、模型列表探测和 queued-only smoke 均不能替代 W06。

## 前置条件

1. 用户针对本次调用明确授权，并约定最大请求数。
2. Provider 是服务端 allowlist origin，使用 HTTPS，不接受请求参数提供任意 base URL。
3. 在 Git-ignored、仅当前用户可读的 `.tmp/w06-provider.env` 配置：

```bash
WORKER_PROVIDER_ID=provider-id
WORKER_PROVIDER_BASE_URL=https://provider.example.com
WORKER_PROVIDER_API_KEY=从本机 secret manager 或安全输入写入
WORKER_PROVIDER_MODELS=gpt-image-2:high
```

不要把真实 key 写入文档、命令历史、日志、截图或聊天。可使用本地隐藏输入脚本 `.tmp/configure-w06-provider.sh`；该辅助文件不属于发布制品。

## 调用前验证

先运行不触发真实图片的检查：

```bash
npm run build:workspaces
npm run test:unit
ONEPIC_PG_BIN=/path/to/postgresql16/bin npm run test:integration
```

`verify-real-provider.mjs` 还支持 loopback 预演，但 `ONEPIC_W06_ALLOW_LOOPBACK_TEST=true` 只允许 HTTP loopback，预演结果不得勾选 W06。

未设置付费授权门禁时，以下命令必须在建库和网络调用前失败：

```bash
npm run verify:real-provider
```

## 单次真实验证

只有取得当次授权后才执行：

```bash
export ONEPIC_W06_PAID_AUTHORIZED=YES_ONE_REQUEST
export ONEPIC_PG_BIN=/path/to/postgresql16/bin
npm run verify:real-provider
```

默认行为：

- 使用 `case-409` 的公共不可变 prompt 和单张脚本生成 PNG；无用户私图、无必填文本。
- 在临时 PostgreSQL 和隔离 `LocalDiskStorage` 中走 API upload/confirm/precheck/create、Worker claim/execute、下载和 sidecar 全链路。
- 使用 counted fetch；第二次 Provider 请求会在发送前被拒绝。
- Provider endpoint 为 `/v1/images/edits`，请求是标准 multipart：单个 `image` 加 model/quality/prompt/n/size/response_format。
- multipart prompt 以原始 UTF-8 bytes 写入，不把 LF 改成 CRLF；attempt hash 必须对应不可变 snapshot。
- 结果必须通过真实图片解码，并与 generation metadata、下载 bytes、input/prompt/result hashes 和 sidecar 相互核对。
- 临时数据库和媒体目录在结束后删除；报告不含 prompt body、图片正文或密钥。

默认报告：

```text
docs/design/evidence/w06/real-provider-report.json
```

失败时不自动再次调用。若已发送一次请求，任何重试都必须重新取得单独付费授权。

## 已知范围

该测试只证明一个 allowlisted Provider、一个模型/质量、一个 PNG 和一个模板的最小兼容性。它不证明多模型、并发吞吐、全部输入格式、真实 S3、生产 PostgreSQL、TLS 终止或部署环境。
