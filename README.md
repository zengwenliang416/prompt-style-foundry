# 一图万式 · OnePic Template Studio

一个从零搭建的、独立的单图视觉提示词模板项目。

它不会修改上游仓库，也不是上游项目的分支或换皮版本。导入脚本把上游 ZIP 当作**只读素材源**，抽离其中的规范化提示词，再通过本项目自己的单图协议编译为可直接使用的 `[System / Prompt]` 模板。

## 当前内容

- 529 条案例视觉蓝图 + 47 条框架提示词，共 576 条单图模板
- 576 个独立 TXT 提示词文件
- `public/previews/` 中 529 个 case 预览和 41 个已评审 framework 预览；`data/generated-previews/` 保留 493 个已评审生成预览及 45 个 sidecar
- 可独立部署的原 `public/` 静态目录
- Vue 3 / TypeScript 五页前端：总览、发现、工作台、工作区、指南
- Fastify API、PostgreSQL job queue、独立 Worker 和受控 Provider adapter
- 完整来源、作者、链接、内容哈希、生成 attempt 与输入/结果对象追踪

所有模板都遵循同一套核心原则：

> 上传图片决定“画什么”；模板蓝图决定“怎么画”。

用户只需要在 Nano Banana Pro 中上传一张图片并粘贴模板，不需要填写标题、品牌、地点、比例、第二张参考图或其他变量。

## 与上游项目的边界

本项目没有复用上游的网页、React 组件、API、支付、账户、数据库、分析脚本或品牌视觉。

上游只提供两类只读素材：

1. `data/cases.json` 中的案例提示词；
2. `docs/templates.md` 中的框架提示词代码块。

本项目单独实现了：

- 单图 Prompt Protocol
- 分类适配规则
- 模板编译器
- 缺失输入自动解析规则
- 原比例继承规则
- 示例内容隔离规则
- 多面板单图一致性规则
- 独立数据模型与静态检索界面
- 来源追踪与校验脚本
- Vue 五页应用与三种运行模式（catalog-only / direct-BYOK / managed-generation）
- OpenAPI 3.1 契约、生成客户端、Fastify API、PostgreSQL migrations
- opaque session、对象级授权、配额/并发限制、审计与删除清单
- PG job lease/heartbeat/CAS/dead-letter Worker、受控 Provider allowlist
- 私有对象存储端口与 phase-one `LocalDiskStorage` 实现

## 目录结构

```text
onepic-template-studio/
├── apps/
│   ├── web/                         # Vue 五页前端
│   ├── api/                         # Fastify API/BFF 与 SQL migrations
│   └── worker/                      # PG job consumer、清理与删除清单重放
├── packages/
│   ├── contracts/                   # OpenAPI 3.1、错误码与状态机
│   ├── client/                      # 由契约生成/校验的浏览器客户端
│   ├── managed-runtime/             # Provider、图片校验和存储适配器
│   └── test-support/                # 隔离 PG / provider 测试工具
├── public/                          # 可独立部署的原静态目录
│   ├── data/catalog.json
│   ├── data/prompts/                # 576 个最终 prompt
│   └── previews/
├── data/
│   ├── source/                      # 从上游 ZIP 只读抽离的 canonical 数据
│   ├── library/templates.json       # 完整规范化模板库（生成）
│   └── generated-previews/          # 已评审生成预览与 sidecar
├── scripts/                         # import/build/validate/CI/capacity/recovery
├── ops/nginx/
├── docs/
├── third_party/
├── Dockerfile / compose.yaml
├── NOTICE.md / LICENSE / AGENTS.md
└── package.json
```

## 本地运行

### 原静态目录（不需要后端）

项目已包含生成数据，不需要重新导入 ZIP：

```bash
npm run dev
# 或 python3 scripts/serve.py
```

打开 `http://127.0.0.1:4173`。这是原 `public/` 目录，API 关闭时仍可浏览、筛选和复制 prompt。

