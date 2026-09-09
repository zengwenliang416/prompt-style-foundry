# Z01 全量回归与模板抽查证据

## 结论

Z01 通过。当前工作区完成 Python/compiler、全 576 模板与 prompt、评审预览、Contracts、lint/type/build、unit、真实 PG integration、O07 recovery、Chromium E2E、静态服务、许可证、容器/本地栈、容量和发布制品回归；13 个分类各抽查一个模板，`case-532` 与 `framework-001` 单独覆盖。真实/外部 Provider 调用仍为 0。

机器证据：`final-regression.json`。

## 全量命令

```bash
CI=true ONEPIC_PG_BIN=/opt/homebrew/opt/postgresql@16/bin bash scripts/ci-verify.sh
npm run check
```

结果：

- `scripts/ci-verify.sh`：退出码 0，`Repository verification passed.`
- Python unittest 22；unit 40 files / 286 tests；integration 26 files / 131 tests；O07 recovery passed；Playwright 44 tests。
- `npm run check`：退出码 0；重新构建 576 模板，安装并校验 493 个 reviewed generated previews 与 45 个 prompt sidecars，Python 22 例通过。
- library：576（529 case + 47 framework），ID 全唯一；`public/data/prompts/*.txt` 576 个，全部正文、顺序和 SHA256 与 full library/catalog 一致。
- public previews：570（529 case 文件名 + 41 framework 文件名）；所有 case preview 存在，reviewed preview/sidecar check 通过。
- 静态包重建 SHA256 仍为 `145f3555b08252be147b5223e6faed82b9b065c84410a4b6e5cf25dca21ce3a1`。
- `NOTICE.md`、`LICENSE`、anime.js 与上游 MIT license 均存在且非空。

## 分类抽查

每个样本实际检查：prompt 以 `[System / Prompt]` 开始，包含单图优先级、不得追问、保持原始比例/方向、Nano Banana Pro、`BEGIN/END VISUAL BLUEPRINT`、示例主体/品牌/地点/文字不得替换上传图、仅返回完成图；prompt 文件正文和 SHA256 与 library 一致。

| 分类                       | 样本                                        | mode         | blueprint input |
| -------------------------- | ------------------------------------------- | ------------ | --------------- |
| Architecture & Spaces      | `framework-027` 建筑与空间 · 常规模板       | single-scene | text-to-image   |
| Brand & Logos              | `framework-021` 品牌与标志 · 常规模板       | single-scene | text-to-image   |
| Characters & People        | `framework-034` 人物与角色 · 常规模板       | portrait     | text-to-image   |
| Charts & Infographics      | `framework-005` 图表与信息可视化 · 常规模板 | infographic  | text-to-image   |
| Documents & Publishing     | `framework-042` 文档与出版物 · 常规模板     | document     | text-to-image   |
| History & Classical Themes | `framework-040` 历史与古风题材 · 常规模板   | scene        | text-to-image   |
| Illustration & Art         | `framework-032` 插画与艺术 · 常规模板       | single-scene | text-to-image   |
| Other Use Cases            | `framework-045` 其他应用场景 · 常规模板     | single-scene | text-to-image   |
| Photography & Realism      | `framework-029` 摄影与写实 · 常规模板       | single-scene | text-to-image   |
| Posters & Typography       | `framework-008` 海报与排版 · 常规模板       | poster       | text-to-image   |
| Products & E-commerce      | `case-532` 六宫格柠檬饮料微缩广告           | multi-panel  | text-to-image   |
| Scenes & Storytelling      | `framework-038` 场景与叙事 · 常规模板       | scene        | text-to-image   |
| UI & Interfaces            | `framework-001` UI与界面 · 常规模板         | interface    | text-to-image   |

专项语义核对：

- Charts 只允许直接可观察信息，禁止虚构数字/医学/科学/排名/因果。
- Brand 要求原创且 legally distinct，不复制蓝图商标。
- Products 禁止虚构价格、折扣、规格、功效或产品 claim。
- UI 将蓝图作为视觉语言，不克隆真实平台 pixel-for-pixel。
- History 要求时期内部一致，禁止无意混合朝代/文化/现代物件。
- 所有分类均保留公共规则：蓝图示例仅为示意，上传图内容优先。

## 最长与框架 prompt

- `case-532` 是当前最长 prompt：15493 字符；Products & E-commerce / multi-panel，完整协议、产品安全适配器和 blueprint delimiters 通过。
- `framework-001`：UI & Interfaces / interface，完整协议、UI 原创限制和 blueprint delimiters 通过。

## 来源边界

- `git diff --quiet -- data/source` 通过，`data/source/` 无 untracked 项；本轮未编辑 canonical source。
- 上游 ZIP 不存储在仓库且本机相邻路径不存在，因此无法重新读取 ZIP；只核验 source manifest 记录的 SHA256 `ca672924e47630ac8d30c1155544fa60b052b4af74b2074fef158490a92b4d8d` 与 canonical source tree 未变。该限制未被伪装为重新哈希 ZIP。
- public/library 生成文件只由脚本重建，没有手工修改 prompt 或 preview。

## 其他回归证据

- 容量：`../o04/capacity-report.md`，Sharp 0.35.4 后 14/14 budgets PASS。
- 容器/本地栈：`../o05/local-stack-report.md`，API/Worker/Web/static、深链接与优雅停机通过。
- CI/制品：`../o06/release-report.md`，O07 后四镜像重新打包/load 通过。
- 恢复：`../o07/recovery-report.md`，两轮 PG restore、删除清单和回滚兼容通过。

## 边界

Z01 执行当时未执行 commit、push、registry push、远端 CI、deploy、生产 migration 或真实/付费 Provider 调用；该阶段 Provider 请求为 0。W06 后续已在单次授权下独立完成，见 [`../w06/real-provider-report.md`](../w06/real-provider-report.md)；其余未授权动作至今仍未执行。
