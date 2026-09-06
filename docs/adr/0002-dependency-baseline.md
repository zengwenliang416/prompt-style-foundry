# ADR 0002：依赖版本与包管理基线

- 日期：2026-09-06
- 状态：已接受（当前基线已验证；目标栈为拟定，实施 F01 时复核）
- 关联清单项：D05

## 背景

清单 D05 要求确定受支持依赖版本、包管理器、lockfile、许可与命令清单，且不得把推荐技术当已有依赖。本 ADR 区分「当前已验证基线」与「目标栈拟定版本」两类事实。

## 决策

### 当前已验证基线（2026-09-06 实测）

| 项 | 基线 | 实测环境 | 依据 |
|---|---|---|---|
| Node.js | `>=20`（package.json engines） | v22.19.0 | Node 22 为 LTS 线，满足 engines |
| 包管理器 | npm（随 Node 分发） | npm 10.9.3 | 项目无 workspace 需求，不引入 pnpm/yarn |
| JS 运行时依赖 | 无（静态站本身零依赖） | package.json dependencies 为空 | anime.js 为 vendored 静态资产，不经 npm |
| JS lockfile | 已建立（F01） | package-lock.json，151 个锁定包，`npm ci` 实测通过 | F01 引入 workspace 后按本 ADR 计划生成并验证 |
| Python | `>=3.11`（package.json engines） | 3.14.4 | 编译器脚本仅用标准库 |
| Python 依赖 | `Pillow>=10.0`（requirements-dev.txt） | Pillow 12.1.1 / pip 26.0.1 | 仅预览安装脚本需要 |
| 命令清单 | `npm run dev/build/validate/test/check` | 全部退出码 0（D01 证据） | package.json scripts |

### 目标栈拟定版本（F01 实施时已按 2026-09-06 npm 注册表复核并采纳）

| 层 | 采纳版本（F01 实装） | 复核依据（npm view，2026-09-06） |
|---|---|---|
| 运行时 | Node.js 22 LTS（v22.19.0 实测） | 各依赖 engines 声明 `^20.19.0 \|\| >=22.12.0` 均满足 |
| 前端 | vue ^3.5.42、typescript ^5.9.3、vite ^7.3.6、@vitejs/plugin-vue ^6.0.8、vue-tsc ^3.3.11 | vite 7.3.6 为 Vite 7 线最新（Vite 8 已出但超出本 ADR 记录依据，且 7 线在维护；升级另行决策）；plugin-vue peer 支持 vite ^7、vue-tsc peer 支持 ts >=5.0 |
| API | fastify ^5.12.3 | Fastify 5 官方要求 Node v20+ |
| 契约 | @onepic/contracts（TS 类型先导，OpenAPI 3.1 源由 F05 建立） | 目标架构 §3 |
| 数据库 | PostgreSQL 16 | 本机已具备 psql 16 客户端；服务端实例属 F04 测试设施范围 |
| 队列/存储 | PG job 表、S3 兼容私有存储 | ADR 0001 D-3、目标架构 §3 |

许可复核（F01 实测）：对 node_modules 全量 package.json 扫描——MIT×84、Apache-2.0×1（typescript）、ISC×6、BSD-3×5、BSD-2×1；无 GPL/SSPL 类；17 个无 license 字段的命中均为包内部子目录清单或测试夹具（父包均为 MIT），无真实违规。

许可政策：新增依赖仅接受 MIT/Apache-2.0/BSD/ISC 类宽松许可，引入前逐条核对；GPL/SSPL 类不进入运行时依赖。例外（M02，2026-09-06）：`sharp`（Apache-2.0）以预编译二进制动态链接 libvips（LGPL-3.0）——按社区标准实践视为未污染（无源码改动、动态链接、可替换），系图像解码唯一成熟选型；该例外与残余风险记入 Z04 交付清单，如不可接受可替换为独立解码服务。

### 干净安装验证计划（F01 门禁，已执行）

1. 新 venv：`python3 -m venv` 后 `pip install -r requirements-dev.txt`，跑 `npm run check`。（D06 加固轮已实测：venv 干净安装后 ci-verify 全量退出码 0；F01 复用该 venv 路径复跑通过）
2. JS 依赖引入后：删除 `node_modules`，`npm ci`（非 `npm install`）复现，跑构建与测试。（F01 已实测：`rm -rf node_modules && npm ci` 退出码 0，`npm run build:workspaces` 五包全部构建通过）
3. 锁定版本以 lockfile 为唯一事实来源；CI 使用相同命令。（package-lock.json 已生成）

## 后果

- 当前静态流水线不需要任何 npm 依赖与 lockfile；这不构成对 F01 引入依赖的豁免。
- 目标栈版本在实施前均为「拟定」，验收时以官方文档复核结果为准更新本 ADR。
