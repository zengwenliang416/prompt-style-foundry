# O06 CI 门禁与独立发布制品证据

## 结论

O06 通过。当前工作区在 `main @ 41254dd87282277b34c2c3bf9f29b1c2038e1211 + dirty` 完成完整 CI 等价验证、四个独立容器镜像和一个独立静态归档的构建、内容检查、checksum、manifest 与 Docker load 验证。发布制品的生成依赖验证 job；Woodpecker 只允许人工事件。本次没有 commit、push、registry push、部署、生产迁移或真实/付费 Provider 调用。

机器可读结果见 `release-artifacts.json`。

## 实现范围

- `.github/workflows/ci.yml`
  - `verify` 安装 Python、PostgreSQL 16、Node `22.23.0`、`npm ci` 和 Playwright Chromium，再执行完整 `scripts/ci-verify.sh`。
  - `service-image` 明确 `needs: verify`，以 `api|worker|web|static` matrix 独立构建和上传；每项上传归档、相对路径 checksum 与 manifest。
  - API matrix 在打包后复用 production image，让两个副本并发连接干净 PostgreSQL，验证 migration/import advisory lock、576 版本 catalog、managed readiness、`case-532` 单图 precheck/create/sidecar，以及 import 失败副本 fail-closed；不启动 Worker、不调用 Provider。
  - 两处 checkout 使用 `fetch-depth: 2`，保证 recovery 默认 `HEAD^` 可解析。
  - 使用稳定可解析的 `actions/checkout@v4`、`setup-node@v4`、`setup-python@v5`、`upload-artifact@v4`。
- `.woodpecker/deploy.yml`
  - 触发器仅为 `manual`；部署前以 PostgreSQL 16/Playwright 环境执行 `npm ci` 和完整验证，不再由 push 自动部署。
- `scripts/ci-verify.sh`
  - 纳入 compiler/library/design schema/已评审预览、Python tests/compile、JS syntax、`npm audit --audit-level=high`、lint、contract、类型、格式、build、unit、真实 PG integration、Chromium E2E。
  - CI 运行前后用 `scripts/fingerprint_paths.py` 比较生成目录，兼容既有 dirty 工作区但仍能拦截本次生成漂移。
- `scripts/build_library.py`
  - `generatedAt` 默认绑定只读 source manifest 的 `importedAt`（也支持 `SOURCE_DATE_EPOCH`），连续构建 fingerprint 相同，不再每次写入当前时间造成必然漂移。
- `Dockerfile` 与生产构建
  - API、Worker、Contracts 使用 `tsconfig.build.json` 排除 `*.test.ts`，构建前清空 `dist`。
  - API、Worker 分别从目标 workspace 依赖闭包安装 production packages，`scripts/prune-production-deps.mjs` 依据 lockfile 移除 dev/devOptional，再由 `npm prune --omit=dev` 清理 hoisted orphan；目标 Linux 镜像移除 Sharp 的 wasm32 fallback 及其孤儿依赖。测试/spec 文件与目录、source map、依赖包 Markdown、无关构建/Web 工具、悬空 symlink 均被移除；runtime manifests 不含 scripts/devDependencies，`npm ls --omit=dev --all --json` 的 `problems` 必须为空。
  - API production image 额外携带 importer CLI 所需的最小 catalog bundle：`public/data/catalog.json`、576 个 prompt TXT、`data/library/templates.json`；仅 `managed-generation` 启动链在监听前 migration/import，任一失败均退出，catalog-only/direct-byok 不产生 schema/catalog 写入。
  - API 不含 Worker、前端 HTML/assets/previews（只含上述 importer 数据）；Worker 不含 API/public；Web 含五页 Vite 构建；static 不含 Vite 构建；两个浏览器镜像都不含 Node 后端。
- 发布内容检查
  - `scripts/package-container-image.sh` 检查 image config/history 与项目 payload 凭据模式、许可证、服务边界、运行用户、依赖闭包、测试/spec/source-map/Markdown、悬空 symlink、环境/临时/私钥和预览命名，失败时不会导出归档。
  - `scripts/package-site.sh` + `scripts/create_static_artifact.py` 使用严格 allowlist、双层敏感内容检查、确定性 tar/gzip 元数据和便携 checksum。
  - `scripts/worktree_fingerprint.py` 对 Git 可见 tracked 与非忽略 untracked 文件的路径、类型、权限和内容计算确定性 SHA-256；dirty 镜像 tag 含前 12 位，完整值与 revision/dirty 写入 OCI labels 和 manifest。
  - `tests/test_static_artifact.py` 覆盖 allowlist、文档/临时/source-map/异常图片拒绝与凭据拒绝；`tests/test_worktree_fingerprint.py` 覆盖内容、路径、类型、determinism 与 ignored files 行为。
