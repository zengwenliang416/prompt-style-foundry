# CI 门禁与发布制品操作说明

## 目的与边界

O06 将验证、打包和部署分开：GitHub Actions 只在完整验证通过后生成可下载制品；Woodpecker 生产流程只接受 `manual` 事件。生成制品不等于获准部署，`commit`、`push`、镜像推送、生产迁移和生产部署仍需分别授权。

五种制品彼此独立：

- `api`：API 运行时代码、migrations、Contracts/OpenAPI、共享 managed runtime、按 API 依赖闭包裁剪的生产依赖，以及只供 managed 模式幂等 catalog import 使用的 `public/data/catalog.json`、576 个 prompt TXT 和 `data/library/templates.json`；不含 Worker、Web 页面/资产、测试、source map 或依赖包 Markdown。
- `worker`：Worker、Contracts、共享 managed runtime 和按 Worker 依赖闭包裁剪的生产依赖；不含 API、Web/public、测试、source map、依赖包 Markdown 或悬空 workspace symlink。
- `web`：五页 Vue 构建与按需使用的 public 目录数据；不含 Node 后端。
- `static`：原 `public/` 独立静态目录；不含五页 Vue 构建和 Node 后端。
- `standalone-static-site`：确定性 `tar.gz` 静态目录归档，适合不依赖 API 的传统静态部署。

所有制品必须包含 `NOTICE.md`、项目许可证及两个第三方许可证。打包检查拒绝环境文件、私钥、临时文件、source map、非规范预览文件名和高置信凭据模式；API/Worker 只安装目标 workspace 依赖，按 lockfile 移除 dev/devOptional，再执行 `npm prune --omit=dev` 清理 hoisted orphan，并为目标 Linux 镜像移除 Sharp wasm32 fallback 及其孤儿依赖；测试/规格文件与目录、依赖包 Markdown、source map、无关构建/Web 依赖和悬空 symlink 均不得存在。runtime manifests 只保留运行字段，`npm ls --omit=dev --all --json` 的 `problems` 必须为空；运行时以非 root `node` 用户启动。凭据检查覆盖镜像配置/history 和项目 payload；第三方依赖由 lockfile integrity 与依赖审计约束，不把依赖源码中的密钥格式解析常量误报为项目凭据。检查不替代密钥轮换或人工安全审查。

## CI 门禁

GitHub workflow：`.github/workflows/ci.yml`。

`verify` job 在 Ubuntu 24.04 上执行：

1. 安装 Python 依赖、PostgreSQL 16、Node `22.23.0`、npm lockfile 依赖和 Playwright Chromium。
2. 执行 `scripts/ci-verify.sh`：编译器、library/schema/预览校验、Python tests/compile、JS syntax、npm 高危审计、ESLint、OpenAPI lint 与生成漂移、TypeScript、格式、全部 workspace build、unit、真实 PG integration、Chromium E2E。
3. CI 模式在生成前后对生成路径计算内容/路径 fingerprint；任一生成器产生漂移即失败。
4. 只有 `verify` 成功，`service-image` matrix 才分别构建 `api|worker|web|static` 镜像。API 项还复用 production image 启动两个并发副本，验证 migration/import advisory lock、576 版本、`case-532` HTTP precheck/create/sidecar、managed readiness 以及故障副本 fail-closed；Worker 不启动，Provider 调用为 0。任何矩阵项检查失败就不上传该项制品。

本地等价验证：

```bash
npm ci
python3 -m pip install -r requirements-dev.txt
npx playwright install chromium
CI=true ONEPIC_PG_BIN=/path/to/postgresql-16/bin bash scripts/ci-verify.sh
```

macOS Homebrew PostgreSQL 16 常用路径：

```bash
CI=true ONEPIC_PG_BIN=/opt/homebrew/opt/postgresql@16/bin bash scripts/ci-verify.sh
```

## 构建并校验静态归档

```bash
bash scripts/package-site.sh .tmp/release/onepic-static-site.tar.gz
(
  cd .tmp/release
  shasum -a 256 -c onepic-static-site.tar.gz.sha256
)
tar -tzf .tmp/release/onepic-static-site.tar.gz | less
```

输出：归档、便携相对路径 `.sha256`、`.manifest.json`。`scripts/create_static_artifact.py` 使用严格路径 allowlist、归一化 owner/mode/mtime 和无时间戳 gzip；同一 public 内容和 `SOURCE_DATE_EPOCH` 会产生逐字节一致的归档。默认 epoch 为 `0`。

归档 manifest 同样记录 Git revision、实测 dirty 状态和 Git-visible worktree SHA256。它证明该本地制品对应哪一份实际源树；`revision` 单独不足以标识 dirty 构建。

## 构建并校验独立镜像

```bash
for target in api worker web static; do
  bash scripts/package-container-image.sh \
    "$target" ".tmp/release/onepic-${target}-image.tar.gz"
  (
    cd .tmp/release
    shasum -a 256 -c "onepic-${target}-image.tar.gz.sha256"
  )
done
```

脚本会：

1. 计算 Git-visible worktree fingerprint；覆盖 tracked 与非忽略 untracked 文件的路径、类型、内容和 symlink target，只把 SHA256 写入标签/manifest，不输出正文。dirty 默认镜像 tag 同时包含 fingerprint 短值。
2. 从对应 Docker target 构建镜像，OCI label 记录 Git revision、dirty 状态和完整 worktree SHA256。
3. 检查镜像配置/history 与项目 payload 无高置信凭据，检查许可证、服务边界、运行用户、依赖闭包、测试/spec/source-map/Markdown 清理和禁入文件。API 镜像额外核验 catalog import CLI、576 prompt 与 `case-532`。
4. 用 `docker save | gzip -n` 导出，不执行 registry push。
5. 生成相对路径 checksum 和机器可读 manifest（target、revision、dirty、worktree SHA256、image ID、文件 SHA256、字节数、验证状态）。
验证归档可以被 Docker 读取：

```bash
docker load -i .tmp/release/onepic-api-image.tar.gz
```

`docker load` 只写本机 Docker image store，不会推送外部 registry。

## 失败语义

- `scripts/ci-verify.sh` 任一命令非零，workflow `verify` 失败，后续 image jobs 不运行。
- `package-site.sh` 先扫描 public 源，再由 Python allowlist 二次校验；失败时不移动临时归档到目标路径。
- `package-container-image.sh` 任一镜像内容检查失败时，不执行 `docker save`，不会生成可发布归档或成功 manifest。
- checksum 必须在归档所在目录校验，因为 checksum 文件有意只记录 basename，避免 runner 绝对路径污染制品。

## 部署门禁

`.woodpecker/deploy.yml` 在 `main` push 时只执行 `verify-and-package`，`deploy-production` 步骤通过 `event: manual` 单独门禁；人工触发时会先重复完整验证和静态归档检查，再进入部署。触发人工 workflow 或实际运行 `ops/woodpecker/deploy.sh` 都属于生产部署，必须先取得该次部署的明确授权。普通 push CI 不部署、不执行生产 migration。

## 证据

- 人类可读报告：`docs/design/evidence/o06/release-report.md`
- 机器可读报告：`docs/design/evidence/o06/release-artifacts.json`
- 本地栈/停机：`docs/design/evidence/o05/local-stack-report.md`
- Sharp 升级后容量复跑：`docs/design/evidence/o04/capacity-report.md`