### 五页应用与本地受控栈

```bash
npm run verify:local-stack
```

该命令构建并启动临时 PostgreSQL 16、API、Worker、Vue Web 和独立 static target，验证五页深链接、health、静态独立运行与 Worker 优雅停机，完成后自动清理。默认是 `catalog-only`，不会调用 Provider。手工启动和环境变量见 [本地栈操作说明](docs/operations/local-stack.md)。

直接启动 Vue 开发服务器：

```bash
npm run dev -w @onepic/web
```

需要受管 API 时必须先按 `apps/api/.env.example`、`apps/worker/.env.example` 配置可信 OIDC、session secret、数据库、私有存储和 allowlisted Provider；未配置身份源时 `managed-generation` 会拒绝启动。

## 使用模板

1. 在模板库中搜索目标视觉风格。
2. 点击卡片查看完整模板。
3. 点击“复制提示词”。
4. 打开 Nano Banana Pro。
5. 上传一张图片。
6. 粘贴提示词并生成。

完整提示词也可以直接从以下目录读取：

```text
public/data/prompts/
```

例如：

```text
public/data/prompts/case-532.txt
public/data/prompts/framework-001.txt
```

## 三种运行模式

五页应用的生图设置提供：

1. **catalog-only**：只浏览目录和复制 prompt，不上传图片。
2. **direct-BYOK**：用户明确点击生成后，浏览器把单图和编译 prompt 直发到用户配置的 OpenAI-compatible endpoint；Key 只存 localStorage，不进入导出、不转发到 OnePic API。
3. **managed-generation**：用户明确点击后，第一方 API 使用 opaque session、对象级授权、配额/并发限制、私有对象存储和 PostgreSQL job；Worker 只向 allowlist Provider 发送，Provider key 由服务端 secret 注入，禁止任意 baseUrl 转发。

模式切换会重新说明数据去向，不会自动迁移 BYOK Key。`catalog-only` 与 `direct-BYOK` 不依赖账号；`managed-generation` 未配置可信 OIDC 时拒绝运行。

当前自动化继续使用本地 mock/simulator 做常规回归；另在用户明确授权最多 1 次付费请求后，已用 `motion-cover` 的 `gpt-image-2/high` 完成一次真实单图 managed 全链路验证，真实请求恰好 1 次，像素、下载 bytes、哈希和 sidecar 均匹配。该结果只证明一个 Provider/模型/质量/PNG/模板的最小兼容性，不能外推为并发、全格式、S3 或生产部署证明；详见 [W06 证据](docs/design/evidence/w06/real-provider-report.md)。

## 从上游 ZIP 重新导入

仅在上游素材更新时执行。该脚本直接读取 ZIP，不解压覆盖上游目录，也不会写入 ZIP。

```bash
python3 -m pip install -r requirements-dev.txt
python3 scripts/import_source.py /path/to/awesome-gpt-image-2-main.zip
python3 scripts/build_library.py
python3 scripts/validate_library.py
```

或：

```bash
make import-source SOURCE_ZIP=/path/to/awesome-gpt-image-2-main.zip
make check
```

## 数据模型

每条模板包含：

- `id`：独立模板编号
- `kind`：`case` 或 `framework`
- `title`：模板名称
- `category`：类别
- `styles` / `scenes` / `tags`：检索标签
- `mode`：单幅、多面板、信息图、界面、海报等
- `blueprintInputMode`：原始蓝图属于 `text-to-image`（文生图）或 `image-to-image`（图生图）
- `language`：无文本线索时的默认文字语言
- `requiresText`：模板是否通常需要文字
- `blueprint`：上游视觉蓝图
- `prompt`：本项目编译后的完整单图提示词
- `source`：作者、链接、许可与来源行号
- `blueprintSha256` / `promptSha256`：内容校验值

完整说明见 [docs/data-model.md](docs/data-model.md)。

## 单图协议的关键覆盖规则