- 依赖安全
  - `sharp` 从 `0.34.5` 更新至 `0.35.4`（libvips `8.18.6`）以消除当时 `npm audit` 报告的 high advisory；最终 `npm audit` 为 0 vulnerabilities。

## 完整门禁验证

命令：

```bash
CI=true ONEPIC_PG_BIN=/opt/homebrew/opt/postgresql@16/bin bash scripts/ci-verify.sh
```

最终退出码 `0`，输出 `Repository verification passed.`：

- Python unittest：23 例通过；所有 tracked Python 可编译。
- npm audit：0 vulnerabilities。
- ESLint、跨层/契约 lint、OpenAPI validate、API 生成漂移、TypeScript、Prettier、workspace build：全部通过。
- unit：41 files / 291 tests。
- integration：26 files / 133 tests，真实临时 PostgreSQL 16。
- Playwright：44 tests，真实 Chromium。
- library/compiler 连续两次 fingerprint：`7f7a440a671e930174f3cf1b65b744047747dd0aebd6d90abb8cb5aa7f65cfd9`，完全一致。
- `python3 scripts/install_generated_previews.py --check`：已评审生成预览完整。

workflow 静态验证：

```bash
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest .github/workflows/ci.yml
npx prettier --check .github/workflows/ci.yml .woodpecker/deploy.yml
```

两条退出码均为 `0`。由于没有 push/部署授权，本次未在远端 GitHub-hosted runner 或 Woodpecker production runner 上实际触发 workflow；这不被伪装为远端执行证据。

## 制品结果

命令：

```bash
mkdir -p .tmp/z04-final-artifacts-v7
for target in api worker web static; do
  bash scripts/package-container-image.sh \
    "$target" ".tmp/z04-final-artifacts-v7/onepic-${target}-image.tar.gz"
done
bash scripts/package-site.sh .tmp/z04-final-artifacts-v7/onepic-static-site.tar.gz
```

最终制品：

| target                |                                                           image ID / 格式 |     bytes | SHA256                                                             |
| --------------------- | ------------------------------------------------------------------------: | --------: | ------------------------------------------------------------------ |
| API                   | `sha256:3b9a19a4c214f89df00bcf6b25317bbe86165461179741485a6c9ca9f2305aef` | 100211368 | `5878fedef5a6c0b1279f8a8859ed8903951177f4519972b71ee699384c192e99` |
| Worker                | `sha256:d0cdd47b9d6d6f0ac0412b17be66b1bfbda19f72470ca5cb9f9c1180495920ea` |  97102029 | `e0a93acb27867043fd5247ed1e353e87a3dab218d568ab8aa56e85ac1ab0ca3b` |
| Web                   | `sha256:a187162c25e292ef957cf66ad25a2e6dc6b21d19f35669decf473e55293d86c7` |  80158393 | `ee7183c430c781b032a2f18c7a6b6800b90762cf1fa069e0308c71f41e70db62` |
| static image          | `sha256:1660d5410257fe836db8e1d94bc0950e0c5f87e5e0c033c1bdeee5e5479f27e2` |  80095429 | `251e3aefd5899636778aa93b6f17d32ff266b864de5354b02a98fc50f5b448d8` |
| standalone static tar |                                     deterministic tar+gzip / 1203 members |  29154700 | `145f3555b08252be147b5223e6faed82b9b065c84410a4b6e5cf25dca21ce3a1` |

表中五制品来自 `.tmp/z04-final-artifacts-v7/`。构建时 dirty worktree SHA-256 为 `6ce80a41291f3b483eba147f951099bbc40c37c539b3aa07ff1608b84005c9d3`；四个 tag 含 `dirty-6ce80a41291f`，manifest 与 OCI labels 记录完整 revision/dirty/fingerprint。该 fingerprint 精确描述忽略测试缓存并同步运行文档后的制品构建瞬间 Git-visible 源快照；本报告、Z03/Z04 证据、清单和派生 HTML 在构建后落盘，因此当前 live worktree fingerprint 预期不同，不能用当前值冒充制品源值。
验证：

- 所有 `.sha256` 在制品目录执行 `shasum -a 256 -c` 均通过。
- 所有归档执行 `gzip -t` 通过。
- 四个 image tar 分别执行 `docker load -i` 成功，load 后 image ID 与 manifest 完全相同。
- 静态归档连续生成两次并执行 `cmp`，逐字节相同；checksum 文件只记录 basename，不含本机绝对路径。
- API/Worker production `node_modules` 实测分别为 43,303,236 / 39,475,923 bytes；测试/spec 目录、测试/spec 文件、source-map/Markdown 与 dangling symlink 计数均为 0，`npm ls --omit=dev --all --json` 的 `problems` 均为空，Sharp 1×1 PNG 解码/编码通过；`typescript`、`vite`、`rollup`、`esbuild`、`vue`、`@onepic/test-support` 均不存在。
- `npm run verify:local-stack` 退出码 0：默认 catalog-only 在空 PG 保持 schema 0 写入；PG/API/Worker/Web/static 健康、managed 双副本 migration/catalog 收敛、catalog 不完整时 HTTP 503/degraded、故障副本 fail-closed、`case-532` precheck/create/sidecar、五页深链接、静态独立、Worker SIGTERM 和容器/卷清理全部通过，外部 Provider 调用 0。