编译后的提示词明确规定三层优先级：

1. 上传图片决定内容、人物、产品和场景；
2. 专属视觉蓝图决定风格、构图语言和质感；
3. 本项目的单图公共规则覆盖蓝图里的固定人物、品牌、地点、文案和比例。

因此，上游案例中的 `LIMORA`、`[COUNTRY]`、固定人物、固定产品、固定标题、9:16 等内容都只作为低优先级示例，不需要用户填写，也不能替换上传图片。

`blueprintInputMode` 只描述上游蓝图原本是否依赖外部视觉输入，例如上传图片、原图、参考图、扫描文档或已提供的角色。当前 576 条蓝图中，501 条归为文生图蓝图，75 条归为图生图蓝图；无论原始类型如何，公开提示词都已经统一编译成“一张上传图片决定内容”的图生图模板。

## 验证

模板编译器/静态包：

```bash
npm run check
```

完整仓库门禁（需要 PostgreSQL 16 与 Playwright Chromium）：

```bash
CI=true ONEPIC_PG_BIN=/path/to/postgresql-16/bin bash scripts/ci-verify.sh
```

完整门禁覆盖：

- 576 模板数量、唯一 ID、来源、单图协议和 576 个 prompt 正文/hash
- 529 case preview、493 reviewed generated preview 与 45 个 sidecar
- Python compile/tests、JS syntax、npm audit、lint、契约/OpenAPI drift、typecheck、format、workspace build
- unit、真实临时 PostgreSQL integration、backup/restore/deletion replay、Chromium E2E
- 生成路径 fingerprint，阻断手改 generated 文件或构建漂移
- `NOTICE.md`、`LICENSE` 与 third-party licenses

容量、本地栈、发布制品和恢复演练分别见：

- [容量压测](docs/operations/capacity-testing.md)
- [容器与本地栈](docs/operations/local-stack.md)
- [发布制品](docs/operations/release-artifacts.md)
- [迁移、备份、恢复与回滚](docs/operations/recovery-runbook.md)

## 发布边界

可分别生成五种独立制品：

```bash
mkdir -p dist/release
bash scripts/package-container-image.sh api dist/release/onepic-api.tar.gz
bash scripts/package-container-image.sh worker dist/release/onepic-worker.tar.gz
bash scripts/package-container-image.sh web dist/release/onepic-web.tar.gz
bash scripts/package-container-image.sh static dist/release/onepic-static-image.tar.gz
bash scripts/package-site.sh dist/release/onepic-static-site.tar.gz
```

- `api`、`worker`、Vue `web`、原 `public/` static image 彼此独立；API 只额外携带启动时幂等导入所需的不可变 catalog/prompt bundle，不包含 Web 页面。
- standalone static tar 使用严格 allowlist、规范化 metadata 和无时间戳 gzip，可逐字节复现；所有 manifest 记录 revision、实测 dirty 状态和 Git-visible worktree SHA256，dirty 构建不会只靠 HEAD 冒充可追溯来源。
- GitHub Actions 在 pull request / `main` push 时先运行完整 verify，再构建四镜像制品；本地已用 actionlint 和等价命令验证，但当前工作未获 push 授权，未声称远端 CI 已运行。
- Woodpecker 只接受 `manual` 事件，部署前再次执行完整验证；生成/下载制品不等于获准部署。
- commit、push、registry push、deploy、生产 migration、付费 Provider 调用均需逐项单独授权。

具体命令、manifest/checksum 校验和不应进入制品的路径见 [发布制品操作说明](docs/operations/release-artifacts.md)。原 `public/` 目录仍可直接发布到任意静态托管，不需要 API、数据库或运行时密钥；这不代表 managed-generation 后端已部署。

## 许可与来源

本项目代码采用 MIT License。上游提示词蓝图、预览素材与 vendored Anime.js 的许可及来源说明见 [NOTICE.md](NOTICE.md) 和 `third_party/`。