## 失败门禁实证

- 初始镜像检查发现 API/Contracts `dist` 含 `*.test.*`，打包退出码 1；通过生产 build tsconfig 修复，而非放宽检查。
- Z03 制品重建首次因 production API/managed-runtime/contracts 中存在 `*.js.map` 被 policy 拒绝；改为各 production `tsconfig.build.json` 显式 `sourceMap:false`、managed runtime clean build 后，四镜像重新打包并通过，未放宽制品检查。
- 生产依赖层首次 smoke 暴露 package/OpenAPI 源文件权限为 `0700`，API 因无法读取 managed-runtime exports 重启；修复镜像权限后完整本地栈通过。
- 第二次独立 Z03 审查发现 monorepo production install 携带约 400 MiB `node_modules`、测试与构建工具。改为 API/Worker 目标 workspace install + lockfile dev/devOptional pruning；第一次复验仍发现 `typescript` 的 `devOptional` 条目和 `.bin/tsc` 悬空 symlink，补齐规则后打包检查通过，而非忽略这些路径。
- 全文件系统凭据正则首次命中第三方 `jose` 的 PEM 解析常量和 Sharp WASM 二进制。最终策略仍扫描 image config/history 与所有项目 payload，同时用 lockfile integrity、`npm audit` 和依赖闭包约束第三方代码；不把第三方解析器常量误报为嵌入的项目凭据。
- 第三次独立审查指出 readiness body 虽为 degraded 但 HTTP 仍为 200，Compose 会 fail-open。修复为 PG/schema/catalog 不完整时 HTTP 503，OpenAPI/Fastify schema 同步；managed smoke 临时把 release count 改为 575，两个副本均 503/degraded，恢复后重新 ready。
- 同次审查发现 `npm ls` 的 workspace manifest 语义与 test 目录检查口径不足；runtime manifests 改为只保留运行字段，所有 test/spec/testing 目录由打包脚本阻断。下一轮审查又发现 npm 10 对 extraneous 仍可退出 0，最终追加 `npm prune`、移除 Linux 无用 Sharp wasm32 孤儿，并解析 `npm ls --json` 强制 `problems=[]`；最终 API/Worker 分别降至约 43.3/39.5 MB node_modules。
- 最终审查发现装配层错误把 OIDC client secret 用作媒体/cursor HMAC，而受强度校验的 `SESSION_SECRET` 未被使用。`buildApp` 现只以 `SESSION_SECRET` 作为应用签名 key，并将其纳入 managed identity 完整配置；装配测试证明 session-secret 签名有效而 OIDC-secret 签名被拒绝。
- W06 真实调用前发现原 ProviderAdapter 自定义 JSON 并非 OpenAI-compatible image edits 契约；改为单图 multipart 后，标准 FormData 又把 prompt LF 改成 CRLF，导致不可变 prompt hash 回归失败。最终使用自构造 multipart bytes，同时满足真实 Provider 兼容和 sent prompt hash 追溯；单次授权真实调用 PASS，随后重跑全量 CI、本地栈与 v6 制品。
- 向 `public/` 临时加入 `o06-artifact-negative.tmp` 的负例首次暴露 shell `! pipeline` 的 `errexit` 盲点；改为显式 `if ...; then exit 1` 后重跑，容器打包按预期失败且目标归档不存在。临时文件已删除，随后正常四制品全部重新生成并验证。
- 静态 Python policy tests 分别证明 `notes.md`、`*.tmp`、异常 `*.webp`、source map 和高置信凭据内容会被拒绝，错误不回显凭据值。

## 受影响回归

W06 ProviderAdapter multipart 改动后重新运行 `npm run benchmark:capacity`，O04 全部 14 项容量预算通过：队列 8/8 并发、320/320 终态、外部 Provider 调用 0；完整 CI 为 Python 23、unit 41/292、integration 26/133、recovery 和 Chromium E2E 44；`verify:local-stack` 也已复跑。详细数值见 `../o04/capacity-report.md`。

## 残余边界

- 未执行远端 CI、镜像 registry push 或部署；这些需要 push/deploy 单独授权。
- W06 已在用户明确单次付费授权下完成 1 次真实 Provider 请求并通过；证据见 `../w06/real-provider-report.md`。未执行第二次请求。
- 容器制品依赖镜像层构建元数据，不宣称不同 Docker daemon/平台可逐字节复现；独立静态 tar 已验证逐字节复现。
- O07 迁移/备份/恢复/回滚演练已完成并纳入 CI；详见 `../o07/recovery-report.md`。生产迁移与恢复仍需逐次授权。
