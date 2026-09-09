# OnePic 详细开发清单

## 续接记录

- 当前阶段：D/F/U/B/M/J、W01–W06、O01–O07、Z01–Z04 全部完成并勾选；最终独立复审 PASS，BLOCKER/HIGH/MEDIUM 0/0/0，findings none。
- 下一项：无剩余必选开发项；本地代码、测试、操作文档和可加载制品已交付。
- 已知边界：后续任何付费 Provider 调用、commit、push、registry push、deploy 和生产 migration 仍须逐项单独授权；当前交付未执行这些动作。真实 S3-compatible adapter/私有 bucket 恢复、远端 CI、生产 TLS/多实例/PG 和原 2026-09-05 设计图不可恢复均已列为残余风险，不冒充完成。
- 最终测试/证据：W06 真实 Provider 1/1 请求 PASS；完整 CI（Python 23、unit 41/292、integration 26/133、O07 recovery、E2E 44）、local stack、O04 14/14、gitleaks 0 findings、v7 四镜像+静态 tar build/load 全通过。v7 build-time fingerprint 为 `6ce80a41291f3b483eba147f951099bbc40c37c539b3aa07ff1608b84005c9d3`；Markdown/JSON/HTML 和制品 manifest 一致。
- 下一位模型：若用户另行授权发布操作，先核对 dirty 工作区与当前制品 fingerprint；不得读取或输出 `.tmp/w06-provider.env` 的密钥值，不得未经新授权再次调用真实 Provider、commit、push、deploy 或执行生产 migration。

## 勾选与证据规则

每个 ID 是可验收单元。先实现，再运行该行指定测试和相关回归，全部通过后立即勾选，不集中在最后补勾。测试缺运行环境、只写代码、用假数据演示、失败后未修复都保持未勾选。非代码门禁通过其指定审批/文档校验后勾选。已有完成项受后续改动影响时重测，失败则取消勾选并说明。

证据写在本文件末尾的执行记录；大量脱敏日志放后续建立的证据目录，按任务 ID 链接。至少记录：ID、日期、文件/差异、工作区版本（commit 加 dirty diff 标识）、命令、退出码/断言、证据路径、残余风险。禁止保存密钥、图片正文和用户私有数据。新增/拆分项需保留原 ID 与依赖，不通过删除未完成项缩减 Goal。

## D. 基线与决策

加载：上下文索引 L0，当前/目标架构与规范。D01–D06 可做设计工作；任何后端实现依赖 D00。

- [x] D00 记录用户对服务端、身份、存储、隐私和 AGENTS 修订的明确批准，再按批准范围修订规则；验收：有批准来源、规则差异与隐私边界核对，未获批不勾选、不绕过。
- [x] D01 核对分支、脏状态、模板实际数量、许可证、启动方式，执行现有 build/validate/test/check 基线；验收：命令结果和已有失败单独记录，生成漂移不覆盖用户改动。
- [x] D02 收敛目录 API 是否首期实现、PG job/outbox、未知任务/取消/媒体过期语义、OIDC 与各运行模式；验收：形成 ADR，目标架构/规范/模式无相互矛盾，不能静默引入微服务。
- [x] D03 恢复五张认可设计图及 prompt/metadata 的实际副本，建立持久路径和校验值；验收：逐张可打开且版本对应，缺图记录阻塞，不自行付费重生。（按 ADR 0003 用户批准的重建基准落盘于 docs/design/ui-rebuilt-2026-09-06/；重建版而非原图，不宣称像素级保真）
- [x] D04 根据真实设计建立 DESIGN 规范：tokens、字体、布局、组件、断点、状态、无障碍；验收：与五图逐页比对，移动端与异常态有规格；依赖 D03，缺图时只可做未验收草案。
- [x] D05 确定受支持依赖版本、包管理器、lockfile、许可与命令清单；验收：官方兼容依据及干净安装验证计划，不把推荐技术当已有依赖。
- [x] D06 完成数据字典和接口设计：字段、外键、唯一约束、索引、保留策略、权限矩阵、错误码；验收：覆盖上传、预审、生成、身份、集合、删除、导出，示例通过 schema 校验。

## F. 工程基础

依赖 D00/D02/D05/D06；加载架构 §2–4、规范和模式相关章节。

- [x] F01 建立 web/api/worker/contracts/client 工作区且保留 Python 编译器；验收：干净安装、各应用构建，旧静态目录流程仍可用。
- [x] F02 配置严格类型、格式化、lint、跨层导入规则及统一脚本；验收：故意非法依赖和类型错误被检查拦截，再移除测试污染。
- [x] F03 建立 dev/test 配置校验与无凭据 env 示例；验收：缺失/非法配置启动失败且不打印 secrets，managed 模式无身份配置时拒绝开启。
- [x] F04 建立单元/PG 集成/浏览器测试设施与 mock provider；验收：测试可独立重跑、清理隔离数据，不连接生产或执行付费调用。
- [x] F05 建立 OpenAPI 源、生成客户端、请求/响应校验；验收：契约 lint、重复生成无漂移、未知字段与畸形响应测试。

## U. 五页前端

依赖 D02/D04/D05；迁移工程依赖 F01/F02。后端未就绪可使用显式测试替身开发，但只可勾选独立 UI 行，不可勾选真实联调。

- [x] U01 实现 tokens 与 Button/Input/Dialog/Card/Toast 等项目封装；验收：键盘、焦点、禁用/加载状态及对比度检查，无运行时 CDN。
- [x] U02 建立五路由导航、响应式 Shell、错误/404 页面；验收：直接深链接刷新、前进后退、窄屏和键盘导航可用。
- [x] U03 实现 catalog 数据层、按需提示词与图片懒加载；验收：初始不加载全部 TXT，请求失败/缓存版本变化/空目录可恢复。
- [x] U04 完成发现页搜索、分类、蓝图类型、排序与分页/增量展示；验收：组合筛选、清空、URL 恢复、无结果，不能误写为两种运行输入流程。
- [x] U05 完成模板详情、来源、示例提示词/公共提示词区分、复制/下载；验收：显示与下载正文/哈希一致，剪贴板拒绝有反馈。
- [x] U06 完成总览页、最近模板及真实统计；验收：首次访问空态、存储失败、未配置服务不展示虚假在线/任务数。
- [x] U07 完成单图工作台选择、预览、移除与换模板；验收：拒绝多图、格式/大小校验、释放 object URL、旧异步结果不覆盖新模板。
- [x] U08 完成运行模式、模型/参数与隐私设置；验收：模式切换无隐式上传/密钥迁移，比例不支持有提示，参数基于能力而非硬猜。
- [x] U09 完成任务状态组件：排队、运行、未知、失败、取消请求、成功、结果过期；验收：状态可访问，未知不显示“一键自动重试”，测试非法状态。
- [x] U10 完成本地收藏、集合、记录视图及导入导出 UI；验收：坏 JSON、重复项、schema 版本、localStorage 不可用；不得自动上传本地密钥。
- [x] U11 完成指南页协议、来源、蓝图类型、运行模式和隐私说明；验收：与实际模式一致，无“禁止图生图”或虚假零中转文案。
- [x] U12 对五页做桌面/移动端和无障碍回归；验收：与 DESIGN.md 基线对照截图（参考 D03 重建图，非像素级验收）、320/768/1440 宽度、缩放/长文案/减少动效，记录可接受偏差。

## B. 后端基础与身份

依赖 F 全部、D00/D06；加载架构 §6–8、契约和权限矩阵。

- [x] B01 实现 PG migrations：主体、版本、任务、attempt、media、session、配额、集合；验收：空库迁移和已有版本升级、外键/唯一约束/关键查询索引。
- [x] B02 导入不可变模板 release 与精确 prompt 快照；验收：哈希不符拒绝、重复导入幂等、旧任务仍能取原版本，不写源目录。
- [x] B03 实现身份端口、OIDC 登录/退出与会话；验收：state/nonce/issuer/audience/PKCE 校验、过期/撤销/轮换、Cookie 和 CSRF。
- [x] B04 实现对象级授权与管理员边界；验收：用户 A 不能读写 B 的媒体/任务/集合/下载链接，管理员无默认图片读取权。
- [x] B05 实现配额、速率和并发限制；验收：并发请求不超额、预留/释放幂等，未知付费结果不错误释放，失败不泄漏 key。
- [x] B06 实现统一错误/关联 ID/健康检查；验收：无效输入和依赖故障返回约定状态，无堆栈/secret 泄漏，健康检查不触发付费探测。

## M. 媒体与预审

依赖 B01/B02/B04/B05；加载数据模型、协议、来源与架构安全章节。

- [x] M01 实现上传创建、隔离区与完成确认；验收：owner/过期/重复完成/未上传完/伪造对象路径拒绝，未确认对象不可生图。
- [x] M02 实现魔数、真实解码、MIME、字节/像素、方向检查；验收：假后缀、动画/SVG/压缩炸弹/超限拒绝，图像处理有内存和超时上限。
- [x] M03 实现私有存储端口和签名访问；验收：无公共 ACL、链接短期失效、跨用户获取失败、私有缓存策略，真实本地测试存储可读写。
- [x] M04 实现提交前预审，校验模板/版本/单图/参数/协议/Provider 能力；验收：失败记录错误码与原因，拒绝绕过预审、过期预审或替换输入。
- [x] M05 实现 prompt 版本绑定和预审变更流程；验收：需要改词时阻断，不静默重写；维护流程经编译验证创建新版本并保留差异。

## J. 生图任务与 Worker

依赖 B、M；加载协议与设计模式，特别是幂等、状态机和 Adapter。

- [x] J01 实现 POST generation 与 owner/key 唯一幂等；验收：同 key 同请求返回同任务，不同请求 409，并发创建只预留一次配额。
- [x] J02 在同一事务写 generation 与 PG job；验收：模拟回滚不留半条任务，不引入未经决策的外部消息系统。
- [x] J03 实现 Worker 领取/心跳/租约/CAS/死信；验收：双 Worker 抢占、进程崩溃、旧 lease 完成写入被拒，不重复执行已确认成功任务。
- [x] J04 实现 allowlist Provider Adapter 与凭据注入；验收：参数、状态码、响应规范化合约测试，SSRF/重定向/恶意结果 URL 不能触达内网或泄漏 Authorization。
- [x] J05 实现真实发送内容追溯：输入、compiled/effective prompt、attempt/参数；验收：捕获测试上游请求字节并比对哈希，替换模板/正文被拒。
- [x] J06 实现超时/网络中断的 outcome_unknown 与对账；验收：provider 已接受后断网不自动重发，缺 request ID 仍保持未知，有明确处置入口。
- [x] J07 实现有界可重试错误与失败归档；验收：429/503 按 provider 证据和幂等能力判断，401/参数错误不重试，超限进入死信。
- [x] J08 实现取消与竞争处理；验收：排队取消、运行取消请求、上游不支持取消、成功回包竞态均不谎报已取消；本地取消不能保证免计费。
- [x] J09 实现结果获取、验证、存储与原子完成；验收：假 MIME/超限/缺图拒绝，actual 尺寸与请求分开，存储失败不重复调用付费模型。
- [x] J10 实现查询/下载与 sidecar；验收：用户只读自己任务，结果/hash/attempt/prompt 对应，过期媒体不会改变历史成功事实，导出不含密钥。

## W. 联调与工作区

依赖 U、B、M、J；加载相关契约和页面规范。

- [x] W01 接通工作台上传→预审→提交→轮询→下载完整路径；验收：浏览器刷新可恢复自己的任务，重复点击幂等；本地真实 API/PG/存储加 mock provider 集成通过。
- [x] W02 接通失败/未知/取消/过期状态；验收：断网、401、429、5xx、超时、轮询乱序、登出清缓存，未知状态无隐式重试。
- [x] W03 实现服务端收藏/集合/历史分页；验收：跨用户隔离、稳定 cursor 排序、重复收藏幂等、集合删除不误删任务。
- [x] W04 实现显式本地收藏导入与私人记录导出；验收：重复导入、坏文件、部分失败、无密钥上传和无跨用户记录混入。
- [x] W05 验证静态独立与 direct BYOK 保留；验收：关闭 API 后目录/复制可用，模式切换提示去向，不自动切换 provider 或传送凭据。
- [x] W06 验证真实 provider 兼容；验收：仅在明确付费授权及可用配置下运行最小单图案例，核验结果像素、哈希、sidecar；mock 通过不能勾选本项，未授权保留阻塞。

## O. 安全与运行保障

依赖已实现模块；加载架构 §8–10、ops 和测试规范。仅在隔离本地/测试环境执行，生产操作另授权。

- [x] O01 实现保留与删除流程；验收：过期/用户删除/重复清理/失败重试、撤销签名权限、在途和未知任务保护、备份删除清单。
- [x] O02 实现结构化脱敏日志与低基数指标；验收：用哨兵密钥/提示词测试无泄漏，队列年龄、unknown 数和存储/删除告警可触发。
- [x] O03 完成安全负例矩阵；验收：越权、CSRF、XSS/恶意元数据、SQL 注入、SSRF、上传绕过、配额竞争、session 重放和日志泄漏测试。
- [x] O04 压测并记录容量预算；验收：非生图 API/队列 p95、Worker 并发、PG 连接、解码内存/磁盘有测量，不能把建议数值当现状。
- [x] O05 建立容器与本地启动/健康/优雅停机；验收：干净环境启动、深链接刷新、Worker 在途停机不盲目重发，原静态包仍可独立部署。
- [x] O06 建立 CI 门禁和独立服务发布制品；验收：编译器、契约、lint/type/test/build 全部运行，失败阻断发布，文档/凭据/临时图不误入 public 包。
- [x] O07 编写并演练迁移/备份/恢复/回滚 runbook；验收：隔离测试环境从备份恢复、删除清单重放、旧前端/兼容 API、应用回滚不回滚破坏性 SQL。

## Z. 最终验收与交接

依赖前面全部必选项；任何外部授权未解决不得宣称全量完成。

- [x] Z01 执行全套现有与新增回归；验收：模板数量/唯一 ID/来源/公共预览/全部 prompt 一致，case-532、framework 及各类别抽查；JS 语法、Python 编译、静态服务和许可证检查。
- [x] Z02 同步 README、架构、规范、DESIGN、契约、索引及 HTML 派生版；验收：现状/目标分离、链接有效、无互相矛盾和虚假上线声明。
- [x] Z03 独立复查本次 diff 与证据；验收：无无关改动、秘密、源 ZIP 变更、手改生成数据，测试与当前工作区版本对应。
- [x] Z04 生成最终交付记录；验收：所有必选项均有可复查通过证据，未测试/阻塞/剩余风险如实列出，列明启动命令及操作边界。未获授权不 commit/push/deploy。

## 执行记录

初始为空，不允许使用以下模板占位内容作为通过证据。

```text
ID / 日期：D01 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty（docs/architecture.md 修改、GOAL.md 与多份 docs 未跟踪，均为既有用户改动，未覆盖）；本次仅更新 docs/development-checklist.md；build 重建 data/library/templates.json 与 public/data/catalog.json，diff 仅 generatedAt 时间戳。
验证命令 / 退出码 / 关键断言：
  - git branch/status：分支 main；脏状态如上，许可证 LICENSE、NOTICE.md、third_party/（animejs、awesome-gpt-image-2）齐全，退出码 0。
  - 模板数量：templates.json 576 条（529 case + 47 framework），public/data/prompts 576 个 TXT，public/previews 570 项；validate 校验 529 个 case 预览与 493 个 reviewed 生成预览全部通过。
  - npm run check（build → validate → test）：退出码 0；build "Built 576 templates"，validate "Validated 576 templates / 529 previews / 576 prompt files"，源档 SHA-256 ca672924…b4d8d；unittest 17 tests OK。
  - node --check public/assets/app.js 与 public/assets/fx.js：退出码 0。
  - 静态冒烟：python3 scripts/serve.py 起服后 GET /、/data/catalog.json、/data/prompts/case-1.txt、/previews/case-1.webp 均 200。
证据路径：本条目（日志未另存；命令可复跑，输出如上述）。
风险或阻塞 / 下一项：生成文件重建只产生时间戳漂移，属确定性构建预期；D00 门禁未批准（阻塞 B 及之后实现类项）、D03 设计图缺失（阻塞 D04/U12 对照）。下一项：D02（决策收敛，可做设计工作）。
```

```text
ID / 日期：D02 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 docs/adr/0001-phase1-scope-and-consistency.md；修订 docs/full-stack-architecture.md（§6 目录 API 标注后续阶段并补首期范围说明、§8 身份与运行模式、§9 状态机/媒体过期/首期 PG job 同事务）、docs/design-patterns.md（状态机补 outcome_unknown 与 expired 语义、Outbox 改为首期 PG job 同事务）、docs/development-context.md（索引加 ADR 行、待收敛问题段落更新为已收敛）。
验证命令 / 退出码 / 关键断言：
  - 决策覆盖清单四个待收敛点：目录 API 首期不实现（ADR D-1）；状态机以 §9 为准、补 outcome_unknown 与 expired 语义（D-2）；首期 PG job 表同事务、不引入 outbox 表/外部 broker（D-3）；catalog-only/direct-BYOK 无需身份、managed-generation 必须 OIDC 且未配置拒绝开启（D-4）。
  - 一致性核验：grep outcome_unknown/outbox/templates 跨 docs/full-stack-architecture.md、docs/design-patterns.md、docs/adr/、docs/development-context.md，状态机定义两处一致，outbox 表述无残留矛盾，§6 目录接口已标注后续阶段；退出码 0。
  - 未引入微服务/Redis/broker：ADR 与 §2 拓扑保持模块化单体 + Worker + PG。
证据路径：docs/adr/0001-phase1-scope-and-consistency.md；docs/full-stack-architecture.md §6/§8/§9；docs/design-patterns.md State Machine/Outbox 节。
风险或阻塞 / 下一项：本项为设计收敛，不产生实现；D00 批准前不实施任何服务端代码。下一项：D03（查找设计图副本）与 D05（依赖基线），独立可推进。
```

```text
ID / 日期：D03 / 2026-09-06
状态：阻塞（图片缺失；prompt 文本已持久化，保持未勾选）
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 docs/design/ui-2026-09-05-prompts/（10 个 prompt 文本 + SHA256SUMS.txt，自 .tmp/onepic-ui-high-quality-2026-09-05/ 复制）；修订 docs/development-context.md（缺失结论、索引行）。
验证命令 / 退出码 / 关键断言：
  - ls /tmp/onepic-ui-high-quality-2026-09-05：不存在。
  - find .tmp：仅 .tmp/onepic-ui-high-quality-2026-09-05/ 下 10 个 *.prompt.txt，无任何图片/metadata 文件。
  - tar -tzf .tmp/onepic-template-studio.tar.gz | grep：无相关条目，退出码 0（无匹配）。
  - mdfind -name "01-dashboard" / "05-protocol" / "03-workbench"、mdfind "onepic-ui-high-quality"：全盘 Spotlight 索引无项目外副本。
  - git check-ignore：.tmp/ 被 gitignore，非持久路径。
  - shasum -a 256：10 个 prompt 校验值已写入 docs/design/ui-2026-09-05-prompts/SHA256SUMS.txt（10 行）。
证据路径：docs/design/ui-2026-09-05-prompts/SHA256SUMS.txt；本条目。
风险或阻塞 / 下一项：五张设计图与生成 metadata 无法恢复，D03 不勾选；按规则不付费重生。D04 只能做未验收草案，U12 像素对照持续受阻；若用户另有副本可提供后可解除。下一项：D05、D06。
```

```text
ID / 日期：D05 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 docs/adr/0002-dependency-baseline.md；docs/development-context.md 索引加 ADR 0002 行。
验证命令 / 退出码 / 关键断言：
  - node --version v22.19.0、npm 10.9.3、python3 3.14.4、pip 26.0.1、Pillow 12.1.1：满足 engines（node>=20、python>=3.11）与 Pillow>=10.0，退出码 0。
  - ls package-lock.json / pnpm-lock.yaml / yarn.lock：均不存在，与「当前零 npm 依赖、lockfile 暂缺」事实一致，退出码非 0 为预期。
  - package.json dependencies 为空；命令清单 dev/build/validate/test/check 存在且 D01 全绿。
  - 官方兼容依据：Vite 7 要求 Node 20.19+/22.12+（vite.dev）；Fastify v5 仅支持 Node v20+（fastify.dev 迁移指南）；检索确认后写入 ADR。
  - 目标栈（Vue3/TS/Vite7/Fastify5/PG16）在 ADR 中明确标注为拟定、非已有依赖。
证据路径：docs/adr/0002-dependency-baseline.md；本条目。
风险或阻塞 / 下一项：干净安装验证计划列为 F01 门禁，本项只做计划不实跑（venv/npm ci 在无新依赖时无增量信息）。下一项：D06（数据字典和接口设计）。
```

```text
ID / 日期：D06 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 docs/design/backend-data-dictionary.md、docs/design/backend-schemas/（5 个 JSON Schema + 6 个示例）、scripts/validate_design_schemas.py；requirements-dev.txt 增加 jsonschema>=4.0（MIT，设计期校验工具）；docs/development-context.md 索引加数据字典行。
验证命令 / 退出码 / 关键断言：
  - python3 -m venv .tmp/venv-design && pip install jsonschema → jsonschema 4.26.0（PEP 668 环境用 venv，不污染系统 Python）。
  - .tmp/venv-design/bin/python scripts/validate_design_schemas.py：退出码 0，"Validated 6 design examples"——5 个 valid 示例通过、1 个缺 promptSha256 的 invalid 示例按预期被拒（修复一处示例哈希 63 位笔误后通过，修正值 c3557002…1352a）。
  - 覆盖核对：字典含 subject/session（身份）、catalog_release/template_version（生成追溯）、media_object/upload（上传）、precheck（预审）、generation/attempt/result/job（生成与队列）、quota_ledger、collection/collection_item（集合）、audit_event、deletion_manifest（删除），§2 接口表含导出；权限矩阵与 21 个稳定错误码齐备。
证据路径：docs/design/backend-data-dictionary.md；docs/design/backend-schemas/；scripts/validate_design_schemas.py 输出如上。
风险或阻塞 / 下一项：设计稿不产生实现，字段在实施 B01 migrations 时可经评审微调；保留默认值为待产品确认建议（目标架构 §9）。下一项：D 阶段剩余 D04（依赖 D03，仅可未验收草案）；否则进入 U 阶段独立 UI 项（U 依赖 D02/D04/D05——D04 未验收，U 项勾选受 D04 阻塞，仅能按方向描述做未对照开发）。
```

```text
ID / 日期：D04 / 2026-09-06
状态：阻塞（草案已产出，验收依赖 D03 原图，保持未勾选）
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 docs/design/DESIGN.md（未验收草案：tokens、断点、五页规格、组件状态、无障碍、待校准清单、验收路径）；docs/development-context.md 索引加 DESIGN 行。
验证命令 / 退出码 / 关键断言：
  - 草案内容来源核验：逐行读取 docs/design/ui-2026-09-05-prompts/ 五个页面 prompt（01/02/03/04/05），页面结构、文案、蓝图类型口径均引自文本，色值字号标注「待定」。
  - 覆盖核对：tokens（色彩/字体/间距，WCAG AA 约束）、断点 320/768/1440、五页逐页规格、组件（Button/Input/Dialog/Card/Toast 等）、任务与异常状态、无障碍要求齐备。
  - 草案不含虚假事实：统计数字标注随 catalog 实际值，蓝图类型为原始分类口径，指南页明确禁止「禁止图生图」错误文案。
  - 未执行逐图比对（原图缺失），故不满足 D04 验收条件，不勾选。
证据路径：docs/design/DESIGN.md；docs/design/ui-2026-09-05-prompts/。
风险或阻塞 / 下一项：D04 验收被 D03 阻塞；此后所有未勾选项均被两道外部门禁卡住——D00（后端边界批准，阻塞 F/B/M/J/W/O/Z）与 D03（设计图缺失，阻塞 D04 验收及 U 项勾选）。下一项：无依赖已满足的未勾选项；等待 D00 批准或 D03 原图副本。
```

```text
ID / 日期：D06 加固（CI 集成）/ 2026-09-06
状态：通过（维护项，不改变勾选状态）
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。scripts/ci-verify.sh 增加 python3 scripts/validate_design_schemas.py 步骤。
验证命令 / 退出码 / 关键断言：
  - PATH 前置 venv 后 bash scripts/ci-verify.sh：首次因 venv 缺 Pillow 失败（test_library ImportError），在 venv 内 pip install -r requirements-dev.txt 后重跑退出码 0，"Repository verification passed"——同时实测了 D05 干净安装计划第 1 步（venv + requirements-dev 全量安装可复跑全部门禁）。
  - 教训记录：CI/本地运行 ci-verify.sh 前须安装 requirements-dev.txt（jsonschema 与 Pillow 均为其成员）。
证据路径：scripts/ci-verify.sh diff；本条目。
风险或阻塞 / 下一项：无；主线仍等待 D00 批准或 D03 原图副本。
```

```text
ID / 日期：D00 / 2026-09-06
状态：通过（用户批准）
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 docs/adr/0003-backend-boundary-approval.md；修订 AGENTS.md（§1 明确禁止项指上游衍生物、§7 后端禁令按批准范围改写、新增 §11 已批准后端边界）。
验证命令 / 退出码 / 关键断言：
  - 批准来源：用户 2026-09-06 会话回复「我全部批准」，直接针对 D00 范围与 D03 替代处理；记录于 ADR 0003。
  - 批准范围：模块化单体 API + Worker + PG + 私有对象存储 + OIDC + 对象级授权/配额（ADR 0001/0002、目标架构 §1–10）；明确排除：commit/push/deploy/付费调用/生产迁移（仍需分别授权）、支付/会员/团队、遥测、上游品牌与代码、源档修改。
  - 规则差异：AGENTS.md §1/§7/§11 三处修订，grep 核验「## 11. Approved backend boundary」存在；禁止项（遥测、隐式上传、任意转发、支付/会员/团队）保留。
  - 隐私边界核对（ADR 0003）：显式触发后才出网且仅 allowlist provider；BYOK 密钥不迁移；日志脱敏；quarantine；保留/删除策略；对象级授权；私有结果不进 public。
证据路径：docs/adr/0003-backend-boundary-approval.md；AGENTS.md §1/§7/§11。
风险或阻塞 / 下一项：D00 解除 F/B/M/J/W/O 阻塞；付费调用与部署仍需逐项授权。下一项：F01（工程基础工作区）。
```

```text
ID / 日期：D04 / 2026-09-06
状态：通过（验收依据经用户批准变更：以 prompt 衍生基线代替缺失原图）
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。docs/design/DESIGN.md 状态由「未验收草案」改为「用户批准的工作基线」，§8 验收路径同步改写。
验证命令 / 退出码 / 关键断言：
  - 用户 2026-09-06「我全部批准」覆盖此前提供的选项「授权以其他方式重建视觉基准」（ADR 0003 记录）。
  - 规格完备性：tokens、断点 320/768/1440、五页逐页规格、组件与任务/异常状态、无障碍均在案（见前条 D04 记录）。
  - 诚实保留项：与五张原图的像素级比对永久不可验，DESIGN.md 与 ADR 0003 均已声明；Z04 交付记录须列为残余风险；U12 对照基准改为 DESIGN.md。
证据路径：docs/design/DESIGN.md；docs/adr/0003-backend-boundary-approval.md。
风险或阻塞 / 下一项：D03 保持未勾选（原图仍缺失，恢复验收未满足）；D04 勾选不宣称像素级保真。下一项：F01。
```

```text
ID / 日期：D03 / 2026-09-06
状态：通过（用户指定重建副本落盘；重建版而非原图恢复，不宣称像素级保真）
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。用户提供 docs/design/ui-rebuilt-2026-09-06/（5 张 PNG + 5 个实际请求 prompt.txt + 5 个生成 metadata + gallery.html + README.md）；本次新增该目录 SHA256SUMS.txt（17 个文件校验值）；修订 docs/development-context.md（索引行、D03 更新段）；修订本清单（D03 勾选、U12 对照基准措辞对齐 DESIGN.md 基线、续接记录）。
验证命令 / 退出码 / 关键断言：
  - file docs/design/ui-rebuilt-2026-09-06/*.png：五张均为 PNG image data, 1672x941, 8-bit RGB（非空、头信息有效）。
  - PIL 全量解码（.tmp/venv-design）：五张均 load() 成功，(1672, 941) RGB，输出 ALL_DECODED，退出码 0。
  - 哈希闭环：逐张比对 metadata outputs[0].sha256/bytes 与实际文件、metadata prompt_sha256 与同名 prompt.txt——五张全部 OK（图片哈希/字节数/prompt 哈希三项一致），ALL_VERIFIED，退出码 0。
  - 持久性：git check-ignore -v docs/design/ui-rebuilt-2026-09-06/01-dashboard.png 退出码 1（未被忽略）；路径在仓库工作区内，随下次授权 commit 入库。
  - shasum -a 256 -c SHA256SUMS.txt：17 个文件全部 OK，退出码 0。
  - 未发生任何生图调用：副本由用户提供，本次仅做核验与登记（符合"不自行付费重生"）。
  - 版本对应口径：metadata 记录 model=gpt-image-2、requested 3840x2160、actual 1672x941、actual_size_matches_request=false——重建图如实标注非 4K，未伪造尺寸。
证据路径：docs/design/ui-rebuilt-2026-09-06/（含 SHA256SUMS.txt、README.md 逐张实测记录与"视觉审核与实现纠正项"）；docs/development-context.md D03 更新段。
风险或阻塞 / 下一项：重建图与 2026-09-05 原图的像素级一致性永久不可验，Z04 交付记录继续列为残余风险；重建图中的示意内容（虚构编号/品牌/错误端点等）按 README 纠正项不得照搬进实现；实现以 DESIGN.md（用户批准基线）为准，重建图为参考。下一项：F01。
```

```text
ID / 日期：F01 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增根 tsconfig.base.json、package-lock.json、packages/contracts（信封/状态机类型）、packages/client（类型化 API client 骨架）、apps/api（Fastify 5 + health 路由 + 优雅停机）、apps/worker（进程壳）、apps/web（Vue 3 + Vite 7 构建骨架）；修订根 package.json（workspaces 字段 + build:workspaces 顺序构建脚本）、.gitignore（dist/）、docs/adr/0002（版本复核结果）、docs/development-context.md（L2 工作区入口）。Python 编译器与 public/ 未动。
验证命令 / 退出码 / 关键断言：
  - 版本复核（npm view，2026-09-06）：vue 3.5.42 MIT / vite 7.3.6 MIT（engines ^20.19.0||>=22.12.0）/ @vitejs/plugin-vue 6.0.8 MIT（peer 支持 vite ^7）/ typescript 5.9.3 Apache-2.0 / vue-tsc 3.3.11 MIT / fastify 5.12.3 MIT；采用 vite 7 线（ADR 0002 记录依据），未采 vite 8。结果已写入 ADR 0002。
  - npm install：退出码 0，生成 package-lock.json（151 个锁定包），found 0 vulnerabilities。
  - 许可审计：node_modules 全量扫描 MIT×84、Apache-2.0×1、ISC×6、BSD-3×5、BSD-2×1；17 个无 license 命中均为包内子目录清单/测试夹具（父包均 MIT）；无 GPL/SSPL。
  - 干净安装（ADR 0002 门禁第 2 步）：rm -rf node_modules && npm ci → 退出码 0。
  - 各应用构建：npm run build:workspaces（contracts→client→api→worker→web 顺序）→ 退出码 0；web 含 vue-tsc --noEmit 类型检查 + vite build（12 modules，产物 dist/index.html + assets）。
  - 旧静态流程：npm run check（venv + nvm PATH）→ 退出码 0，Built 576 templates / 17 tests OK；bash scripts/ci-verify.sh → 退出码 0 "Repository verification passed"（含静态服务冒烟 /、catalog total=576、case-532.txt、app.js、previews）；node --check app.js/fx.js 通过（ci-verify 内）。
  - 生成漂移核对：git diff data/library/templates.json、public/data/catalog.json 各仅 1 行 generatedAt 时间戳变化（确定性构建预期，未覆盖用户改动）。
  - 运行冒烟：node apps/api/dist/server.js → health/live 与 health/ready 返回 {"data":{"status":"ok"}}（§6 信封），404 为 Fastify 默认结构（统一错误信封属 B06），SIGTERM 优雅停机日志 api_shutdown；node apps/worker/dist/index.js → worker_started，SIGTERM → worker_stopping 退出码 0。冒烟期间本机 8080/18080 被既有服务占用（Tomcat 页），与项目无关。
证据路径：本条目；docs/adr/0002-dependency-baseline.md；apps/、packages/、tsconfig.base.json、package-lock.json（工作区文件）。
风险或阻塞 / 下一项：client/contracts 当前仅 health 端点先导，OpenAPI 源/生成/校验属 F05；lint/格式化/跨层导入规则属 F02（当前 tsconfig 已 strict）；ci-verify.sh 暂未纳入 workspace 构建（F02 统一脚本时纳入）；统一错误信封与就绪探针语义属 B06。下一项：F02。
```

```text
ID / 日期：F02 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增根 eslint.config.js（平铺配置 + 架构 §4 跨层导入边界）、.prettierrc.json、.prettierignore；修订 tsconfig.base.json（补 noUnusedLocals/noUnusedParameters/noFallthroughCasesInSwitch）、根 package.json（devDeps：eslint ^10.10.0、@eslint/js ^10.0.1、typescript-eslint ^8.69.0、eslint-plugin-vue ^10.10.0、prettier ^3.9.6，均 MIT；统一脚本 lint/format/format:check/typecheck）、五个工作区包 package.json（typecheck 脚本）、scripts/ci-verify.sh（node_modules 守卫 + npm run lint + typecheck + build:workspaces 门禁）。prettier 对 eslint.config.js 与 packages/client/src/index.ts 做了纯格式化。
验证命令 / 退出码 / 关键断言：
  - npm install：退出码 0（新增 devDeps，lockfile 同步更新，0 vulnerabilities）；复跑 npm ci 干净安装退出码 0。
  - npm run lint：退出码 0（覆盖 apps/packages 新工作区代码；public/scripts/tests/docs 明确排除，public 资产仍走 node --check）。
  - npm run typecheck（contracts→client→api→worker→web 顺序）：退出码 0，严格新增选项下全绿。
  - npm run format / format:check：退出码 0，格式稳定。
  - 验收污染测试：packages/client/src/__pollution__.ts 注入 `import type { FastifyInstance } from 'fastify'` → eslint no-restricted-imports 报错（"client may only depend on @onepic/contracts"），eslint 退出码 1——由于 npm hoisting 使类型可解析，证明边界由 lint 而非模块解析强制；apps/api/src/modules/__pollution__.ts 同样被拦截（"domain/application modules must not depend on the HTTP framework"，规则已预置武装）；apps/api/src/__pollution__.ts 注入 `const broken: number = 'onepic'` → typecheck 报 TS2322。删除污染后 lint/typecheck 均退出码 0，临时 modules 目录已移除。
  - bash scripts/ci-verify.sh（venv + nvm PATH）：退出码 0 "Repository verification passed"，含新 workspace 门禁；生成文件 diff 仍仅 generatedAt 时间戳。
  - 版本复核：eslint 10.10.0 / typescript-eslint 8.69.0（peer 支持 eslint ^10、ts <6.1）/ eslint-plugin-vue 10.10.0（peer 支持 eslint ^10）/ prettier 3.9.6，许可全部 MIT。
证据路径：本条目；eslint.config.js（边界规则及出处注释）；scripts/ci-verify.sh diff。
风险或阻塞 / 下一项：lint 采用 typescript-eslint recommended（非 type-aware）——类型正确性由 tsc 严格门禁负责，type-aware lint 如后续需要另行评估；ESLint 10 为新主版本，配置为平铺式（flat config）。下一项：F03（dev/test 配置校验与无凭据 env 示例）。
```

```text
ID / 日期：F03 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/api/src/config/env.ts（类型化配置加载：RunMode 三态、pino 级别、端口、managed 模式必需字段校验、URL 格式校验、脱敏策略——issues 与日志永不包含 DATABASE_URL/CLIENT_SECRET/SESSION_SECRET 的值）、apps/api/.env.example（无凭据占位示例，含加载方式与脱敏说明）；修订 apps/api/src/server.ts（启动先 loadConfig，ConfigError 以结构化 JSON 输出全部 issues 后退出码 1）、apps/api/src/bootstrap/app.ts（接收 ApiConfig，日志级别/监听参数来自配置，启动日志含 runMode）、.gitignore（.env/.env.*，!​.env.example 白名单）。
验证命令 / 退出码 / 关键断言：
  - T1：RUN_MODE=managed-generation 且无身份配置 → 退出码 1，输出 6 条缺失字段（DATABASE_URL、OIDC_ISSUER、OIDC_CLIENT_ID、OIDC_CLIENT_SECRET、OIDC_REDIRECT_URI、SESSION_SECRET），错误文案引用 ADR 0001 D-4「managed 模式无身份源拒绝开启」。
  - T2：DATABASE_URL=postgresql://alice:hunter2@… 注入后缺 OIDC → 输出仅字段名与原因，hunter2/alice 出现次数 0。
  - T3/T4/T5：PORT=notaport、RUN_MODE=bogus、DATABASE_URL=not-a-url → 均退出码 1；T5 输出标注「value redacted」，字面值出现次数 0；T1 首轮曾误用 RUN_MODE=managed（枚举校验按预期拦截，退出码 1），修正为 managed-generation 后重测。
  - T6：齐全的 managed 占位配置 → 配置通过、服务启动、/api/v1/health/ready 返回 {"data":{"status":"ok"}}，日志中 placeholderpw/placeholder-secret 出现次数 0，SIGTERM 优雅停机。
  - 默认路径：无环境变量 → runMode=catalog-only，health/live 200。
  - 回归：npm run lint / typecheck / format:check 退出码 0；npm ci 后 build:workspaces 退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。严格 TS（noUnusedLocals）在实现期间抓到一处未用常量（SECRET_FIELDS），已移除并改以注释说明脱敏分支——门禁真实生效的旁证。
证据路径：本条目；apps/api/src/config/env.ts（脱敏策略注释）；apps/api/.env.example。
风险或阻塞 / 下一项：配置仅覆盖 API 进程当前所需字段；DATABASE_URL/身份字段的运行时语义（连接、OIDC 流程）属 B01/B03；worker 进程配置随 J03 引入；.env 实际加载推荐 node --env-file=（见 .env.example 头注），测试环境 env 示例随 F04 测试设施建立。下一项：F04（测试设施与 mock provider）。
```

```text
ID / 日期：F04 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 packages/test-support（@onepic/test-support：临时 PG16 集群工具 startPgTestCluster + mock provider 假件 startMockProvider）、vitest.config.ts / vitest.integration.config.ts / playwright.config.ts、单元测试（packages/client/src/index.test.ts 5 例、apps/api/src/config/env.test.ts 15 例、packages/test-support/src/mock-provider.test.ts 2 例）、集成测试（apps/api/test/pg.integration.test.ts 3 例）、E2E（e2e/static-smoke.spec.ts）、apps/api/tsconfig.test.json；修订根 package.json（devDeps vitest ^5.0.0、@playwright/test ^1.63.0；test:unit/test:integration/test:e2e 脚本；build/typecheck 链纳入 test-support）、apps/api/package.json（devDeps @onepic/test-support/pg/@types/pg，typecheck:test）、.gitignore（test-results/ 等）、docs/full-stack-architecture.md §4（布局补 packages/test-support/）。
验证命令 / 退出码 / 关键断言：
  - npm install 退出码 0；npx playwright install chromium 下载 Chromium headless shell 153 成功（Library Caches）。
  - npm run test:unit：22 例全部通过（覆盖 F03 配置校验全矩阵：默认值、空串、非法端口/模式/日志级别、managed 缺身份 6 字段拒绝、secrets 零回显、loopback OIDC http 例外、DATABASE_URL 形状校验；client 信封 5 例；mock provider 2 例含 429 脚本与 PNG 魔数校验）。
  - npm run test:integration：3 例通过（真实 PostgreSQL 16：version() 含 "PostgreSQL 16"、事务 CREATE/INSERT/ROLLBACK 隔离验证、多数据库不冲突）。每轮 startPgTestCluster 在 /tmp mkdtemp 建临时集群、loopback 随机端口、trust auth，结束 pg_ctl stop + rm -rf；重跑验证：连续两轮退出码 0 且 /tmp 无 onepic-pgtest 残留。
  - npm run test:e2e：1 例通过（playwright webServer 起 scripts/serve.py，真实 Chromium 断言标题、#hero-title、#template-library 可见，#metric-total 渲染出 576）。
  - 回归：lint/typecheck/format:check 退出码 0；build:workspaces 退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
  - 边界如实记录：测试仅触达 127.0.0.1 回环临时资源，无任何远程连接或付费调用；mock provider 记录请求头/字节供 J05 追溯断言使用。
  - 过程中门禁真实生效两例：verbatimModuleSyntax 抓到 AddressInfo 值导入（改 type-only），ESLint 10 preserve-caught-error 抓到吞错（补 cause）。
证据路径：本条目；packages/test-support/src/（工具与自测）；apps/api/test/pg.integration.test.ts；e2e/static-smoke.spec.ts。
风险或阻塞 / 下一项：集成设施依赖本机 Homebrew postgresql@16（ONEPIC_PG_BIN 可覆盖），O06 建 CI 门禁时需在 runner 提供 PG 或镜像；浏览器二进制缓存属机器本地，干净环境需 playwright install；ci-verify.sh 暂不含三类测试（避免在无 PG/浏览器环境误报），O06 统一收口。下一项：F05（OpenAPI 源、生成客户端、请求/响应校验）。
```

```text
ID / 日期：F05 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 packages/contracts/openapi/api-v1.yaml（OpenAPI 3.1 唯一事实来源：首期 health 端点 + ApiMeta/ApiErrorBody/ApiFailure/HealthLive/HealthReady/成功信封 schema，全部带 additionalProperties:false 与描述）、openapi/api-v1.json（js-yaml 生成，运行时用）、src/generated/api-v1.d.ts（openapi-typescript 生成，禁手改）；重写 contracts/src/index.ts（健康/信封类型改为从生成类型再导出 + 编译期 EnvelopeSyncGuards 同步守卫）；新增 apps/api/src/bootstrap/schema.ts（$ref 解引用辅助）并重写 health.ts（fastify 响应 schema 全部来自契约文档）；app.ts 增加 fail-loud ajv（removeAdditional:false）；apps/api/test/health.schema.test.ts（5 例契约校验测试）；根 package.json（devDep @redocly/cli ^2.51.2 MIT；lint:contract/gen:api/gen:api:check 脚本）；redocly.yaml；eslint/prettier 忽略生成文件；scripts/ci-verify.sh 增加 lint:contract 与 gen:api:check 门禁。
验证命令 / 退出码 / 关键断言：
  - npm run lint:contract（redocly lint）：退出码 0 "API description is valid"，3 个已说明警告（operation-4xx-response ×2——错误语义与完整 4xx 随 B06 落地；no-unused-components——ApiErrorBody/ApiFailure 为错误信封预声明）；security-defined 错误通过在 health 操作显式声明 security: []（公开端点）消除。
  - npm run gen:api:check：生成前后 SHA-256 对比 "no drift"；期间 YAML 修改后曾正确报出漂移（检查生效旁证），重新生成后通过。
  - 未知字段/畸形响应测试（unit 27/27 全绿，含 5 例契约测试）：/health/live 与 /health/ready 响应体逐字节等于契约信封；响应注入未声明字段被序列化层剥离（additionalProperties:false）；请求体未知字段返回 400（fail-loud ajv——发现 fastify 默认 removeAdditional:true 会静默剥离并放行，已改为拒绝）；enum 违规返回 400。client 侧畸形信封测试（非 JSON、缺 data、非契约错误体）持续通过。
  - 关键实现发现：fastify 序列化层不解析跨 schema 的 #/components/schemas 引用，新增 bootstrap/schema.ts 统一解引用，契约文档仍为唯一事实来源；类型导入 .d.ts 须写 ./generated/api-v1.js（NodeNext 规则）。
  - 全量回归：lint/typecheck/format/build:workspaces 退出码 0；test:unit 27 例、test:integration 3 例、test:e2e 1 例全绿；ci-verify.sh（含契约门禁）退出码 0。
证据路径：本条目；packages/contracts/openapi/（契约源与生成物）；apps/api/src/bootstrap/schema.ts；apps/api/test/health.schema.test.ts。
风险或阻塞 / 下一项：契约当前仅覆盖 health；上传/生成/取消端点随 B/M/J 阶段加入同一文档并重跑 gen:api:check；错误响应统一信封（setErrorHandler + correlationId）属 B06；client 包类型已全部来自契约，运行时仍是薄封装（openapi-fetch 式全量客户端生成如后续需要另行评估）。F 阶段全部完成。下一项：U01（tokens 与基础组件）。
```

```text
ID / 日期：U01 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/web/src/app/styles/tokens.css（DESIGN.md §2 tokens：色彩/圆角/字体/间距/focus-ring；琥珀强调固定配墨色文字——白字对比 2.94:1 不达 AA；prefers-reduced-motion 降级）、base.css（基础元素样式与 :focus-visible 焦点环）、src/shared/ui/ 7 组件 + 状态（Button 三变体含 loading aria-busy、Input label 关联/aria-invalid、Card、Chip aria-pressed、Tabs roving tabindex 方向键、Dialog 原生 <dialog> showModal/Esc、Dropzone 键盘可达、toast.ts + ToastHost aria-live）、index.ts 出口、6 个测试文件（60 例）；修订 main.ts/App.vue（接入样式与 ToastHost）、apps/web tsconfig（types + node）、vitest.config.ts（加 @vitejs/plugin-vue、纳入 apps/*/test 单测）、eslint.config.js（eslint-config-prettier 收尾关闭格式冲突规则；no-undef 对 .vue 关闭——类型由 vue-tsc 负责；设计系统目录关闭 multi-word-component-names，因清单即规定单字名）、根 devDeps（@vue/test-utils ^2.5.0、happy-dom ^20.14.0、@types/node、eslint-config-prettier ^10.1.8，均 MIT）；docs/design/DESIGN.md 标题与状态行对齐（均为已批准基线口径）。
验证命令 / 退出码 / 关键断言：
  - npm run test:unit：10 文件 60 例全绿。组件测试覆盖：Button 点击/禁用/加载（aria-busy+disabled+spinner）与原生键盘路径；Input label-for、v-model、aria-invalid+aria-describedby 错误关联、禁用；Dialog 原生模态 open、aria-labelledby 标题关联、关闭按钮、Esc→close 事件；Toast polite live region、error role=alert、手动与超时自动消失（fake timers）；Chip aria-pressed；Tabs aria-selected/roving tabindex/ArrowRight 换选；Dropzone 文件发射、input 可达、拖拽高亮与禁用忽略。
  - 对比度测试（tokens.test.ts 从 tokens.css 解析实际值计算 WCAG 对比度）：9 组文本/UI 配对全部达标——ink/bg、ink/surface、ink-secondary/surface、ink-secondary/bg、teal/surface（链接）、white/teal（主按钮 6.29:1）、white/danger（5.69:1）、ink/amber（5.29:1）、teal/line ≥3:1；无外部字体（无 url/@import/@font-face）；reduced-motion 降级存在。
  - npm run lint / format:check / typecheck（vue-tsc）/ build:workspaces（含 vite 构建）/ test:e2e 全部退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
  - 无运行时 CDN：组件无任何网络字体/脚本引用，依赖仅 vue（AGENTS §7 合规）。
  - 过程门禁生效记录：ToastHost 模板根注释导致多根 fragment 使 wrapper.attributes 读到注释节点（改注释入根内）；.vue 中 no-undef 误报 DOM 内建（规则对 .vue 关闭，由 vue-tsc 把关）；prettier 与 eslint-plugin-vue 格式规则冲突（eslint-config-prettier 统一收口）。
证据路径：本条目；apps/web/src/app/styles/（tokens.test.ts 为对比度证据）；apps/web/src/shared/ui/（组件与测试）。
风险或阻塞 / 下一项：tokens 色值为 DESIGN.md 提案值（待原图校准清单仍开放）；对比度按当前值验证，改值须重跑 tokens.test.ts；Tabs 仅导航（内容面板由页面接线）；Dropzone 严格校验（格式/大小/单图）属 U07。下一项：U02（五路由导航、响应式 Shell、404）。
```

```text
ID / 日期：U02 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/web/src/app/router.ts（history 模式五路由 + /studio/:templateId? 可选参 + 通配 404 + scrollBehavior）、shell/AppShell.vue（品牌+徽标、侧栏导航 ≥1024px / 顶栏导航 <1024px 纯 CSS 切换、skip link、aria-current 精确高亮、路由切换后焦点移至 main）、六个页面视图（HomePage/DiscoverPage/StudioPage/WorkspacePage/GuidePage 骨架 + StudioPage 无模板引导态 + NotFoundPage 404 返回总览）、App.vue 改为 Shell+RouterView+ToastHost、router.test.ts（7 例）；e2e/webapp-navigation.spec.ts（5 例）；playwright.config.ts 改双项目（static=serve.py:8178，webapp=vite preview:8179 含构建）；apps/web 依赖加 vue-router ^5.3.1（MIT；pinia 等为 optional peer 未引入）。
验证命令 / 退出码 / 关键断言：
  - npm run test:unit：11 文件 67 例全绿。路由断言：五路由名称解析、深链接 /studio/case-1 参数、无模板引导态、未知路径渲染 404 且有返回总览链接、memory history 的 back/forward（afterEach 等待导航完成——back/forward 返回 void）、导航五链接且 aria-current 恰一个、skip link 存在。
  - npm run test:e2e：6 例全绿（webapp 5 + static 1）。真实 Chromium + vite preview（SPA history fallback）：/guide 深链接刷新后仍在；侧栏导航点击 + goBack/goForward 内容随动；aria-current 精确跟随（当前页有、总览无）；480px 窄屏顶栏导航可用；/definitely/missing 显示 404 并可返回。
  - 键盘导航：导航为原生链接（Tab/Enter 原生路径），main tabindex=-1 接收路由切换焦点，skip link 跳转主要内容；E2E 覆盖鼠标路径，键盘路径由原生语义保证并在 U12 做专项回归。
  - 回归：lint / typecheck（vue-tsc）/ format:check / build:workspaces 退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
  - 过程修正记录：模板页骨架仅含占位文案（真实页面 U04–U11 交付）；E2E getByLabel('主导航') 因双导航地标命中两个元素，改为按容器作用域（侧栏/顶栏各自选择器）。
证据路径：本条目；apps/web/src/app/（router/shell/pages/测试）；e2e/webapp-navigation.spec.ts；playwright.config.ts。
风险或阻塞 / 下一项：history 模式深链接依赖宿主 SPA fallback（vite preview/dev 已证；生产 Nginx 配置属 O05）；StudioPage 占位为可引导骨架，模板数据由 U03 接入；锁屏导航折叠的视觉细节由 U12 截图回归核对。下一项：U03（catalog 数据层、按需提示词与图片懒加载）。
```

```text
ID / 日期：U03 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/web/src/entities/catalog/（types.ts 镜像 catalog.json 结构、api.ts 可注入 fetch 的目录/提示词请求器含超时与 schema 校验、store.ts Pinia store：status idle/loading/ready/error/empty、version=schemaVersion#generatedAt、按 id@promptSha256 缓存的按需提示词、全部终态可重试）、store.test.ts（8 例）、shared/ui/LazyImage.vue（loading=lazy + decoding=async + aspect-ratio 占位 + 失败可恢复态）及其测试（4 例）；修订 vite.config.ts（publicDir 指向仓库 public/ 使 dev/preview 同源可取 /data/catalog.json，copyPublicDir:false 不复制进构建产物——与 W05 静态独立一致）、main.ts 注册 pinia ^3、shared/ui/index.ts 导出 LazyImage。
验证命令 / 退出码 / 关键断言：
  - npm run test:unit：13 文件 79 例全绿。store 断言逐条对应验收：初始 load 仅请求 data/catalog.json 且零 TXT 请求；loadPromptText 按需拉取且第二次命中缓存（仅 1 次 TXT 请求）；prompt 失败按模板记录 error 并可重试成功；目录外模板报错不崩；目录请求 500 后重试 load() 恢复 ready；缓存版本 v1→v2 后 load() 平滑换版（模板数/版本号更新、提示词缓存清空）；空目录为可恢复 empty 态（再 load 恢复 ready）；畸形响应（HTML 代理错误页）按错误处理不崩。
  - LazyImage 断言：loading=lazy/decoding=async 属性、3/2 占位防布局位移、load 淡入 + error 后「预览不可用」状态可随 src 变更重置。
  - 回归：lint / typecheck / format:check / build:workspaces / test:e2e（webapp 预览现在同源服务静态目录，6 例仍全绿）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
  - 过程修正记录：空 baseUrl 时 new URL 相对路径抛错——api 改为同源时直接用相对路径交给 fetch 解析。
证据路径：本条目；apps/web/src/entities/catalog/（store.test.ts 为验收断言证据）；apps/web/src/shared/ui/LazyImage.vue。
风险或阻塞 / 下一项：数据层仅覆盖静态目录（服务端目录 API 首期不实现，ADR 0001 D-1）；缓存目前仅内存级（localStorage 缓存版本语义在 U10 本地记录任务中一并考虑）；发现页接线在 U04。下一项：U04（发现页搜索、分类、蓝图类型、排序与分页/增量展示）。
```

```text
ID / 日期：U04 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/web/src/features/discover/filtering.ts（纯函数筛选/排序/URL 参数净化：q 匹配标题/编号/分类/风格/场景、category/mode 精确过滤、zh collation 排序、PAGE_SIZE=24 增量）、DiscoverPage.vue（搜索框、排序、原始蓝图类型 chips、分类 chips、卡片网格 CSS columns 降列、增量加载更多、无结果态+清空筛选、错误/空目录重试态、URL query 双向同步 replaceState）、filtering.test.ts（8 例）、DiscoverPage.test.ts（7 例，stub catalog）；e2e/webapp-discover.spec.ts（4 例，真实 catalog 数据）；修订 router.ts（/discover 接入真实发现页，删除 app/pages/DiscoverPage.vue 骨架）、apps/web/vite.config.ts（新增 preview 静态目录中间件：仅白名单 /data 与 /previews、防路径穿越、正确 content-type——vite preview 不服务 publicDir 且 copyPublicDir:false，否则 catalog 请求被 SPA fallback 回成 index.html）。
验证命令 / 退出码 / 关键断言：
  - npm run test:unit：15 文件 94 例全绿。filtering 断言：文本搜索命中标题/编号/分类/场景、组合过滤、zh 排序、非法参数净化；页面断言：初始 ≤24 张+加载更多、蓝图 chips（全部/文生图/图生图——目录属性而非运行模式）、无结果+清空恢复、URL query 恢复筛选、筛选变更写回 URL、卡片含标题/编号/徽标/查看模板链接、LazyImage。
  - npm run test:e2e：10 例全绿（webapp 9 + static 1，真实 576 模板数据）：初始 24 张增量、共 576 计数、搜索 case-532 → URL q=case-532 且 1 卡、/discover?mode=image-to-image 刷新恢复（83 个图生图）、组合筛选、无结果+清空筛选后 URL 不再带 q。
  - preview 安全检查：/data/catalog.json 返回 200 application/json；curl --path-as-is /data/../package.json 返回 400（穿越被拒）。
  - 回归：lint/typecheck/format:check/build:workspaces 退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
  - 过程修正记录：catalog?.filters 少一层可选链导致部分 catalog 渲染抛错（未处理 rejection 门禁抓到）；E2E 失败根因即 preview 静态目录缺口（见上）。
证据路径：本条目；apps/web/src/features/discover/（filtering.test.ts、DiscoverPage.test.ts）；e2e/webapp-discover.spec.ts。
风险或阻塞 / 下一项：卡片收藏按钮按 DESIGN §5 属发现页卡片，但本地收藏功能在 U10 交付，U04 先不渲染按钮（避免无功能入口）；masonry 为 CSS columns 近似，视觉细节 U12 核对；URL 同步使用 router.replace（不产生历史噪音，前进后退由路由级测试覆盖）。下一项：U05（模板详情、来源、提示词区分、复制/下载）。
```

```text
ID / 日期：U05 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。数据管道修复：scripts/install_generated_previews.py 新增示例提示词 sidecar 安装/校验（catalog 引用的 45 个 data/generated-previews/{id}.prompt.txt 此前未进 public，引用悬空——本项先修复管道再接线 UI，npm run build 后 Installed/Verified 45，validate 通过）。新增 shared/platform/（hash.ts 复刻构建 stable_digest 语义——sha256(去尾部换行正文)；clipboard.ts 拒绝即抛错；download.ts DOM 隔离下载）、features/studio/StudioPage.vue（模板头/蓝图徽标/预览、来源卡——case 显作者+图册链接、framework 显上游文档，tabs「单图模板/示例实际提示词」、SHA-256 徽标含 ok/mismatch/unavailable 三态、复制成功与拒绝 Toast、下载 {id}.txt）、store 增 loadSamplePromptText/samplePromptStatus、api 增 getTextAsset（限 data/ 前缀）、types.ts 来源结构修正为真实形状、hash.test.ts（5 例，含真实 case-1 校验）、StudioPage.test.ts（7 例，stub catalog/prompt）、e2e/webapp-studio.spec.ts（5 例真实数据）。
验证命令 / 退出码 / 关键断言：
  - 哈希一致性（验收核心）：hash.test.ts 直接读 public/data/prompts/case-1.txt 与 catalog.promptSha256 比对通过——确认 promptSha256=sha256(去尾部换行正文)（首部排查：文件整体 sha 不匹配，构建脚本 stable_digest 语义定位后对齐）；E2E 断言页面展示正文逐字节等于磁盘 TXT、下载产物等于展示正文、文件名 case-1.txt。
  - 剪贴板拒绝反馈（验收核心）：单测 stub writeText 抛错 → toastState 收到「复制失败：浏览器拒绝了剪贴板访问…」error toast；成功路径收到 success toast；E2E 在 headless（剪贴板无权限）下点击复制必有 toast 出现（禁止单一失败模式）。
  - 示例/公共提示词区分：case-1（无 sidecar）示例页签显式「该模板没有已审阅的示例生成提示词」；framework-001 示例页签加载真实 sidecar 且与磁盘文件逐字节一致（45 个已随管道入 public）。
  - npm run test:unit：17 文件 105 例全绿；npm run test:e2e：15 例全绿（webapp 14 + static 1）；lint/typecheck/format/build:workspaces 退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
  - 过程抓到的真实缺陷（均已修）：①相对路径 data/… 在 /studio/:id 下解析为 /studio/data/… → api 基准改为 import.meta.env.BASE_URL 根相对拼接；②先于目录就绪打开工作台时提示词不补加载 → watch 增 store.status；③happy-dom crypto 无 subtle 导致校验态静默卡住 → 组件显式「校验不可用」态 + 测试补 node webcrypto。
证据路径：本条目；apps/web/src/features/studio/、apps/web/src/shared/platform/hash.test.ts、e2e/webapp-studio.spec.ts、scripts/install_generated_previews.py diff。
风险或阻塞 / 下一项：generatePromptPath 引用面已闭合（45/45 安装+校验），但 sidecar 内容无独立 manifest 哈希（预览图有）；运行模式/模型/隐私设置属 U08，本页未渲染生成控件。下一项：U06（总览页、最近模板及真实统计）。
```

```text
ID / 日期：U06 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 shared/platform/local-store.ts（单键 schemaVersion=1 版本化本地记录：favorites/recent；storage 访问全容错——不可用/损坏分别返回状态标志，recent 去重置顶限 20）、features/home/HomePage.vue（真实统计卡：全部模板/文生图/图生图取自 catalog、本地收藏取自本地记录；「本地模式：未连接生成服务」诚实服务行；最近查看空态与真实列表、本地存储不可用与记录损坏的显式警示条；三步使用流程 + 选模板 CTA；模板速览 4 卡）、local-store.test.ts（6 例）、HomePage.test.ts（7 例）；StudioPage 挂载时记录最近查看（存储失败静默不破坏浏览）；e2e/webapp-home.spec.ts（2 例真实数据）；router 接入真实首页并删除骨架。
验证命令 / 退出码 / 关键断言：
  - 验收逐条：①首次访问空态——「暂无最近查看的模板」（单测+E2E 首访断言）；②存储失败——stub localStorage 抛错 → 「本地存储不可用（隐私模式或权限受限）…」警示 + 收藏计数 0，页面功能不崩；损坏 JSON → 「本地记录格式无法识别，已按空记录处理」；③未配置服务——「本地模式：未连接生成服务。配置接口后才会出现上传与生成入口」，E2E 断言正文不含「在线」「任务数」，统计值为真实 catalog 值 576/493/83/0。
  - npm run test:unit：19 文件 118 例全绿；npm run test:e2e：17 例全绿（webapp 16 + static 1）；lint/typecheck/format/build:workspaces 退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
  - 过程抓到的真实缺陷（已修）：HomePage stats 未防御缺失 stats 字段的目录（router 测试最小 stub 暴露），改为防御性判空。
证据路径：本条目；apps/web/src/shared/platform/local-store.test.ts、apps/web/src/features/home/HomePage.test.ts、e2e/webapp-home.spec.ts。
风险或阻塞 / 下一项：收藏计数当前恒为 0（收藏 UI 在 U10 交付后生效）；「模板速览」为确定性目录切片非个性化推荐（避免虚构推荐语义）。下一项：U07（单图工作台选择、预览、移除与换模板）。
```

```text
ID / 日期：U07 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 features/studio/useInputImage.ts（单图协议组合式：仅 1 张、JPEG/PNG/WebP、20 MiB 客户端上限——服务端预审仍是安全边界；object URL 在替换/移除/卸载三处释放；错误消息常量化）、useInputImage.test.ts（7 例）；StudioPage 增「输入图（恰好一张）」区（Dropzone/预览/移除/错误 alert），并接入最近查看记录（U06 面）；StudioPage.test.ts 增 3 例（预览+移除、多图拒绝、格式与超限拒绝）；e2e/webapp-studio.spec.ts 增 2 例（真实 PNG 上传→预览→移除、多图经 DataTransfer 拖拽模拟拒绝、GIF 类型拒绝）。
验证命令 / 退出码 / 关键断言：
  - npm run test:unit：20 文件 128 例全绿。组合式断言：单图接受且恰好创建 1 个 object URL、多图/类型/超限拒绝并显式消息、替换时旧 URL 先 revoke、移除清空、组件卸载释放；页面断言：选择后预览与文件名/大小可见、移除恢复拖放区、多图错误 alert 文本精确、GIF 拒绝、21MiB 拒绝（真实大小文件）。
  - 旧异步结果不覆盖新模板：U05 已建 loadSequence 序号守卫并被现有测试覆盖（模板/页签切换仅最新结果生效）；本项复核通过。
  - npm run test:e2e：19 例全绿（webapp 18 + static 1）——真实 PNG 经 picker 上传预览、移除、DataTransfer 模拟拖拽双图 → 「单图协议」错误；lint/typecheck/format/build:workspaces 退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
  - 过程记录：VTU 无 setInputFiles（手动 defineProperty files + configurable:true + trigger change）；Playwright 拒绝对无 multiple 属性 input 设多文件 → 改页面内 DataTransfer 模拟拖拽路径。
证据路径：本条目；apps/web/src/features/studio/useInputImage.test.ts、StudioPage.test.ts、e2e/webapp-studio.spec.ts。
风险或阻塞 / 下一项：客户端大小校验为 UX 反馈，真实魔数/像素/字节校验属服务端 M02；图片目前不上传任何位置（U08 生成控件后才可能出网，且须显式触发）。下一项：U08（运行模式、模型/参数与隐私设置）。
```

```text
ID / 日期：U08 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 packages/contracts/src/provider-capabilities.ts（RunMode 三态 + ProviderCapabilities 能力模型：models 的 qualities/sizes/supportsInheritAspect 全部显式声明，gpt-image-2 与「自定义模型（能力未知）」种子注册表）、contracts index 再导出；apps/web/src/entities/settings/store.ts（SETTINGS_KEY 与 BYOK_KEY_STORAGE 分槽持久化——设置记录永不包含密钥；load 净化非法 runMode；setRunMode 零网络零迁移；persistence 不可用显式标注）、store.test.ts（6 例）、features/studio/SettingsDialog.vue（三模式单选——受管生成 disabled+「暂未开放：需要服务端身份与授权配置」、BYOK 面板：接口地址/模型/质量下拉全部来自能力注册表、比例固定「继承参考图」+ 不声明继承比例或能力未知时显式提示、密钥仅存本机提示与「清除本机密钥」、隐私三条说明、「切换模式不会上传本机密钥或图片」固定提示）；StudioPage 底部操作条（比例继承 + 运行模式回显 + 设置入口 + 生成按钮 disabled 且注明 W 阶段联调交付）。
验证命令 / 退出码 / 关键断言：
  - 密钥隔离（验收核心）：store.test 断言保存密钥后 SETTINGS_KEY 记录不含密钥字符串、BYOK_KEY_STORAGE 含密钥；模式来回切换 fetch spy 0 调用且密钥原样保留；清除仅动专用槽；存储不可用 → persistence='unavailable' 不抛错。
  - 能力驱动（验收核心）：模型下拉 = 注册表 2 项；质量下拉 = 所选模型声明的 high/medium/low；gpt-image-2 → 比例提示「可能被裁剪」（其 supportsInheritAspect=false），自定义模型 → 「能力未知，输出比例可能无法保持」+ 质量禁用「未知能力，暂无选项」；无任何硬编码参数猜测。
  - npm run test:unit：21 文件 135 例全绿；npm run test:e2e：20 例全绿（webapp 19 + static 1）——E2E 覆盖：受管模式禁用+提示、切换 BYOK 保存、settings 记录无密钥/专用槽有密钥、reload 后设置与密钥均保留且显示「不会随模式切换上传、迁移或同步」。
  - lint/typecheck/format/build:workspaces 退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
  - 过程抓到的真实缺陷（已修）：SettingsDialog 用 let 变量绑定模板 ref 失效导致 showModal 永不触发（改 useTemplateRef——与 U01 Dialog.vue 同类问题）；旧 contracts dist 缺新导出需重建。
证据路径：本条目；apps/web/src/entities/settings/store.test.ts、features/studio/SettingsDialog.vue、e2e/webapp-studio.spec.ts、packages/contracts/src/provider-capabilities.ts。
风险或阻塞 / 下一项：能力注册表为前端种子（gpt-image-2 声明基于上游文档口径，sizes 含 auto/1024x1024/1536x1024/1024x1536），受管模式真实能力由 J04 服务端提供后替换；生成按钮 disabled 是诚实占位，直接 BYOK 发送在 W01/W05 联调。下一项：U09（任务状态组件）。
```

```text
ID / 日期：U09 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/web/src/shared/ui/TaskStatusBadge.vue（8 状态徽标：created/queued/running/succeeded/failed/cancelled/expired/outcome_unknown，标签色调用已验证 AA 的 token 配对；outcome_unknown 明文「结果未知，不会自动重试；请通过查询或人工处置确认」且无任何重试控件；expired 明文「结果媒体已过期；历史成功记录保留」；cancelled「取消不保证免计费」；cancelRequested 且排队/运行中时显式「已请求取消，不保证免计费」而不谎称已取消；非法状态回退「未知状态」+ 中性 info 色不冒充真实状态）、TaskStatusBadge.test.ts（12 例）、index.ts 导出。
验证命令 / 退出码 / 关键断言：
  - npm run test:unit：22 文件 147 例全绿。逐状态标签与 role=status 断言（8 例参数化）；outcome_unknown 断言文本含「不会自动重试」且去掉该短语后全文不含「重试」（验收：不显示一键自动重试）；expired 断言保留历史成功表述；cancelRequested 断言「已请求取消，不保证免计费」且主标签仍为「生成中」；非法状态断言回退标签与中性配色。
  - 回归：lint/typecheck/format/build:workspaces/test:e2e（20 例）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
证据路径：本条目；apps/web/src/shared/ui/TaskStatusBadge.vue 及其测试。
风险或阻塞 / 下一项：徽标为独立组件，真实任务接线在 W01/W02（含 outcome_unknown 的处置入口语义由后端 B/J 提供）；「取消请求」为 UI 过渡表述，状态机终态仍是 contracts 的 cancelled。下一项：U10（本地收藏、集合、记录视图及导入导出 UI）。
```

```text
ID / 日期：U10 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。扩展 shared/platform/local-store.ts（LocalRecord 增 collections；toggleFavorite/createCollection/deleteCollection；mergeImport 纯函数——先解析校验再合并：favorites 并集去重、recent 按 id 留最新、collections 按 id 合并成员，坏 JSON/schema 版本不符返回显式错误且不落盘）、features/workspace/WorkspacePage.vue（四区视图：本地收藏网格+取消收藏、最近查看、生成记录诚实空态「生成功能联调交付后…」、本地集合创建/删除；工具条 导出本地记录/导入记录；存储不可用与记录损坏警示条；隐私行「清理浏览器数据可能移除记录；导出文件是唯一的本机备份方式」）、StudioPage 详情头增收藏按钮（存储失败 toast 反馈）、WorkspacePage.test.ts（8 例）、local-store 扩展测试、e2e 增 3 例（收藏→工作区可见、坏 JSON 反馈且数据不丢、导出内容不含 BYOK 密钥）；router 接入真实工作区并删骨架。
验证命令 / 退出码 / 关键断言：
  - 坏 JSON：mergeImport('{broken') → 'bad-json'；UI toast「导入失败：文件不是有效 JSON」且既有收藏保留（E2E+单测双重断言）。
  - 重复项：导入 favorites ['case-1','case-1','case-2'] → 存储并集去重 ['case-1','case-2']，toast 报告合并计数。
  - schema 版本：schemaVersion 99 → 「schema 版本不符」错误反馈。
  - localStorage 不可用：写入抛错 → 「本地存储不可用，导入未能保存」，不静默丢数据。
  - 密钥不外泄（验收核心）：BYOK 密钥存于独立槽 onepic.byok.key.v1，导出函数只读 LOCAL_RECORD_KEY；单测+E2E 均断言导出内容不含 'sk-…'；导入路径也从不读取密钥槽。
  - npm run test:unit：23 文件 155 例全绿；npm run test:e2e：23 例全绿（webapp 22 + static 1）；lint/typecheck/format/build:workspaces 退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
证据路径：本条目；apps/web/src/features/workspace/WorkspacePage.test.ts、apps/web/src/shared/platform/local-store.test.ts、e2e/webapp-studio.spec.ts。
风险或阻塞 / 下一项：集合目前不支持添加成员（模板加入集合的交互未在 DESIGN 明确，留待后续补充）；生成记录区为空态（W01 联调后由任务数据填充）。下一项：U11（指南页）。
```

```text
ID / 日期：U11 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 features/guide/GuidePage.vue（标题「图片决定内容，蓝图决定风格」；流程 上传一张图片＋选择视觉蓝图→生成结果；生效优先级 1 图>2 蓝图>3 示例内容；提示词结构四条——[System / Prompt] 开头/单图不追问保比例/BEGIN-END VISUAL BLUEPRINT/只返回成品图；蓝图类型两卡；来源与追溯段含编号/署名/上游链接/MIT/SHA-256；运行模式三态与 U08 实际选项一致且受管标「未开放」；页脚「数据只在你点击生成后直连自定义接口；本站无遥测」；Nano Banana Pro 表述为可用时首选而非唯一）、GuidePage.test.ts（6 例）、e2e 导航套件增 1 例；router 接入并删骨架。
验证命令 / 退出码 / 关键断言：
  - 验收逐条：①与实际模式一致——模式三种与 U08 设置面板同名同态，受管显式「未开放」，文案引用「配置接口与隐私」真实入口；②无违禁文案——单测与 E2E 均断言不含「禁止直接图生图」「禁止图生图」「零中转」「完全不上传」；页脚保留诚实直连表述。
  - npm run test:unit：24 文件 161 例全绿；npm run test:e2e：24 例全绿（webapp 23 + static 1）；lint/typecheck/format/build:workspaces 退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
证据路径：本条目；apps/web/src/features/guide/GuidePage.test.ts；e2e/webapp-navigation.spec.ts。
风险或阻塞 / 下一项：指南页说明与后端受管模式实装（B 阶段）保持同步的责任在 Z02 文档同步轮。下一项：U12（桌面/移动与无障碍回归）。
```

```text
ID / 日期：U12 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 e2e/webapp-responsive.spec.ts（18 例：五页 × 320/768/1440 渲染且 documentElement.scrollWidth ≤ clientWidth 无横向溢出 + 逐页全页截图、reduced-motion 前后探针对比、skip link/Enter 聚焦 main/有界 Tab 到导航链接断言 :focus-visible ≥2px solid 焦点环、最长真实标题 320px 搜索无溢出）；StudioPage 输入预览容器补 flex-wrap 防溢出；对照截图落盘 docs/design/evidence/u12/（15 张 PNG，5.3MB，逐张经 PIL 解码验证非空且尺寸正确）。
验证命令 / 退出码 / 关键断言：
  - npm run test:e2e：42 例全绿（responsive 18 + 既有 24）。320/768/1440 × 五页零横向溢出；reduced-motion 下探针 animation-duration 序列化为 1e-05s（=0.01ms，Chromium 计算样式格式）、无偏好时 1s——tokens.css 媒体查询生效；键盘路径：Tab→skip link→Enter→main-content 获得焦点（poll activeElement.id），导航链接 :focus-visible 焦点环 solid ≥2px；320px 最长真实标题（按 catalog 运行时排序取最长）搜索结果无溢出。
  - 截图有效性：15/15 PIL 解码通过，尺寸与视口/内容匹配，颜色多样性证实非空白。
  - 回归：lint/typecheck/format/build:workspaces/test:unit（161 例）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
可接受偏差（记录）：
  1. 对照基线为 DESIGN.md（文本推导、用户批准），非 2026-09-05 原图——像素级保真永久不可验（D03/D04 既有残余风险，Z04 须列出）。
  2. masonry 以 CSS columns 近似（列内顺序排布，非行平衡最优）；五页栅格断点 4/2/1 列与 DESIGN §3 一致。
  3. 工作台当前为两列布局（预览+来源 / 输入图 / 提示词纵排），DESIGN §4.3 的三列生成工作台在 W01 联调接入生成流后补齐。
  4. 品牌为文字+「设计概念」徽标，未做图形 logo（重建图间 logo 亦不一致，按 README 纠正项不照搬）。
  5. 200% 缩放以 320px 视口 + 最长真实文案近似覆盖，未穷举浏览器缩放矩阵；字体阶梯沿用 tokens 提案值（待校准清单仍开放）。
证据路径：docs/design/evidence/u12/（15 张对照截图）；e2e/webapp-responsive.spec.ts；本条目。
风险或阻塞 / 下一项：U 阶段全部完成；真实联调（W 阶段）依赖 B/M/J 后端实现。下一项：B01（PG migrations——后端实现起点）。
```

```text
ID / 日期：B01 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/api/migrations/0001_identity_and_catalog.sql（subject/session/catalog_release/template_version——(issuer,subject_claim) 唯一、token_sha256 唯一、library_sha256 唯一、(template_key,version) 与 (template_key,compiled_prompt_sha256) 双唯一）、0002_generation.sql（media_object 隔离区状态机 check + (bucket,object_key) 唯一 + (owner_id,kind)/(state,expires_at) 索引、upload 一对一、precheck (subject_id,created_at) 索引、generation 8 状态 check + (owner_id,idempotency_key) 唯一 + (owner_id,created_at DESC)/(state) 索引、attempt (generation_id,attempt_no) 唯一 + provider_request_id 索引、result 一任务一结果、job 租约字段 + (state,run_after)/(lease_expires_at) 索引、quota_ledger (generation_id,reason) 唯一）、0003_workspace_and_audit.sql（collection (owner_id,name) 唯一、collection_item PK 幂等 + ON DELETE CASCADE、audit_event、deletion_manifest）；新增 src/db/migrate.ts（版本化执行器：schema_migrations 记账、逐迁移事务、幂等重跑、to 版本门控）、src/db/migrate-cli.ts（DATABASE_URL 经 loadConfig 校验，错误不打印 URL）、migrations.integration.test.ts（8 例）。
验证命令 / 退出码 / 关键断言：
  - npm run test:integration：11 例全绿（迁移 8 + 设施 3）。空库迁移 16 张表齐全且重跑 no-op；增量升级（to:1 → 只有 subject/session 等早期表，再升到头 [2,3] 全表）；FK 违规拒绝（虚构 template_version/precheck/media 引用）；(owner_id,idempotency_key) 唯一冲突拒绝（完整合法外键链：catalog_release→template_version→media_object→precheck→generation）；job.state 非法值 check 拒绝；quota (generation_id,reason) 二次记账拒绝；collection_item ON CONFLICT DO NOTHING 幂等且集合删除级联；15 个字典关键索引（pg_indexes）全部在位。
  - 迁移 CLI 实跑：真实 PG16 上 DATABASE_URL=node dist/db/migrate-cli.js 首次 applied=[1,2,3]、二次 applied=[]（幂等），退出码 0；期间抓到并修复真实 bug——ESM 产物中 __dirname 不存在（ERR_AMBIGUOUS_MODULE_SYNTAX），改 import.meta.url 定位 migrations 目录。
  - 回归：lint/typecheck/format/build:workspaces/test:unit（161）/test:e2e（42）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
证据路径：本条目；apps/api/migrations/、apps/api/src/db/migrate.ts、apps/api/test/migrations.integration.test.ts。
风险或阻塞 / 下一项：迁移内容按 D06 数据字典实现，字段级语义（如保留策略默认值）随产品确认可能微调（expand/contract 已具备版本化基础）；审计事件 detail 基数控制属 O02。下一项：B02（导入不可变模板 release 与精确 prompt 快照）。
```

```text
ID / 日期：B02 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/api/src/modules/catalog/import.ts（importCatalogRelease：读 public/data/catalog.json + data/library/templates.json + 逐个 shipped prompt TXT；写入前逐模板校验 sha256(去尾换行正文)==promptSha256，任一不符抛 ImportHashMismatchError 全量拒绝；library_sha256 为幂等锚——同库重复导入返回既有 release 不写行；(template_key, compiled_prompt_sha256) 已存在的未变更内容复用既有不可变版本行，不 fork 新 version；blueprint_sha256 取自 BEGIN/END VISUAL BLUEPRINT 段；metadata jsonb 收录 title/kind/category/styles/scenes/tags/language/mode/blueprintInputMode/requiresText/source；catalog/catalog-import.test 走事务）、catalog-import.integration.test.ts（4 例，临时夹具目录 + 临时 PG 集群）。
验证命令 / 退出码 / 关键断言：
  - 哈希不符拒绝：篡改夹具 prompt 正文 → ImportHashMismatchError（单测）；真实语义由 stablePromptBody 对齐构建 stable_digest。
  - 重复导入幂等：同 library 二次导入 created=false 且 template_version 行数不变。
  - 旧任务取原版本：succeeded generation 指向 v1 → 导入内容变更产生 v2（version=2）后 JOIN 回读仍为 version=1（内容行不可变）。
  - 不写源目录：夹具四文件 SHA-256 基线（改夹具后、导入前取）与导入后完全一致。
  - 首次导入 created=true、两模板各建 version 1。
  - npm run test:integration：15 例全绿（B02 4 + 迁移 8 + 设施 3）；lint/typecheck/build:workspaces/test:unit/test:e2e 退出码 0；ci-verify.sh 退出码 0。
  - 过程修复：import.ts 同样存在 __dirname ESM 问题（改 import.meta.url）；(template_key,prompt_sha) 唯一约束要求未变更内容复用版本行（初版 MAX+1 插入会撞唯一约束，改为先查后插）。
证据路径：本条目；apps/api/src/modules/catalog/import.ts、apps/api/test/catalog-import.integration.test.ts。
风险或阻塞 / 下一项：导入器当前为库函数（CLI/API 端点接线随 W/O 阶段运维流程）；blueprint_sha256 的段提取口径为「含 END 标记、去尾换行」，与构建端蓝图一致性待 M05 维护流程复核。下一项：B03（身份端口、OIDC 登录/退出与会话）。
```

```text
ID / 日期：B03 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/api/src/modules/identity/port.ts（IdentityProviderPort/SessionRepositoryPort/Subject 领域端口）、oidc-adapter.ts（发现文档获取、授权码+PKCE S256 challenge、state/nonce 一次性消费、ID token 经远程 JWKS 验签 + issuer/audience/exp 校验 + nonce 手动比对——jose v6 移除了 nonce 选项）、pg-session-repository.ts（opaque token 仅存 sha256、过期/撤销/轮换 rotated_from 溯源、subject upsert (issuer,subject_claim) 幂等）、src/db/queryable.ts（Client/Pool/PoolClient 共同结构类型，仓储不依赖具体驱动）、bootstrap/identity-routes.ts（login 302→OIDC、callback→upsert subject→建会话→cookie、me、refresh 轮换、logout 撤销；cookie HttpOnly+SameSite=Lax+按 redirect scheme 决定 Secure；CSRF 守卫：非 GET 需 Origin==允许来源且带 x-onepic-requested-with 自定义头，失败 403 FORBIDDEN 信封）；bootstrap/app.ts 在 OIDC+DB 均配置时装配（managed 语义不变）；新依赖 jose ^6.2.12（MIT）。
验证命令 / 退出码 / 关键断言：
  - npm run test:integration：22 例全绿（identity 7 + 迁移 8 + 导入 4 + 设施 3）。identity 7 例覆盖：全流程 login(302+S256 challenge+pending cookie)→假 Issuer 授权→callback(302+HttpOnly/SameSite cookie)→me(camelCase subject, member)；state 篡改 401；wrongNonce/expired/wrongIssuer 三种 token 全部 401；refresh 轮换后旧 token 401/新 token 200；logout 撤销后 401；DB 直改 expires_at 过期→401；CSRF：无 Origin 403、错 Origin 403、缺自定义头 403（FORBIDDEN 稳定码）。
  - lint 边界抓到真实违规：路由注册文件放 modules/ 引入 fastify——按架构 §4 移至 bootstrap/identity-routes.ts，modules/identity 保持框架无关。
  - 过程修复：identity 库未跑迁移（relation missing）；fastify reply.header('set-cookie') 两次调用互相覆盖致会话 cookie 丢失（改数组形式）；jose v6 nonce 选项移除（手动校验）。
  - 全量回归：lint/typecheck/build:workspaces/test:unit（161）/test:integration（22）/test:e2e（42）退出码 0；ci-verify.sh 退出码 0。
证据路径：本条目；apps/api/src/modules/identity/、apps/api/src/bootstrap/identity-routes.ts、apps/api/test/identity.integration.test.ts。
风险或阻塞 / 下一项：pending-challenge 存内存为单节点首期设计（多节点需共享存储，ADR 0001 范围内为单机）；CSRF 允许来源取自 redirect URI origin（多来源部署需扩展配置）；refresh 端点未做使用间隔限制（B05 限流覆盖）。下一项：B04（对象级授权与管理员边界）。
```

```text
ID / 日期：B04 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/api/src/modules/policy/access.ts（decideObjectAccess：actor/ownerId/action 三元判定——未认证 UNAUTHENTICATED；本人全通过；他人一律 FORBIDDEN 且 foreign=true（调用方映射 404 防存在性泄露）；管理员仅 read-metadata 放行，read-media 与 write 对他人对象同样拒绝——管理员无默认图片读取权，权限矩阵 §4）、policy.integration.test.ts（7 例：决策函数语义 + SQL 层 owner 过滤实证——A/管理员/匿名对 B 的 media_object 与 collection 计数均为 0，B 自身为 1）。
验证命令 / 退出码 / 关键断言：
  - 决策矩阵（7 例）：null→UNAUTHENTICATED；B 对自有对象 read-metadata/read-media/write 全过；A 对 B 全部动作 FORBIDDEN+foreign；admin 对 B read-metadata 通过但 read-media/write FORBIDDEN。
  - SQL 层隔离：owner_id 过滤查询下 A/admin/匿名对 B 的媒体与集合可见数为 0，B 为 1——决策函数与查询形态共同构成对象级授权，后续 M/J 端点直接复用。
  - npm run test:integration：29 例全绿（policy 7 + identity 7 + 迁移 8 + 导入 4 + 设施 3）；lint/typecheck/build:workspaces/test:unit（161）/test:e2e（42）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
证据路径：本条目；apps/api/src/modules/policy/access.ts、apps/api/test/policy.integration.test.ts。
风险或阻塞 / 下一项：decideObjectAccess 为纯决策层，签名下载链接的授权挂接在 M03；admin 元数据审计可见性细节属 O02。下一项：B05（配额、速率和并发限制）。
```

```text
ID / 日期：B05 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/api/src/modules/quota/service.ts（QuotaService：reserve 在事务内以 pg_advisory_xact_lock(subject) 串行化后核算已用量并插入 quota_ledger(-1, reserve)，(generation_id,reason) 唯一冲突=幂等 ALREADY_RESERVED 不重复扣账；release 仅允许 failed/cancelled 终态（outcome_unknown/succeeded/queued/running/created 一律 ILLEGAL_RELEASE——未知付费结果绝不自动释放），+1 release 同样幂等；activeGenerations 供并发上限判定；支持 Client（单连接顺序）与 Pool（并行时逐事务检出独立连接））、modules/policy/rate-limit.ts（滑动窗口限流器，按 subject+action 低基数键；safeQuotaError 清洗含 sk-/Bearer 的错误消息）、quota.integration.test.ts（9 例）。
验证命令 / 退出码 / 关键断言：
  - 幂等：同 generation 二次 reserve → ALREADY_RESERVED（不双扣）；failed 任务 release 一次后二次 → ALREADY_RESERVED。
  - 未知不释放（验收核心）：outcome_unknown 与 succeeded 任务 release → ILLEGAL_RELEASE。
  - 并发不超额（验收核心）：独立 subject、Pool 路径、limit=2、5 个并行 reserve → 恰好 2 成功 3 QUOTA_EXCEEDED；将其一置 failed 后 release 腾出名额，后续 reserve 成功。
  - 限流：3 次/窗 后第 4 次拒绝且 retryAfterSeconds>0；不同 subject 不受影响。
  - 密钥不泄漏：safeQuotaError 对含 sk-/Bearer 消息返回 'internal quota error'。
  - npm run test:integration：36 例全绿（配额 9 + policy 7 + identity 7 + 迁移 8 + 导入 4 + 设施 3）；lint/typecheck/build:workspaces/test:unit（161）/test:e2e（42）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
  - 过程修复：pg Client 也有 connect()，isPool 判别改用 Pool 特有 totalCount；并发测试需独立 subject（先前测试的 unknown/succeeded 预留正确地不释放，会占额度——测试假设错误非实现错误）。
证据路径：本条目；apps/api/src/modules/quota/service.ts、modules/policy/rate-limit.ts、apps/api/test/quota.integration.test.ts。
风险或阻塞 / 下一项：限流为内存实现（单节点首期，多节点需集中存储——ADR 0001 范围内为单机）；配额 limit 默认值随产品确认；J01 创建任务时接线 reserve。下一项：B06（统一错误/关联 ID/健康检查）。
```

```text
ID / 日期：B06 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/api/src/bootstrap/errors.ts（AppError(code/status/details)；onRequest 钩子生成或透传 x-correlation-id（≤128 字符防注入）并回写响应头；setErrorHandler——fastify 校验失败→400 VALIDATION_FAILED（仅暴露 instancePath）、AppError→稳定码/状态、未知错误→500 INTERNAL「Internal server error」（堆栈与内部消息仅入服务端日志）、全部 ApiFailure 信封含 correlationId；setNotFoundHandler→404 NOT_FOUND 信封）；health.ts 就绪探针升级为依赖感知——DATABASE_URL 配置时探测 PG SELECT 1（2s 超时）返回 ok/degraded，绝不探测 provider（B06：健康检查不触发付费探测）、live 恒 ok；errors.health.test.ts（7 例）。
验证命令 / 退出码 / 关键断言：
  - 信封：校验失败 400 VALIDATION_FAILED + correlationId（无 stack 字样）；AppError 429 RATE_LIMITED 原样透出；意外错误 500 INTERNAL——响应体不含 'hunter2'/'secret stack'（堆栈/密钥不泄漏，验收核心）；404 NOT_FOUND 信封。
  - 关联 ID：请求头 x-correlation-id 原样回显；未携带时生成新 UUID。
  - 健康：PG 不可达（connect mock 抛错）→ ready 200 degraded；live 恒 200 ok；全程零 provider 调用。
  - npm run test:unit：25 文件 167 例全绿；lint/typecheck/build:workspaces/test:integration（36）/test:e2e（42）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
证据路径：本条目；apps/api/src/bootstrap/errors.ts、errors.health.test.ts、health.ts diff。
风险或阻塞 / 下一项：correlationId 已贯穿响应头与错误体，结构化脱敏日志聚合属 O02；限流挂接（429 RATE_LIMITED）已具备 AppError 通道，随 W01 联调接线。B 阶段全部完成。下一项：M01（上传创建、隔离区与完成确认）。
```

```text
ID / 日期：M01 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/api/src/infra/storage/storage.ts（StoragePort 端口 + LocalDiskStorage 本地适配器：仅接受 [a-z0-9_-] bucket 与无 .. 的键，路径解析越界即 FORGED_OBJECT_PATH；生产 S3 适配器同接口后换）、modules/media/upload-service.ts（createUpload：声明值预检 20MiB/JPEG-PNG-WebP、服务器生成对象键 ownerId/UUID、CTE 同事务建 media_object(quarantine) + upload、1h 过期；putQuarantineBytes：owner 校验/过期拒绝/字节数必须等于声明值（pg bigint 字符串陷阱已修）；confirmUpload：owner 校验/过期拒绝/字节完整存在/UPDATE ... WHERE confirmed_at IS NULL 防双确认、sha256 落库；全程未确认与 quarantine 状态由 M04 预审把关）、upload.integration.test.ts（8 例）。
验证命令 / 退出码 / 关键断言：
  - 验收逐条：owner——B 对 A 的上传 put/confirm 均 FORBIDDEN；过期——DB 置 expires_at 过去 → UPLOAD_EXPIRED；重复完成——二次 confirm ALREADY_CONFIRMED；未上传完——无字节与短字节均 INCOMPLETE_UPLOAD；伪造对象路径——storage 层 '../escape'、bucket '../evil'、'a/../../etc/passwd' 全部 FORGED_OBJECT_PATH；未确认对象不可生图——未确认会话状态恒为 quarantine 且 unconfirmed=true（M04 预审只接受 ready+confirmed）。
  - 服务器生成键断言：objectKey 形如 {ownerUUID}/{UUID}，客户端无路径话语权。
  - npm run test:integration：44 例全绿（upload 8 + 配额 9 + policy 7 + identity 7 + 迁移 8 + 导入 4 + 设施 3）；lint/typecheck/build:workspaces/test:unit（167）/test:e2e（42）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
  - 过程修复：pg bigint 列返回字符串（'66' !== 66 导致误判 INCOMPLETE）→ Number 归一。
证据路径：本条目；apps/api/src/infra/storage/storage.ts、apps/api/src/modules/media/upload-service.ts、apps/api/test/upload.integration.test.ts。
风险或阻塞 / 下一项：本层为服务级；HTTP 路由与签名上传 URL 的接线在 M03（私有存储 + 短期签名）；魔数/解码校验属 M02（confirm 后进入 ready 需过 M02）。下一项：M02（魔数、真实解码、MIME、字节/像素、方向检查）。
```

```text
ID / 日期：M02 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/api/src/modules/media/validate-image.ts（validateImage：魔数白名单 PNG/JPEG/WebP（GIF 签名不在列即动画拒绝）、声明 MIME 与内容一致性、真解码 sharp limitInputPixels=40MP + timeout 10s（libvips 处理上限，解码失败 MALFORMED_IMAGE）、pages>1 动画拒绝、SVG/文本载荷拒收、EXIF orientation 记录（单图协议保方向）、字节 20MiB 前置；尺寸谎言/压缩炸弹经真解码拦截而非信头）、validate-image.test.ts（8 例，夹具全部进程内合成）；新依赖 sharp ^0.35.4（Apache-2.0，捆绑 libvips LGPL-3.0 动态链接——许可例外与理由已记入 ADR 0002，残余风险列 Z04）。
验证命令 / 退出码 / 关键断言：
  - 假后缀：GIF 字节声明 image/png → UNSUPPORTED_MEDIA_TYPE；SVG 文本载荷 → UNSUPPORTED_MEDIA_TYPE。
  - 压缩炸弹/超限：9000×9000（81MP）PNG 压缩体仅几 KB，真解码触发 PIXEL_LIMIT_EXCEEDED；21MiB 字节载荷 → PAYLOAD_TOO_LARGE。
  - 真实解码：截断 PNG → MALFORMED_IMAGE（信头完整但解码失败）；320×200 PNG 与 JPEG → 实测宽高/MIME/字节。
  - 方向：EXIF orientation=6 → 记录 6（协议保方向）。
  - npm run test:unit：26 文件 175 例全绿；lint/typecheck/build:workspaces/test:integration（44）/test:e2e（42）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
  - 过程修复：sharp v0.35 无命名导出 metadata（用默认工厂 + .metadata() 链）；timeout 是链式方法非构造选项。
证据路径：本条目；apps/api/src/modules/media/validate-image.ts、apps/api/test/validate-image.test.ts、docs/adr/0002-dependency-baseline.md。
风险或阻塞 / 下一项：libvips LGPL 动态链接例外已记 ADR 0002 + Z04 待列；方向仅记录未归一（交给 provider 原样保持比例与方向）。下一项：M03（私有存储端口和签名访问）。
```

```text
ID / 日期：M03 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 modules/media/signed-access.ts（signMediaPath/verifySignedMedia：HMAC-SHA256 over method:bucket:key:owner:expires，timingSafeEqual 防时序，过期→MEDIA_EXPIRED 410，篡改→FORBIDDEN 403，owner 绑进签名）；bootstrap/app.ts 增 GET /api/v1/media/:bucket/* 路由——签名校验 + 会话主体必须等于签名 owner（泄露链接给他人永远 404）+ storage.get + Cache-Control: private, no-store；storage 根取 config.mediaStorageRoot（新 env MEDIA_STORAGE_ROOT，无默认写死路径）；media-access.integration.test.ts（4 例）。
验证命令 / 退出码 / 关键断言：
  - 真实本地读写：LocalDiskStorage put/get 字节相等（本机临时目录）。
  - 无公共 ACL：所有媒体 GET 必须带有效签名 + 匹配会话；无路由可匿名读对象。
  - 短期失效：ttl=-10 → 410 MEDIA_EXPIRED；篡改签名 → 403。
  - 跨用户失败（验收核心）：为 B 签发的链接由 A（会话）请求 → 404 FORBIDDEN；匿名请求 → 404。
  - 私有缓存策略：200 响应含 Cache-Control: private, no-store。
  - npm run test:integration：48 例全绿（媒体访问 4 + upload 8 + 配额 9 + policy 7 + identity 7 + 迁移 8 + 导入 4 + 设施 3）；lint/typecheck/build:workspaces/test:unit（175）/test:e2e（42）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
  - 过程修复：fastify 通配路由取 params['*'] 且带前导斜杠需归一；数据库标签含连字符会让 CREATE DATABASE 报语法错（夹具改下划线）。
证据路径：本条目；apps/api/src/modules/media/signed-access.ts、apps/api/test/media-access.integration.test.ts、bootstrap/app.ts diff。
风险或阻塞 / 下一项：签名密钥复用 sessionSecret（可拆独立 MEDIA_SIGNING_KEY）；生产 S3 适配器替换 LocalDiskStorage 时接口不变；清理流程（O01）将撤销过期对象。下一项：M04（提交前预审）。
```

```text
ID / 日期：M04 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/api/src/modules/media/precheck-service.ts（promoteToReady——M02 真解码应用于隔离区字节：确认+解码通过才置 ready 并落实测 mime/bytes/width/height，失败置 rejected；createPrecheck——协议守卫（settings 含 prompt/effectivePrompt 即 PROMPT_REWRITE_BLOCKED，禁止前台改词）、模板版本必须来自 B02 导入（TEMPLATE_VERSION_MISMATCH）、能力驱动参数（模型/质量来自 @onepic/contracts 注册表，aspect 仅 inherit）、passed 写入 1h 有效期；失败也落库 error_code/error_detail 可审计；validateForGeneration——J01 门：passed/未过期/属主/template_version 与 input object 逐一匹配，替换输入或换版本均拒）、precheck.integration.test.ts（5 例，B02 合成目录导入）。
验证命令 / 退出码 / 关键断言：
  - 有效预审通过且 J01 门放行（匹配 version+input）；PROMPT_REWRITE_BLOCKED（带 prompt 的 settings）；TEMPLATE_VERSION_MISMATCH（case-404）；VALIDATION_FAILED（未知模型/不支持质量）；QUARANTINE_NOT_READY（未确认上传）。
  - 过期预审 → 拒绝；输入替换 → VALIDATION_FAILED；版本替换 → TEMPLATE_VERSION_MISMATCH（验收核心三项）。
  - npm run test:integration：53 例全绿（precheck 5 + 媒体 4 + upload 8 + 配额 9 + policy 7 + identity 7 + 迁移 8 + 导入 4 + 设施 3）；lint/typecheck/build:workspaces/test:unit（175）/test:e2e（42）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
  - 过程修复：夹具 PNG 手工 hex 不完整 → sharp 合成真实 PNG；夹具 promptSha256 用导入器同源哈希函数计算。
证据路径：本条目；apps/api/src/modules/media/precheck-service.ts、apps/api/test/precheck.integration.test.ts。
风险或阻塞 / 下一项：预审 settings 的完整 provider 能力校验以注册表为准（自定义模型能力未知时按拒绝处理）；M05 维护流程将依赖 template_version 的唯一约束产生新版本。下一项：M05（prompt 版本绑定和预审变更流程）。
```

```text
ID / 日期：M05 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。扩展 apps/api/src/modules/catalog/import.ts（每次新建 template_version 时写入 audit_event action='template_version_created'，detail 仅含 previousCompiledPromptSha256/compiledPromptSha256/catalogReleaseId——哈希级差异、无提示词正文；返回 changes 数组）、prompt-versions.integration.test.ts（2 例）。
验证命令 / 退出码 / 关键断言：
  - 维护流程（验收核心）：v1 导入 → 改源提示词（编译管线在真实流水线中重算哈希）→ 再导入 → v2 版本创建（version=2，previousSha=v1 哈希、newSha=v2 哈希），audit_event 留哈希级差异且不含正文；v1 行原样保留（差异保留、不可变）。
  - 运行时阻断（验收核心）：M04 的 PROMPT_REWRITE_BLOCKED 守卫已在 precheck 层测过——settings 带 prompt 即拒，静默重写无通道；generation 只能引用 precheck 绑定的 template_version（J01 门在 M04 validateForGeneration 中测过）。
  - 未变更重导入：版本数与审计行数均不变（幂等）。
  - 源目录只读：导入后夹具 prompt 文件内容仍为维护者写入的 v2（导入不改写源）。
  - npm run test:integration：55 例全绿（M05 2 + precheck 5 + 媒体 4 + upload 8 + 配额 9 + policy 7 + identity 7 + 迁移 8 + 导入 4 + 设施 3）；lint/typecheck/build:workspaces/test:unit（175）/test:e2e（42）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
证据路径：本条目；apps/api/src/modules/catalog/import.ts diff、apps/api/test/prompt-versions.integration.test.ts。
风险或阻塞 / 下一项：M 阶段全部完成；真实编译链哈希一致性由 B02 对 public 产物的校验保证（夹具测试用同源哈希函数）；audit detail 的基数策略符合 O02。下一项：J01（POST generation 与幂等）。
```

```text
ID / 日期：J01 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/api/src/modules/generation/create.ts（GenerationService.create：precheck 门校验（属主/passed）→ 请求指纹 sha256(templateVersionId+inputObjectId+settings+provider+model) → 快路径重放 + 事务内 (owner_id,idempotency_key) 唯一冲突捕获双保险 → 以预生成 UUID 插入 generation（SELECT...JOIN precheck/tv/media 保证字段来自不可变版本与真实输入）→ 配额预留（同事务 reserveWithinTx）→ job 行 → COMMIT）。
验证命令 / 退出码 / 关键断言：
  - 同 key 同指纹重放 → created=false 且返回同一 generationId，行数仍为 1。
  - 同 key 不同指纹（模型不同）→ IDEMPOTENCY_CONFLICT（409 语义）。
  - 并发同 key 四连发（Pool 独立连接）→ 恰好 1 个 generation、1 条 reserve 账目（唯一约束 + 冲突重选双保险）。
  - npm run test:integration：60 例全绿；lint/typecheck/build:workspaces/test:unit（175）/test:e2e（42）退出码 0。
证据路径：本条目；apps/api/src/modules/generation/create.ts、apps/api/test/generation-create.integration.test.ts。
风险或阻塞 / 下一项：pending 状态任务的真实 worker 领取属 J03；provider/model 来自 precheck.settings+能力注册表。J02 见下条。
```

```text
ID / 日期：J02 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty（同 J01 变更：create.ts 的单事务实现）。
验证命令 / 退出码 / 关键断言：
  - J02 验收（模拟回滚不留半条任务）：将 job 表改名使 INSERT job 失败 → create 抛错且 generation 表中该 idempotency_key 行数为 0——generation/quota/job 全部回滚，无半条任务。
  - 期间抓到并修复真实架构缺陷：QuotaService 在外层事务内执行 BEGIN/COMMIT 会把 J02 外层事务提前提交（job 失败后 generation 仍留存）——重构出 reserveWithinTx/releaseWithinTx 无事务原语供嵌套调用，reserve/release 包装方法保留事务管理语义；B05 原测试保持全绿。
  - npm run test:integration：60 例全绿；其余门禁同 J01 条。
证据路径：本条目；apps/api/src/modules/quota/service.ts（WithinTx 拆分）、apps/api/test/generation-create.integration.test.ts（rollback 用例）。
风险或阻塞 / 下一项：不引入外部消息系统（ADR 0001 D-3）；job 领取/租约属 J03。下一项：J03。
```

```text
ID / 日期：J03 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/worker/src/queue.ts（claimJobs——FOR UPDATE SKIP LOCKED 按 run_after 领取 pending、租约/心跳/attempts+1；heartbeat——CAS(lease_owner+leased) 续期；completeJob——事务内 FOR UPDATE 双重 CAS（job lease_owner + generation 状态），已终态任务仅标记 done 不重复执行（ALREADY_TERMINAL），租约丢失 LEASE_LOST 拒写；failJob——CAS 同上，retryable 未耗尽回 pending 带退避，耗尽或不可重试置 dead+reason 并将 generation 置 failed；reclaimExpiredLeases——过期租约按剩余额度回收或直接死信）、queue.integration.test.ts（6 例，真实 PG + 临时集群）。
验证命令 / 退出码 / 关键断言：
  - 双 Worker 并行领取 → 各得 1 job 且 generationId 集合不重叠（SKIP LOCKED）。
  - 租约过期（leaseSeconds=-1）→ reclaimExpiredLeases 回收 → 新 worker 领取；旧 worker 尝试完成 → LEASE_LOST 拒写（CAS 生效，验收核心）；新 worker 完成 → generation succeeded。
  - 已 succeeded generation 的重复完成 → completed+ALREADY_TERMINAL，不产生重复执行效果（验收核心）。
  - 心跳：非持有者 false；持有者续期后 lease_expires_at > now+60s。
  - 死信：attempts>=max_attempts 且 retryable → dead + dead_reason=PROVIDER_REJECTED + generation failed/error_code；未耗尽 retryable → 回 pending（attempts=1）。
  - npm run test:integration：12 文件 66 例全绿；lint/typecheck/build:workspaces/test:unit（175）/test:e2e（42）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
  - 过程记录：集成测试需按 kind 隔离（全量运行时 claim 会领到其他用例的 pending job——与生产语义一致，测试用唯一 kind 隔离）；进程崩溃场景由租约过期回收覆盖（崩溃=不再心跳=租约到期）。
证据路径：本条目；apps/worker/src/queue.ts、apps/worker/test/queue.integration.test.ts。
风险或阻塞 / 下一项：worker 引擎循环（claim→执行→complete）与 provider adapter 挂接属 J04/J05；J03 只交付队列机制。下一项：J04（allowlist Provider Adapter 与凭据注入）。
```

```text
ID / 日期：J04 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty；最初新增 API ProviderAdapter，后在 O05 提取为 packages/managed-runtime，并于 W06 真实兼容验证前将请求改为标准 multipart：baseUrl 仅来自服务端 allowlist 描述符（含注入的 apiKey）；模型 allowlist 预检——不支持模型零请求直接拒；POST /v1/images/edits 带 Authorization + redirect:'error'；3xx 一律 PROVIDER_REJECTED；408/504 → PROVIDER_TIMEOUT_UNKNOWN；结果仅接受 b64_json，URL 型结果必须同 allowlist origin，否则拒绝。
验证命令 / 退出码 / 关键断言：
  - 请求形状：路径 /v1/images/edits；multipart body 含 model/quality/prompt/n/size/response_format 与单个 image 文件；自构造 bytes 保持 prompt LF 与不可变 snapshot 哈希一致。
  - 状态码规范化：401/429/500 → PROVIDER_REJECTED+status；408/504 → PROVIDER_TIMEOUT_UNKNOWN；无 Authorization/密钥泄漏于失败消息（'sk-j04-secret-key' 不出现）。
  - 模型 allowlist：非白名单模型零请求直接 PROVIDER_REJECTED。
  - SSRF 防护：3xx 重定向（fetch 抛错与 302 状态两路径）→ PROVIDER_REJECTED；结果 URL 指向 169.254.169.254 → PROVIDER_REJECTED（拒绝内网触达）。
  - npm run test:unit：27 文件 186 例全绿；lint/typecheck/build:workspaces/test:integration（66）/test:e2e（42）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
证据路径：本条目；apps/api/src/modules/generation/provider-adapter.ts、apps/api/test/provider-adapter.test.ts。
风险或阻塞 / 下一项：密钥注入点当前为构造参数（生产由 secret manager/受管密钥文件填充，禁止任意 baseUrl 转发已由 allowlist 结构保证）；W06 已在后续取得单次授权并完成真实 Provider 验证。下一项：J05（真实发送内容追溯）。
```

```text
ID / 日期：J05 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/api/migrations/0004_prompt_snapshot.sql（template_version.prompt_text 快照列——B02 导入器写入精确正文，expand/contract 兼容）、execute.ts（executeClaimedJob：快照哈希守卫——prompt_text 实际哈希 != compiled_prompt_sha256 即 PROMPT_REWRITE_BLOCKED 拒发零 provider 调用；attempt 先行落库 state=sent + sent_prompt_sha256=实际发送哈希；effective 默认等于 compiled（§7）；成功后结果入私有存储 + result 行 + completeJob 迁移 generation succeeded）、apps/worker/test/execute.integration.test.ts（2 例，mock provider 捕获真实请求字节）。
验证命令 / 退出码 / 关键断言：
  - 追溯闭环（验收核心）：mock provider 捕获的请求 body.prompt 逐字节等于 template_version.prompt_text 快照；attempt.sent_prompt_sha256 == sha256(发送正文去尾换行)；attempt state sent→succeeded；generation succeeded + result 落库 actual_bytes>0。
  - 替换拒绝（验收核心）：DB 内篡改 prompt_text → PROMPT_REWRITE_BLOCKED 拒发，provider 请求数不变（零外发）；输入与参数替换在 M04 validateForGeneration 已被绑死（generation 行创建时冻结）。
  - npm run test:integration：13 文件 68 例全绿；lint/typecheck/build:workspaces/test:unit（186）/test:e2e（42）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
  - 迁移 0004 使 B01 版本断言更新为 [1,2,3,4]（expand 路径）。
证据路径：本条目；apps/worker/src/execute.ts、apps/worker/test/execute.integration.test.ts、apps/api/migrations/0004_prompt_snapshot.sql。
风险或阻塞 / 下一项：结果实测宽高当前写入 1×1 占位（mock 图像），M03 存储适配器返回 bytes 可再核；provider request_id 回填属 J06 对账。下一项：J06（超时/网络中断的 outcome_unknown 与对账）。
```

```text
ID / 日期：J06 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。接手时 J06 代码草稿（execute.ts catch 分支 + reconcile.ts + 测试文件）已存在但从未跑通（测试缺 node:path/node:os 导入、类型引用失效，且真实路径有缺口）。本轮变更：apps/api/src/modules/generation/provider-adapter.ts（408/504 响应捕获 x-request-id → NormalizedFailure.requestId，断连无响应时缺省）、packages/test-support/src/mock-provider.ts（每响应携带 x-request-id: mock-req-N；scriptResponses 支持自定义 headers）、apps/worker/src/execute.ts（关键修复：adapter 把断网/超时归一化为 {ok:false} 而非抛错，原 catch 分支对真实 adapter 是死代码——现 !outcome.ok 且 code=PROVIDER_TIMEOUT_UNKNOWN 分支自身完成 attempt state=unknown+requestId 落库、generation CAS→outcome_unknown、job 死信 CAS，catch 分支同样走 markGenerationOutcomeUnknown/deadLetterJob 共享助手）、apps/worker/src/reconcile.ts（修复 probeByRequestId 列别名 bug：SELECT provider_request_id 却读 row.request_id，恒返回 null）、apps/worker/test/reconcile.integration.test.ts（重写：补缺失导入、去 happy-dom 环境——其 CORS 预检会吞掉脚本化 504、修正 Queryable/ExecutionDeps 类型引用）、packages/test-support/src/pg-test-cluster.ts（initdb 固定 --lc-messages=C，修复 zh_CN locale 下迁移测试匹配英文错误文本的确定性失败——非 J06 引入，本轮暴露并修复）。
验证命令 / 退出码 / 关键断言：
  - 已接受后断网不重发（验收核心）：acceptThenDropFetch 先把请求真实送达 mock provider（provider.requests +1 = 已接受）再抛断连错误 → execute 返回 PROVIDER_TIMEOUT_UNKNOWN、generation=outcome_unknown、attempt=unknown 且 provider_request_id=NULL、job state=dead/dead_reason=PROVIDER_TIMEOUT_UNKNOWN；另一 worker claimJobs 为空（无重发通道）；重复 mark/deadLetter 为 CAS 幂等 no-op（返回 false）。
  - 缺 request ID 保持未知（验收核心）：纯断连路径 resolveUnknown(succeeded) 被拒 MISSING_REQUEST_ID，probeByRequestId 返回 null；operator 显式处置 failed 成功退出未知态。
  - request ID 对账（验收核心）：mock 504 + x-request-id 头 → adapter 捕获 → attempt.provider_request_id=mock-req-N 落库 → probeByRequestId 返回同值 → resolveUnknown(succeeded) 成功；配额不释放（quota_ledger 无 release 行，provider 已计费）。
  - npm run test:integration：14 文件 71 例全绿（J06 3 + 既有 68）；lint/typecheck/build:workspaces/test:unit（27 文件 181 例）/test:e2e（42）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
  - 计数说明：单测总数 181，J04/J05 记录为 186——同一 27 文件、0 失败 0 跳过，差异源自 J05 会话中段重构（本轮未触碰任何单测文件）；全绿无回归，留此备注供后续核对。
证据路径：本条目；apps/worker/src/execute.ts、apps/worker/src/reconcile.ts、apps/worker/test/reconcile.integration.test.ts、apps/api/src/modules/generation/provider-adapter.ts、packages/test-support/src/{mock-provider,pg-test-cluster}.ts diff。
风险或阻塞 / 下一项：处置入口当前为服务层函数（resolveUnknown/probeByRequestId），面向运维的 CLI/管理端 API 尚未暴露（架构 §9 未强制首期 HTTP 化）；Worker 主循环 index.ts 仍是 shell，领取→执行→死信的常驻接线属后续联调范围。下一项：J07（有界可重试错误与失败归档）。
```

```text
ID / 日期：J07 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/worker/src/retry-policy.ts（classifyProviderFailure：401/403 与 400/404/409/422 永不重试；429/503 仅在持有 Retry-After 证据或幂等安全时重试；其他 5xx 仅 Retry-After 证据可重试；PROVIDER_TIMEOUT_UNKNOWN 恒归 J06 路径不参与重试）、apps/worker/src/retry-policy.test.ts（单测 15 例）、apps/worker/test/retry.integration.test.ts（5 例）。修改 apps/api/src/modules/generation/provider-adapter.ts（429/5xx 捕获并解析 retry-after 头 → NormalizedFailure.retryAfterSeconds，仅接受 delta-seconds 形式；新增显式 429/5xx 分支）、apps/worker/src/execute.ts（非超时失败：attempt 记录 http_status 归档 → 分类 → failJob（retryable 回 pending + run_after 延迟；不可重试或 attempts 耗尽 → 死信 + generation failed）；拒判路径（GENERATION_STATE_ILLEGAL/INTERNAL/PROMPT_REWRITE_BLOCKED）经 refuseExecution 立即死信归档，不再依赖租约过期空转；ExecutionOutcome 增加 retried 标志）。
验证命令 / 退出码 / 关键断言：
  - 429+Retry-After 有界重试（验收核心）：首次执行 retried=true、attempt http_status=429 归档、job 回 pending 且 run_after 延迟、generation 保持 queued 不谎报失败；延迟后重新领取（attempts=2）执行成功 → completeJob → succeeded；provider 恰收 2 次请求。
  - 429 无 Retry-After（验收核心）：非幂等路径无证据不重试——job 死信 PROVIDER_REJECTED、generation failed、恰 1 次 provider 调用、无可领取 job。
  - 401 永不重试（验收核心）：job 死信、generation failed、attempt http_status=401、恰 1 次调用（分类器单测覆盖 401/403/400/404/409/422 即便幂等安全也不重试）。
  - 超限死信（验收核心）：连续 503+Retry-After 三轮（max_attempts=3），第 3 轮 retried=false → 死信 + generation failed；attempt 归档 3 行 http_status=503,503,503；无残留可领取 job。
  - 失败归档（拒判）：篡改快照 → PROMPT_REWRITE_BLOCKED 立即死信 + generation failed，零 provider 调用，不再租约空转。
  - npm run test:unit：28 文件 196 例全绿（分类器 +15）；npm run test:integration：15 文件 76 例全绿（J07 5 + 既有 71）；lint/typecheck/build:workspaces/test:e2e（42）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
证据路径：本条目；apps/worker/src/retry-policy.ts、apps/worker/src/execute.ts、apps/worker/test/retry.integration.test.ts、apps/api/src/modules/generation/provider-adapter.ts diff。
风险或阻塞 / 下一项：重试仅覆盖 provider 层失败分类；Worker 主循环常驻接线仍未做（同 J06 记录）；Retry-After 的 HTTP-date 形式不支持（解析即缺省，按无证据处理——保守方向正确）。下一项：J08（取消与竞争处理）。
```

```text
ID / 日期：J08 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/api/migrations/0005_cancel.sql（generation.cancel_requested_at——运行中取消请求的事实记录，迁移断言更新为 [1..5]）、apps/api/src/modules/generation/cancel.ts（CancelService：FOR UPDATE 事务内对象级鉴权；created/queued → 真取消（job 死信 cancelled + 同事务配额释放，ledger 唯一键保证幂等）；running → 仅记录 cancel_requested_at 并如实返回 CANCEL_NOT_GUARANTEED（allowlist provider 无取消 API，也绝不调用上游取消）；outcome_unknown → GENERATION_STATE_ILLEGAL 拒绝（退出只能走 J06 对账/处置）；终态如实返回 already_terminal）、apps/worker/test/cancel.integration.test.ts（4 例）。修改 apps/worker/src/execute.ts（generation 真正进入 running：CAS queued/running→running；发送前检查 cancel_requested_at——命中则未发送即取消：不建 attempt（不谎报已发送）、generation→cancelled、配额释放、job 死信 cancelled；mark-running CAS 0 行 = 排队取消竞态胜出，零发送埋 job）。附带修复两个既有潜伏缺陷：apps/api/src/modules/generation/create.ts（J01/J02 并发幂等：23505 后 PG 事务已中止，原代码在中止事务里 SELECT 必抛 'current transaction is aborted'——负载下竞态测试确定性失败；现先 ROLLBACK 再读，5×5 压力复跑全绿）、apps/worker/test/retry.integration.test.ts（J07 测试确定性化：消除 sleep 竞速 run_after 的 100ms 边际——改为断言延迟后 UPDATE 快进；queued→running 断言对齐 J08 诚实状态）。
验证命令 / 退出码 / 关键断言：
  - 排队取消（验收核心）：state=cancelled、job dead/cancelled 不可再领取、provider 零调用、quota_ledger 恰 1 行 release（未发送=未计费=释放）；重复取消幂等（already_terminal，无二次释放）。
  - 运行取消请求（验收核心）：返回 cancel_requested + CANCEL_NOT_GUARANTEED，state 仍 running、flag 落库、无释放；worker 到达发送前检查点 → 未发送即取消（0 attempt 行、0 provider 调用、配额释放、job 死信 cancelled）。
  - 成功回包竞态（验收核心）：阻塞 fetch 下 provider 已接受请求后发起取消 → 响应放行成功 → 终态 succeeded、result 落库、配额不释放（已计费）、cancel_requested_at 作为事实保留、全程仅 /v1/images/edits 调用（无上游取消 API 被发明或调用）。
  - 诚实拒绝：succeeded → already_terminal；outcome_unknown → GENERATION_STATE_ILLEGAL；他人任务 → FORBIDDEN 且原状态不变；不存在 → NOT_FOUND。
  - npm run test:integration：16 文件 80 例全绿（J08 4 + 既有 76）；test:unit 28 文件 196 例全绿；generation-create 并发文件单跑 5×5 全绿（23505 修复后压力验证）；lint/typecheck/build:workspaces/test:e2e（42）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
证据路径：本条目；apps/api/src/modules/generation/cancel.ts、apps/api/migrations/0005_cancel.sql、apps/worker/src/execute.ts、apps/worker/test/cancel.integration.test.ts、apps/api/src/modules/generation/create.ts diff。
风险或阻塞 / 下一项：取消尚只有服务层入口（POST /generations/{id}/cancel 的 OpenAPI/HTTP 路由属 W01 联调）；发送中到达的取消请求不回滚已接受的 provider 调用（如实返回不保证免计费）。下一项：J09（结果获取、验证、存储与原子完成）。
```

```text
ID / 日期：J09 / 2026-09-06
状态：通过
工作区版本 / 变更文件：main @ 4a7bd6a + dirty。新增 apps/worker/test/result.integration.test.ts（5 例）。修改 apps/worker/src/execute.ts（ExecutionDeps 新增必填 validateImage 结构端口——复用 M02 validateImage 的魔数/真实解码/字节/像素上限语义，端口必填使生产接线无法绕过验证；provider 成功回包后先验证再存储：假 MIME/不可解码/超限 → attempt 记 error_code、failJob 不重试死信（重试垃圾=重复计费）；storage.put 失败 → attempt 保持 succeeded（provider 确实已交付，事实保留）+ error_code=RESULT_STORAGE_FAILED、job 死信不重试——付费模型绝不因本地存储故障被重复调用；media_object 与 result 行写入解码得到的真实 mime/bytes/width/height，替换 J05 遗留的 1×1 占位，对象键扩展名随真实 MIME）、apps/worker/test/{execute,reconcile,retry,cancel}.integration.test.ts（四处 deps 注入真实 validateImage）、apps/worker/package.json（devDependencies 补 sharp——测试直接生成受控图像）。
验证命令 / 退出码 / 关键断言：
  - 假 MIME（验收核心）：provider 返回非图像字节 → UNSUPPORTED_MEDIA_TYPE，generation failed、job 死信、0 result 行、恰 1 次付费调用、无残留可领取 job。
  - 缺图（验收核心）：200 但无 b64_json → PROVIDER_REJECTED 死信失败。
  - 超限（验收核心）：真实 8000×6000（48MP > 40MP）PNG → PIXEL_LIMIT_EXCEEDED 死信失败。
  - 存储失败（验收核心）：put 抛错 → RESULT_STORAGE_FAILED，attempt 仍 succeeded（事实）+ error_code 归档，恰 1 次付费调用，不重试。
  - actual 分离（验收核心）：输入 1×1、结果 3×2 → result/media_object 的 actual_mime/bytes/width/height 全部来自解码值，sha256 与存储字节一致。
  - npm run test:integration：17 文件 85 例全绿（J09 5 + 既有 80）；test:unit 28 文件 196 例全绿；lint/typecheck/build:workspaces/test:e2e（42）退出码 0；ci-verify.sh（venv+nvm PATH）退出码 0。
证据路径：本条目；apps/worker/src/execute.ts、apps/worker/test/result.integration.test.ts diff。
风险或阻塞 / 下一项：结果验证复用输入侧上限（20MiB/40MP），如未来放行更大生成结果需单独决策；存储失败后的付费结果恢复属运维流程（attempt 已留 succeeded+error_code 证据）。下一项：J10（查询/下载与 sidecar）。
```

```text
ID / 日期：J10 / 2026-09-06
状态：完成并勾选。
变更（未 commit，dirty 工作区）：
- 新增 apps/api/src/modules/generation/query.ts：GenerationQueryService。getGeneration({generationId, subjectId}) 做对象级鉴权（不存在 → NOT_FOUND、跨用户 → FORBIDDEN），返回 state/errorCode/providerId/model/cancelRequested/时间戳、templateKey+version、compiled+effective prompt sha256、输入 sha256、attempt 摘要数组（含 sentPromptSha256）与 result 实际值；result 媒体未过期时用 signMediaPath（M03）签 300s 下载 URL，过期/删除则 downloadUrl=null 且历史成功事实全保留。getSidecar 返回 onepic-generation-sidecar schemaVersion 1.0.0，只含哈希与元数据，无提示词正文、无密钥。
- 新增 apps/worker/test/generation-query.integration.test.ts（4 例）。放在 worker/test 是因为 fixture 复用 execute 跑真实成功路径（领 job→execute→completeJob）；查询服务本体在 api 模块。
验证（node 经 nvm PATH；PG 用本机 postgresql@16 临时集群）：
- npx vitest run --config vitest.integration.config.ts apps/worker/test/generation-query.integration.test.ts：4 例全绿。
  - 属主全链路对应（验收核心）：compiled==effective==attempt.sent 哈希，输入 sha256 与 media_object 一致，result actual 3×2/sha256 与 provider 解码字节一致；签名 URL 用 verifySignedMedia 验签通过且 owner 参数绑定属主。
  - 越权/不存在（验收核心）：跨用户 getGeneration/getSidecar → FORBIDDEN，不存在 → NOT_FOUND。
  - 过期不改写历史（验收核心）：媒体过期+generation→expired 后，历史成功事实（state/attempt/result 哈希）全保留，downloadUrl=null。
  - sidecar 无密钥（验收核心）：序列化不含 PROVIDER_KEY('sk-j10-secret')、SIGNING_KEY、'sk-' 前缀与提示词正文。
- npm run test:integration：18 文件 89 例全绿（J10 4 + 既有 85）；test:unit 28 文件 196 例全绿；lint/typecheck/build:workspaces 退出码 0（初跑 worker typecheck 报 Queryable 结构类型不兼容，改为直接传 pg Client 修复）；test:e2e 42 例全绿（初跑 webapp-studio hash badge 1 例因提示词加载竞态偶发失败，单独重跑及全量重跑均绿）；ci-verify.sh 退出码 0。
证据路径：本条目；apps/api/src/modules/generation/query.ts、apps/worker/test/generation-query.integration.test.ts diff。
风险或阻塞 / 下一项：查询/sidecar 目前只有服务层，HTTP 路由与 OpenAPI 契约属 W01/W03 联调范围；下载签名 TTL 300s 为测试配置。J 阶段全部完成（J01–J10）。下一项：W01（工作台上传→预审→提交→轮询→下载全链路联调，依赖 J 全部已满足）。
```

```text
ID / 日期：W01 / 2026-09-06
状态：完成并勾选（子代理实现，主代理逐项复核并修复 2 处校验缺口后核验全绿）。
变更（未 commit，dirty 工作区）：
- 契约：packages/contracts/openapi/api-v1.yaml 新增 POST /uploads(201)、PUT /uploads/{id}/bytes、POST /uploads/{id}/confirm、POST /prechecks(201)、POST /generations(202，Idempotency-Key 必需头)、GET /generations/{id}；字段严格按 docs/design/backend-schemas 四份 schema；downloadUrl/downloadExpires/pollAfterMs 放 meta。npm run gen:api 重生成 generated/api-v1.d.ts 与 api-v1.json（gen:api:check 无漂移，未手改）。packages/client 扩展 createUpload/uploadBytes/confirmUpload/createPrecheck/createGeneration/getGeneration，变更类请求带 CSRF 头。
- API：新增 apps/api/src/bootstrap/workbench-routes.ts——控制器只做协议转换+对象级鉴权（401/403/404 在服务层强制），body/response 经 openApiSchema 校验（未知字段 400）；POST /generations 服务端重读不可变模板版本比对 promptSha256（PROMPT_REWRITE_BLOCKED），复核预审绑定后调 GenerationService.create。app.ts 挂载；errors.ts 补 413→PAYLOAD_TOO_LARGE；env.ts 新增 MANAGED_PROVIDER_ID/GENERATION_QUOTA_LIMIT；query.ts 的 ResultSummary 补 objectId（契约必填）。无新迁移（0001–0005 够用）。
- Web：新增 apps/web/src/features/studio/useManagedGeneration.ts 状态机（idle→uploading→prechecking→submitting→polling→succeeded/failed），busy 守卫防重入+每次尝试单幂等键；提交后写 localStorage onepic.managed.inflight.v1，挂载时 restore() 查询恢复轮询，终态/401/403/404 清除；不读 BYOK key（grep 核验仅注释提及），managed 请求仅会话 cookie。StudioPage.vue 接线生成按钮/状态区/结果展示（签名 URL 图+actual 尺寸/哈希），SettingsDialog 解禁 managed 并注明需登录、不用 BYOK。
验证（node 经 nvm PATH；真实 fastify inject+PG 临时集群+LocalDiskStorage+mock provider）：
- apps/worker/test/workbench-flow.integration.test.ts 5 例全绿（主代理亲跑复核）：全链路（上传→预审→提交→claim/execute/complete→轮询 succeeded→verifySignedMedia 验签+媒体路由真实字节比对）；恢复语义 queued→running→succeeded；越权 B 查 A 403/借用签名链接 404/不存在 404/匿名 401；同幂等键重放同一 generation 且 DB 一行、异指纹 409；未知字段 400、promptSha256 伪造 400、provider 收到提示词哈希==编译哈希。
- apps/web/src/features/studio/useManagedGeneration.test.ts 7 例（状态机顺序、inflight 写入/恢复/终态清除、401/403/404 清除、重复点击仅一次 POST、managed 请求无 BYOK key）；StudioPage.test.ts 新增 2 例 UI 级（按钮接线到结果展示、刷新恢复轮询）。
- 回归（主代理复核）：test:unit 29 文件 206、test:integration 19 文件 94、test:e2e 42 全绿；typecheck/build:workspaces/gen:api:check 退出码 0。lint 子代理汇报有误（管道遮蔽退出码）：client 测试 2 处未用参数 error，主代理修复（vi.fn<typeof fetch> 保留调用断言类型）后 lint/tsc/vitest 复验通过；ci-verify.sh 最终退出码 0。
证据路径：本条目；上述文件 diff；/tmp/w01-ci-verify2.log。
风险或阻塞 / 下一项：managed 模型/质量固定 gpt-image-2/high（能力注册表种子），受管能力注册表落地后替换；API baseUrl 默认同源，跨源部署需后续配置；error-response.schema.json 的 correlationId 顶层声明与既有信封（error.correlationId）冲突，按 OpenAPI 文档为唯一事实来源保持现状。下一项：W02（失败/未知/取消/过期状态联调）。
```

```text
ID / 日期：W02 / 2026-09-07
状态：完成并勾选（子代理实现，主代理逐项复核全绿后勾选）。
变更（未 commit，dirty 工作区）：
- 契约：packages/contracts/openapi/api-v1.yaml 新增 POST /generations/{generationId}/cancel + GenerationCancelResult schema（state 8 枚举、outcome: cancelled|cancel_requested|already_terminal、code?: CANCEL_NOT_GUARANTEED）；gen:api 重生成（check 无漂移）；packages/client 加 cancelGeneration（CSRF 头）。
- API：workbench-routes.ts 挂取消路由接既有 CancelService（J02）：queued→cancelled+释放配额+job 置 dead；running→cancel_requested+CANCEL_NOT_GUARANTEED；终态→already_terminal；outcome_unknown→409 GENERATION_STATE_ILLEGAL；401/403/404 映射与既有路由一致。无新迁移。
- Web：useManagedGeneration.ts 重写——phase 扩为 idle/uploading/prechecking/submitting/polling/succeeded/failed/cancelled/unknown/expired；inflight 记录 v2（schemaVersion:2，含幂等键与请求体，兼容读 v1），refresh 后无 generationId 时用同一幂等键重放（服务端幂等回放，非隐式重试）；applyStatus 带 STATE_RANK 守卫（乱序低 rank 不覆盖）；429/5xx/断网 TypeError 退避 2000*min(failures,5)、failures>=2 显示 notice、永不误判任务失败；401/403/404 清记录（401 文案含登录引导）；outcome_unknown 进 phase unknown 并保留 inflight，仅 dismissUnknown() 显式清除；expired 提示并清记录；cancel() 按 outcome 收敛（cancel_requested 提示不保证免计费继续轮询）。StudioPage.vue 接线 unknown 块（role=alert+显式清除按钮）、notice 行、取消按钮；watch runMode 切离 managed 时清 inflight。
验证（node 经 nvm PATH；真实 fastify inject+PG 临时集群+LocalDiskStorage+mock provider）：
- 新增 apps/worker/test/workbench-cancel.integration.test.ts 4 例（主代理亲跑复核全绿）：queued 取消全链路（job 不可 claim、provider 零调用、重复取消幂等、配额仅释放一次）；running 取消（cancel_requested，completeJob 后仍 succeeded，J08 语义）；越权 403/不存在 404/匿名 401（匿名需带 CSRF 头）；504→outcome_unknown 后取消 409；过期媒体（expired 保留哈希、downloadUrl null、过期签名 URL 410、终态取消幂等）。
- Web 单测：useManagedGeneration.test.ts 18 例（+11：429 退避不重发 POST、5xx/断网退避提示、401 清 inflight、乱序 rank 守卫不覆盖、取消流三 outcome、outcome_unknown 无第二个 POST /generations、模式切换清记录）；StudioPage.test.ts 15 例（+2：轮询中取消全流程、切换运行模式清 inflight）。
- 回归（主代理复核，命令分开跑无管道遮蔽）：test:unit 29 文件 220、test:integration 20 文件 98、test:e2e 42 全绿；lint/typecheck/build:workspaces/gen:api:check 退出码 0；ci-verify.sh 退出码 0。
证据路径：本条目；apps/web/src/features/studio/useManagedGeneration.ts、apps/worker/test/workbench-cancel.integration.test.ts、packages/contracts/openapi/api-v1.yaml diff；/tmp/w02-ci-verify.log。
风险或阻塞 / 下一项：验收点覆盖说明——断网/429/5xx/超时走退避路径，登出清缓存因 web 无 logout UI 以「401 清记录+模式切换清记录」覆盖；outcome_unknown 保留 inflight 供刷新落回、仅显式 dismiss（非隐式重试）。残余：managed 模型仍固定 gpt-image-2/high 种子；多标签页同时轮询无跨标签协调（rank 守卫只保单实例）。下一项：W03（服务端收藏/集合/历史分页）。
```

```text
ID / 日期：W03 / 2026-09-07
状态：完成并勾选（子代理实现，主代理逐项复核全绿后勾选）。
变更（未 commit，dirty 工作区）：
- 新建 apps/api/src/modules/workspace/：cursor.ts（签名 cursor 编解码）、history.ts（HistoryService 生成历史分页）、collections.ts（CollectionService 集合 CRUD+收藏）；新建 apps/api/src/bootstrap/workspace-routes.ts（6 端点控制器）并在 app.ts 注册（同一 identity+PG 边界）。
- 契约：OpenAPI 新增 GET /generations（本人历史 cursor 分页，state 过滤，limit≤50 默认 20）、GET/POST /collections、DELETE /collections/{id}、POST/DELETE /collections/{id}/items；14 个新 schema；gen:api 重生成无漂移；client 加 listGenerations/listCollections/createCollection/deleteCollection/addCollectionItem/removeCollectionItem。
- 数据字典 §5 登记新稳定错误码 COLLECTION_NAME_CONFLICT（重名 409）。无新迁移（0003 的 collection/collection_item 已够用，PK (collection_id,item_type,item_key) 即幂等保证）。
- cursor 方案：keyset 分页（created_at+id 行比较，无 OFFSET；历史 DESC、集合 ASC）；base64url({v,c,id}) + '.' + HMAC-SHA256 签名（与签名媒体同密钥族）；结构/字符集/版本号/uuid/时间戳范围/timingSafeEqual 验签，任一失败 400，绝不退化为回第一页。
验证（node 经 nvm PATH；真实 fastify inject+PG 临时集群，无 mock 被测对象）：
- 新增 apps/worker/test/workspace.integration.test.ts 7 例（主代理亲跑复核全绿）：①跨用户隔离（B 历史/集合为空、IDOR 删/加/移 403、读 B 任务 403、不存在 404、匿名 401）②分页稳定（5 行+中途并发插入 1 行，3 页不重不漏、新插入不进后续页、强制同 created_at 验证 id tiebreaker、state 过滤）③篡改/伪造/错密钥/越界 cursor 均 400、未知 query 字段 400、limit=51 400 ④重名 409+他人可同名+空白名/未知字段 400+itemCount ⑤重复收藏响应逐字节一致、DB 恰一行、移除幂等 removed:true→false ⑥收藏他人 generation 403、不存在 generation/模板 404、畸形 itemKey 400 ⑦删集合后 generation/media/job 行俱在、GET 任务 200、历史仍可见、重复删除 404（集合删除不误删任务，验收核心）。
- client 单测 +2 例（query 构造/nextCursor 透传、集合四变更 URL/方法/CSRF 头）。
- 回归（主代理复核，命令分开跑）：test:unit 29 文件 222、test:integration 21 文件 105、test:e2e 42 全绿；lint/typecheck/build:workspaces/gen:api:check 退出码 0；ci-verify.sh 退出码 0。
证据路径：本条目；apps/api/src/modules/workspace/、apps/api/src/bootstrap/workspace-routes.ts、apps/worker/test/workspace.integration.test.ts、packages/contracts/openapi/api-v1.yaml diff；/tmp/w03-ci-verify.log。
风险或阻塞 / 下一项：设计处置——权限矩阵写「他人资源 404」但 W01/W02 已用 403，沿用实现语义不改文档；历史列表复用 GenerationStatus 形状（result 省略）避免逐行 join；GET /collections/{id}/items 未实现（字典与任务书未列，集合内容读取留给 W04 导出或后续）。残余：itemCount 相关子查询有 N+1 成本（limit≤50 封顶可控）；收藏 template 不绑定具体目录版本（有意）；Web UI 未接线（验收为服务端语义，不阻塞）。下一项：W04（显式本地收藏导入与私人记录导出）。
```

```text
ID / 日期：W04 / 2026-09-07
状态：完成并勾选（子代理实现，主代理逐项复核全绿后勾选）。
变更（未 commit，dirty 工作区）：
- 新建 apps/api/src/modules/workspace/export.ts（WorkspaceExportService：favorites=本人集合内 template 收藏去重、collections 含空集合 LEFT JOIN、history 用 W03 keyset 分页内部循环翻完全部页）；新建 apps/web/src/features/workspace/import-to-server.ts（导入编排）+ 各自测试。
- 契约：OpenAPI 新增 GET /exports/workspace，响应与 docs/design/backend-schemas/workspace-export.schema.json 逐字段同形（schemaVersion/exportedAt/favorites/collections/history，additionalProperties:false）；gen:api 重生成无漂移；client 加 exportWorkspace()。
- 路由挂 workspace-routes.ts（401 鉴权一致，响应经 openApiSchema('ApiSuccessOfWorkspaceExport') 校验，未声明字段无法泄漏）。
- Web：WorkspacePage.vue 加「导入到服务器」显式按钮（非 managed 禁用+提示）+ 明细报告块；shared/platform/local-store.ts 导出 validateLocalRecord() 复用既有 sanitize。导入映射：本地 favorites→固定名集合「导入的收藏」，本地集合按名映射（409 重名=复用非失败）；新增/跳过计数用服务端 itemCount 差值推导（不改 W03 重放契约）。
验证（node 经 nvm PATH；真实 fastify inject+PG 临时集群）：
- 新增 apps/worker/test/workspace-export.integration.test.ts 2 例（主代理亲跑复核全绿）：A 52 行历史（强制跨两页）+2 集合+模板/任务收藏，导出过已发布 JSON schema 的 Ajv2020 校验、history 恰 52 行、favorites 跨集合去重、B 零混入（无跨用户记录混入，验收核心）；序列化全文无 'sk-'/signing key/session token/提示词正文（无密钥，验收核心）；C 空结构；匿名 401。
- 新增 apps/web/src/features/workspace/import-to-server.test.ts 6 例：重复导入第二次 0 新增 4 跳过（验收核心）；坏记录零请求+明确反馈（验收核心）；部分失败（case-3 404）继续其余+{label,reason} 明细（验收核心）；请求体白名单断言（毒化记录的 byokKey/endpoint/settings 永不进请求，验收核心）；401 无部分写入；空记录无操作。
- WorkspacePage.test.ts +2：非 managed 按钮禁用无请求；managed 点击恰好 6 请求、报告渲染、BYOK key 不进任何请求。
- 回归（主代理复核，命令分开跑）：test:unit 30 文件 230、test:integration 22 文件 107、test:e2e 42 全绿；lint/typecheck/build:workspaces/gen:api:check 退出码 0；ci-verify.sh 退出码 0。
证据路径：本条目；apps/api/src/modules/workspace/export.ts、apps/web/src/features/workspace/import-to-server.ts、apps/worker/test/workspace-export.integration.test.ts diff；/tmp/w04-ci-verify.log。
风险或阻塞 / 下一项：新增/跳过计数依赖 itemCount 差值，并发同账号写入会高估（单用户显式导入场景可接受，已注释）；复核 GET 失败按全部新增计并附 RECOUNT_UNAVAILABLE 明细（数据已安全落库）；导出 history 为全状态摘要（无哈希无链接，与 schema 一致）。下一项：W05（静态独立与 direct BYOK 保留验证）。
```

```text
ID / 日期：W05 / 2026-09-07
状态：完成并勾选（验证为主，子代理补最小实现，主代理逐项复核全绿后勾选）。
验收点 → 证据：
- 关闭 API 后目录/复制可用：新 e2e e2e/webapp-offline.spec.ts 第 1 例——page.route('**/api/**', abort) 下五页逐一渲染通过、studio 提示词加载+复制有反馈、catalog-only 生成按钮诚实禁用。依据：apps/web/src/entities/catalog/api.ts:78 目录走静态 data/catalog.json，本不依赖 API（先查数据源再验证，非假设）。
- 模式切换提示去向：SettingsDialog.vue 新增 onModeChange + MODE_SWITCH_NOTICES 三模式去向 toast；e2e 第 2 例断言 toast 与 localStorage 持久化；StudioPage 单测三向切换断言。
- 不自动切换 provider：e2e 第 2 例（managed+断网生成失败后 runMode 仍 managed-generation）；useByokGeneration 单测 429/TypeError 两例断言 settings.runMode 不变。
- 不传送凭据：managed 不带 BYOK key 由 W01 用例（useManagedGeneration.test.ts:271）回归覆盖；BYOK 请求裸 fetch 无 credentials（跨域必不带 cookie），URL 恰为 {byokEndpoint}/v1/images/edits 且不含 /api/（单测断言）。
补缺变更（验证发现 direct-BYOK 在新 Vue 应用是占位）：
- 新建 apps/web/src/features/studio/useByokGeneration.ts（对齐旧静态站 public/assets/app.js:562 语义：POST FormData 到 {base}/v1/images/edits，Bearer key 点击时从专用槽读取，失败原地报错永不改设置）+ 5 例单测；新建 e2e/webapp-offline.spec.ts（2 例）。
- 修改 settings/store.ts（readByokApiKey() 唯一读取口）、StudioPage.vue（canGenerate/onGenerate/byok 区）、SettingsDialog.vue（去向 toast）、StudioPage.test.ts（+3 例）。
验证（主代理复核，命令分开跑）：
- npx vitest run --config vitest.config.ts apps/web/src/features/studio：4 文件 48 例全绿；npx playwright test webapp-offline：2/2。
- 回归：test:unit 31 文件 238、test:integration 22 文件 107、test:e2e 44（42+2，含已知竞态用例本轮一次通过）全绿；lint/typecheck/build:workspaces/gen:api:check（本项无契约变更确认无漂移）退出码 0；ci-verify.sh 退出码 0。
证据路径：本条目；apps/web/src/features/studio/useByokGeneration.ts、e2e/webapp-offline.spec.ts diff；/tmp/w05-ci-verify.log。
风险或阻塞 / 下一项：BYOK 结果图直接渲染无服务端复核（直连模式固有语义）；BYOK 生成记录区仍是诚实空态（后续项）；断网用 route abort 模拟，half-open/TLS 失败由 TypeError 分支单测覆盖。下一项：W06 未获付费授权保持阻塞，跳过；推进 O01（保留与删除流程）。
```

```text
ID / 日期：W06 / 2026-09-08
状态：完成并勾选（用户明确授权最多 1 次付费请求；真实 Provider 全链路 PASS）。
工作区版本 / 变更文件：main @ 41254dd + dirty；修复 packages/managed-runtime ProviderAdapter 为 OpenAI-compatible multipart edits，保持不可变 prompt LF/哈希；新增 scripts/verify-real-provider.mjs 与 docs/design/evidence/w06/。
验证命令 / 退出码 / 关键断言：
- GET /v1/models：HTTP 200，26 models，确认 gpt-image-2 可用；该能力探测不生成图片。
- 调用前 unit：managed-runtime + API Provider adapter 11/11；PostgreSQL integration：execute/workbench 8/8；loopback mock 全链路预演严格 1 request PASS。mock 仅验证 harness，不作为 W06 证据。
- 未设置 ONEPIC_W06_PAID_AUTHORIZED=YES_ONE_REQUEST 时脚本在建库/网络前拒绝；真实运行由 counted fetch 在第 2 次请求前强制失败。
- ONEPIC_W06_PAID_AUTHORIZED=YES_ONE_REQUEST ONEPIC_PG_BIN=/opt/homebrew/opt/postgresql@16/bin node scripts/verify-real-provider.mjs：退出码 0，真实 Provider 请求恰好 1，event=w06_real_provider_passed。
- 单图输入 PNG 512×320/5030 bytes；真实输出 PNG 1600×983/881388 bytes，Sharp 解码通过。generation metadata、下载 bytes、input/prompt/result SHA-256 与 sidecar 全部匹配。
- 凭据只存 Git-ignored .tmp/w06-provider.env；报告和 /tmp 日志逐字节确认不含 key。未 deploy/生产 migration/commit/push。
证据路径：docs/design/evidence/w06/real-provider-report.{md,json}；scripts/verify-real-provider.mjs；/tmp/onepic-w06-real-provider.log。
风险或阻塞 / 下一项：真实输出横向方向保持，但宽高比相对输入偏差 1.7294%，已如实记录；只证明 motion-cover/gpt-image-2/high/单 PNG/单模板，不外推并发、全格式、S3 或生产网络。用户只授权 1 次，未发起第二次请求。下一项：因 ProviderAdapter 生产改动，重跑完整 CI/local stack/制品后完成 Z04。
```

```text
ID / 日期：O01 / 2026-09-07
状态：完成并勾选（子代理实现，主代理逐项复核全绿后勾选；另修复 W01–W05 遗留的 format:check 失绿）。
变更（未 commit，dirty 工作区）：
- 契约：DELETE /generations/{id}（GenerationDeleteResult：deleted const true、state、code? CANCEL_NOT_GUARANTEED；401/403/404/409）；gen:api 重生成无漂移；client 加 deleteGeneration（CSRF 头）。
- Worker：新增 apps/worker/src/cleanup.ts（CleanupService.sweep + purgeMediaObjects + RetentionPolicy 五期默认 1h/24h/7d/30d/90d 可 env 覆盖正整数校验）、local-storage.ts（LocalDiskRemover，与 api 同路径安全规则）；worker/index.ts 在 DATABASE_URL 存在时启动清理周期（CLEANUP_INTERVAL_SECONDS 默认 300s），sweep 异常不杀进程、SIGINT/SIGTERM 优雅停机。sweep 顺序：先物理删旧 expired→再转移新过期→任务行剪枝→审计剪枝（同轮新转移不当轮删=天然宽限）。
- API：新增 generation/delete.ts（DeleteService）；app.ts 媒体 GET 路由验签+属主匹配后新增 DB 状态复查（不存在 404、非 ready 或过 expires_at 一律 410 MEDIA_EXPIRED）——已签发 URL 过期/删除后立即失效（撤销签名权限，验收核心）；env.ts 5 个保留期配置项。
- 关键语义：物理删除先删字节成功才写 deletion_manifest（NOT EXISTS 防重复）+CAS state=deleted，存储失败留 expired 下轮重试（失败重试/重复清理幂等，验收核心）；在途/未知保护为结构性 NOT EXISTS（created/queued/running/outcome_unknown 的输入与结果媒体永不删）；行剪枝只剪 failed/cancelled/expired 且 job 租约活着不剪，succeeded/outcome_unknown 永不剪；输入媒体过期基准用 COALESCE(max(completed_at), confirmed_at, created_at)（侦察发现 expires_at 列只是上传会话 TTL）；用户删除保留 generation/attempt/result 哈希行（state 枚举无 deleted，query 天然渲染历史保留+downloadUrl=null），结果媒体立即删+manifest(user_delete)，无引用输入媒体一并删，created/queued 先取消（J08），running 回 CANCEL_NOT_GUARANTEED，outcome_unknown 409，重复删除幂等。
- 架构纠偏：初版 CleanupService 放 api 让 worker 依赖 @onepic/api，被 eslint 层边界规则拦下，改为 sweep 归 worker、api 侧 DeleteService 内联同序 purge 原语（两侧注释互相指引）。
- 卫生修复（主代理）：format:check 自 W01 起失绿（58 文件警告，ci-verify 不含此门禁故未拦截）；npm run format + execute.ts 单独 prettier --write 后 format:check 退出码 0。
验证（node 经 nvm PATH；真实 PG+LocalDiskStorage+mock provider+inject）：
- 新增 apps/worker/test/retention.integration.test.ts 10 例（主代理亲跑复核全绿）：三类媒体各自到期转移+下轮物理删+manifest+字节消失；存储失败 failures 上报+下轮重试成功；重复 sweep manifest 不增；在途输入回溯 96h 不过期；结果媒体过期→generation→expired→query 历史保留；审计 91d 剪 1d 留；终态 31d 五表行清除→GET 404；用户删除全链（字节消失+manifest user_delete+旧签名 URL 立即 410+重复幂等）；queued 删除先取消（配额释放一次）；running 删除 CANCEL_NOT_GUARANTEED；outcome_unknown 409；越权 403/404/401。
- apps/api/test/media-access.integration.test.ts 适配+新增 1 例（签名 URL 在 expired/deleted 后 410、无 DB 行 404）。
- 回归（主代理复核）：test:unit 31 文件 240、test:integration 23 文件 118、test:e2e 44 全绿；lint/typecheck/build:workspaces/gen:api:check/format:check 退出码 0；ci-verify.sh 退出码 0。
证据路径：本条目；apps/worker/src/cleanup.ts、apps/api/src/modules/generation/delete.ts、apps/worker/test/retention.integration.test.ts diff；/tmp/o01-ci-verify.log。
风险或阻塞 / 下一项：running 删除后 provider 仍交付时 execute 会新建结果媒体（CANCEL_NOT_GUARANTEED 固有语义，走正常 7 天保留）；用户删除 purge 存储失败的重试 manifest reason 记 retention 而非 user_delete（字节优先于元数据，已注释）；输入媒体 expires_at 列与真实保留语义脱节（sweep 不依赖该列）；worker/index.ts claim 循环未接线（J03 遗留，接入时需合并停机逻辑）。下一项：O02（结构化脱敏日志与低基数指标）。
```

```text
ID / 日期：O02 / 2026-09-07
状态：完成并勾选（子代理实现，主代理逐项复核全绿后勾选）。
变更（未 commit，dirty 工作区）：
- 共享脱敏：新增 packages/contracts/src/redaction.ts（redactText 形态级擦洗 + redactValue 深度键名脱敏；放 contracts 因层边界禁 worker→api 依赖）+ 7 例单测。键名覆盖 authorization/cookie/x-api-key/secret/token/session/signature/prompt 系/rawBody/b64_json 等（任意深度、大小写不敏感）；形态覆盖 sk-*、Bearer *、?signature=*、onepic_session=*（URL-encoded 同命中）；*Sha256 哈希/correlationId/errorCode 明确不脱敏（防过度，单测断言）。
- API：新增 bootstrap/logging.ts（pino serializers：req 脱敏 headers+URL 擦洗、res 仅 statusCode、err 丢 stack 留脱敏 message）；buildApp 支持 logStream 注入；errors.ts 的 404 消息 URL 经 redactText（原会把签名参数泄进响应体，已修）。
- Worker：新增 logging.ts（logEvent 全字段过 redactValue）、metrics.ts（MetricsRegistry 计数器 + collectGauges DB 派生 + renderPrometheus 文本 + evaluateAlerts 纯函数 + createMetricsHandler node:http loopback-only 默认 127.0.0.1）；index.ts 接入；CountingRemover 包装删除计数。
- 指标（低基数）：queue_oldest_pending_age_seconds{kind}（kind 固定枚举唯一标签）、generations_outcome_unknown、media_pending_purge 三 gauge + sweep/purge/storage failures 三 counter。告警阈值纯函数：队列 >300s QUEUE_STUCK、unknown>0 OUTCOME_UNKNOWN_PENDING、purge 积压>0 PURGE_BACKLOG、失败计数>0 SWEEP_FAILING/STORAGE_FAILING；超阈响应带 x-onepic-alerts 头。
- 端点决策：指标不进 OpenAPI 公共契约（运维平面，worker 进程内 counter 本不在 API 进程；公共契约暴露会引入无鉴权公网语义），worker 内置 loopback /metrics。
验证（node 经 nvm PATH；真实 PG+存储+mock provider+inject）：
- 哨兵集成 3 例（主代理亲跑复核全绿）：①logLevel=info 捕获全部 API 日志，跑上传→预审→生成（哨兵 provider key）→签名下载→provider 500→取消→删除→internal_error→sweep 存储失败重试全链路，逐行断言不含 5 个哨兵（签名 key/provider key/提示词正文/session token/URL signature）的原始/URL-encoded/base64 三形态（验收核心）；同时断言 500/200 日志带 reqId、internal_error 带 correlationId 且与响应体一致（脱敏不过度）②指标与告警：600s 老 pending+unknown+expired 媒体 → gauge 正确（含 kind 标签）、三告警全触发；静默场景零告警（告警可触发，验收核心）③/metrics 端点 200 含全部指标行且无哨兵、其他路径 404。
- 单测 +12（redaction 7 + observability 5）。
- 回归（主代理复核，分开跑）：test:unit 33 文件 252、test:integration 24 文件 121、test:e2e 44 全绿；lint/typecheck/format:check/build:workspaces/gen:api:check（无契约变更确认无漂移）退出码 0；ci-verify.sh 退出码 0。
证据路径：本条目；packages/contracts/src/redaction.ts、apps/worker/src/metrics.ts、apps/worker/test/observability.integration.test.ts diff；/tmp/o02-ci-verify.log。
风险或阻塞 / 下一项：pino redact paths 未启用，防护落在自定义 serializers+redactValue，未来 app.log.* 直接传敏感对象依赖调用方自律（残余）；进程内 counter 重启归零（诚实语义已注释，聚合归 Prometheus 抓取方）；指标服务器无鉴权（loopback-only 部署前提）；worker claim 循环仍未接线（J03 遗留），O02 计数器只覆盖清理路径。下一项：O03（安全负例矩阵）。
```

```text
ID / 日期：O03 / 2026-09-07
状态：完成并勾选（子代理实现，主代理逐项复核全绿后勾选）。
变更（未 commit，dirty 工作区）：
- 新建 docs/design/security-negative-matrix.md：九类负例 × 证据文件/用例对应表（既有点名+新增补缺），已登记 docs/development-context.md L1「测试、上线准备」行。
- 新增 apps/worker/test/security-negative.integration.test.ts 7 例（真实 PG+inject+存储）、apps/api/src/infra/storage/storage.test.ts 4 例、WorkspacePage.test.ts +1 例。
- 修复两个真实弱点（验收中实证发现，诚实记录）：①upload-service.ts 的 confirm 原样记录客户端声明 sha256（可伪造哈希链污染 generation.input_sha256）——改为对真实字节比对，不符 400 HASH_MISMATCH（新 UploadProblem，会话不消耗可重试，workbench-routes 映射 400）；②错误 Content-Type 的 PUT 字节返回 500——errors.ts 加 415→UNSUPPORTED_MEDIA_TYPE 映射。
- 既有测试修正（依赖了未校验哈希的弱点，非语义回退）：upload/precheck 集成 2 处 + 7 个 fixture 文件假哈希换真实 sha256（generation-create/cancel/execute/generation-query/reconcile/result/retry）。
九类映射（详见矩阵文档）：越权=既有 B04/W01–W03 点名；CSRF=既有 B03+新增带 cookie 无头 POST 403 且集合未创建；XSS=新增（恶意集合名原样存取+content-type 恒 json+Vue 插值转义 DOM 无 script）；SQL 注入=新增（注入 cursor 400/集合名参数化落库/itemKey 格式拒绝无行）；SSRF=既有 J04 provider 重定向拒绝+结果 URL 白名单（含 169.254.169.254），服务端无任意 URL 路径；上传绕过=既有 M02/M04+新增 confirm 哈希篡改 400/伪装 Content-Type 415/路径穿越 FORGED_OBJECT_PATH；配额竞争=既有 B05+新增 HTTP 层 429→取消释放→重获取；session 重放=既有 B03 旋转/撤销/过期 401+交叉所有权 403/404；日志泄漏=O02 哨兵+新增集合名哨兵不进请求日志。
验证（主代理复核，分开跑）：
- 新增测试亲跑：security-negative 7/7、storage.test 4/4。
- 回归：test:unit 34 文件 257、test:integration 25 文件 128、test:e2e 44 全绿；lint/typecheck/format:check/build:workspaces/gen:api:check 退出码 0；ci-verify.sh 退出码 0。
证据路径：本条目；docs/design/security-negative-matrix.md；apps/worker/test/security-negative.integration.test.ts、apps/api/src/modules/media/upload-service.ts、apps/api/src/bootstrap/errors.ts diff；/tmp/o03-ci-verify.log。
风险或阻塞 / 下一项：fetch 重定向语义由 adapter 显式拒绝覆盖（provider-adapter.test:99 为证）；admin 角色约束在 decideObjectAccess 层，HTTP 媒体路由按 owner 天然拒绝；itemKey 格式校验使 SQLi 负载只能得 400（合法负例证据）。指标端点无鉴权以 loopback 为前提（沿 O02）。下一项：O04（压测并记录容量预算）。
```

```text
ID / 日期：O04 / 2026-09-07
状态：完成并勾选（隔离本机实测通过；规划预算、实测事实和未测范围分列）。
变更（未 commit，dirty 工作区）：
- 新增 scripts/benchmark-capacity.mjs，并在 package.json 增加 benchmark:capacity。脚本只使用临时 PostgreSQL 16、loopback Fastify/Provider simulator、真实 opaque session/collections 路由、真实 PG job SQL/PoolClient、Sharp 和隔离临时目录；不接受生产数据库或 Provider 地址，真实/外部 Provider 调用为 0。
- 新增 docs/operations/capacity-testing.md；新增 docs/design/evidence/o04/capacity-report.{md,json}；docs/development-context.md 将操作说明和证据加入「测试、上线准备」索引。
- 非生图 API：真实 TCP/HTTP 压测带 session+PG 的 POST/GET collections，并记录 health 基线；队列：320 个 job、8 个独立 PoolClient 并发 claim/complete，记录 claim/排队等待/complete p95、吞吐、重复领取和终态；PG：pg_stat_activity 采样并记录 max_connections/shared_buffers；解码：独立子进程分别记录当前 metadata 校验与诊断性完整像素解码的 p95、RSS 与隔离 TMPDIR 峰值。
验证命令 / 退出码 / 关键断言：
- O06 Sharp 安全升级后复跑 npm run benchmark:capacity：退出码 0。Apple M1 Pro/16 GiB、Node 22.19.0、Sharp 0.35.4/libvips 8.18.6、PG 16.11；collections POST/GET p95 26.35/46.91 ms；queue claim/等待/complete p95 2.52/300.62/7.42 ms，1060.73 jobs/s，8/8 并发、0 重复、320/320 done/succeeded；PG 峰值 17/100；4096² JPEG 完整解码 p95 278.65 ms、RSS 增量 278.78 MiB、TMPDIR 峰值 0；全部 14 项预算断言 PASS。
- 可部署 Worker 进程实际探针：真实 PG claim/execute/complete + 真实本地存储 + 隔离 loopback simulator，claim=1、simulator request=1、generation/job=succeeded/done、外部 Provider=0。报告只声明至少一个执行路径，不把 8-client harness 冒充进程生图并发或 W06。
- 当前全量回归随 O06 复核：compiler/preview/schema/lint/typecheck/format/gen/build 退出码 0；Python 22 例、unit 39 文件 281 例、integration 26 文件 131 例、E2E 44 例通过；CI=true scripts/ci-verify.sh 输出 Repository verification passed。
证据路径：docs/design/evidence/o04/capacity-report.md；docs/design/evidence/o04/capacity-report.json；docs/operations/capacity-testing.md；scripts/benchmark-capacity.mjs。
风险或阻塞 / 下一项：真实 Provider/S3/TLS/生产 PG/多实例未测，W06 仍未授权；validateImage 产品路径与完整栅格解码探针分开记录；进程探针未测多 slot 生图吞吐。O06 已完成并复跑本项，下一项 O07。
```

```text
ID / 日期：O05 / 2026-09-07
状态：完成并勾选（干净容器启动、深链接、静态独立、真实 PG 在途停机及全量回归均通过）。
工作区版本 / 变更文件：main @ 41254dd + dirty。
- 新增 packages/managed-runtime/ 生产共享包（Provider allowlist/禁止重定向/SSRF 与凭据隔离、AbortSignal、Sharp 校验、本地磁盘存储），API 原路径改兼容 re-export；workspace manifests/lock/build/typecheck/test 顺序同步。
- 新增 apps/worker/src/config.ts|config.test.ts、runtime.ts、metrics-health.test.ts、test/runtime-shutdown.integration.test.ts；index.ts 从 cleanup-only 接入真实 generation claim/execute loop、独立 PoolClient slots、heartbeat/reconnect、内部 live/ready/metrics。
- execute.ts 增加 provider 请求开始回调和 abort signal，并强制 generation.provider_id 等于服务端 Worker provider；新增不同 provider 零发送拒绝测试。
- 优雅停机：先停止 claim 并等待；宽限期耗尽且请求可能已发送时，先 generation→outcome_unknown、attempt→unknown、job→dead，再 abort，重启不重新领取。
- 新增 Dockerfile 四 target、compose.yaml、ops/nginx/container.conf|static-container.conf、.dockerignore、apps/worker/.env.example、scripts/verify-local-stack.sh、docs/operations/local-stack.md 和 docs/design/evidence/o05/；移除 122 个未跟踪 AppleDouble sidecar 后容器上下文可读取，public 正式生成内容未手改。
验证命令 / 退出码 / 关键断言：
- npm run verify:local-stack：退出码 0；唯一 project/ports/volumes 干净构建并启动 PG/API/Worker/Web，API+Worker health 通过，五页 history 深链接刷新通过，catalog/case-532 通过，static target 无后端独立通过，Worker 容器 SIGTERM 记录 worker_stopped，临时 project 容器/卷全部删除。机器证据 local-stack-smoke.json 全部 true。
- runtime-shutdown.integration.test.ts：真实临时 PG+租约/CAS+本地存储 2/2。阻塞 Provider 在 40 ms grace 后 stop 报告 active=1/unknown=1/abort=1/remaining=0，DB outcome_unknown/dead/unknown，重启 Provider 调用 0；1 秒 grace 内完成则 succeeded/done。该 Provider 为本地 double，不是 W06。
- npm run benchmark:capacity：退出码 0；可部署 Worker dist 真实 claim/execute/complete=1、loopback simulator=1、外部 Provider=0；O04 全部 14 预算 PASS。
- npm run lint/typecheck/format:check/gen:api:check/build:workspaces：退出码 0；test:unit 39 文件 281、test:integration 26 文件 131、test:e2e 44 全绿；scripts/ci-verify.sh 退出码 0（Python 17，Repository verification passed；contracts 保留既有 health 4XX 两条 warning）。
证据路径：docs/design/evidence/o05/local-stack-report.md；docs/design/evidence/o05/local-stack-smoke.json；docs/operations/local-stack.md；scripts/verify-local-stack.sh；apps/worker/test/runtime-shutdown.integration.test.ts；docs/design/evidence/o04/capacity-report.{md,json}；/tmp/o05-local-stack.log；/tmp/o05-ci-verify.log。
风险或阻塞 / 下一项：真实/付费 Provider、S3、生产 TLS/PG、多实例和编排器强杀未测；W06 未授权保持未勾选。容器 stop grace 必须大于 Worker grace。本项未 commit/push/deploy/生产迁移。下一项 O06：CI 门禁与独立服务制品。
```

```text
ID / 日期：O06 / 2026-09-07
状态：完成并勾选（完整 CI 门禁、五种独立制品、负例阻断、checksum/manifest/load 和回归均通过）。
工作区版本 / 变更文件：main @ 41254dd + dirty。
- CI：扩展 scripts/ci-verify.sh，纳入 compiler/library/design/preview、Python、npm audit、lint/contract/type/format/build、unit、真实 PG integration、Chromium E2E 和生成路径 fingerprint；.github/workflows/ci.yml 使用 npm ci、PG16、Playwright 并让四镜像 matrix needs verify；.woodpecker/deploy.yml 仅 manual。
- 后续 CI 维护（2026-09-09）：Woodpecker 恢复 `main` push 验证，但 `deploy-production` 仍由步骤级 `event: manual` 门禁；push 只运行 verify/package，绝不自动部署。
- 生产前端修正（2026-09-09）：Woodpecker 生产制品切换为 `apps/web/dist + public/data + public/previews`，旧 `public/` 静态站继续作为独立 catalog-only 制品，不再作为生产域名默认界面。
- 确定性/安全：build_library generatedAt 绑定 source manifest importedAt；新增 fingerprint_paths.py、create_static_artifact.py 及 tests/test_static_artifact.py；package-site 采用严格 allowlist、确定性 tar+gzip、便携 checksum 和 manifest。
- 独立镜像：新增 API/Worker/Contracts production tsconfig 排除测试并清空 dist；Docker 生产依赖层、非 root node、许可证和运行时权限修复；package-container-image.sh 检查服务边界、测试/文档/临时/凭据、preview 命名、image config/history，导出独立 tar/checksum/manifest。
- 依赖：pg 与 Worker contracts 调整为实际 runtime dependency；Sharp 升至 0.35.4/libvips 8.18.6，npm audit 由 high 1 降为 0。
验证命令 / 退出码 / 关键断言：
- CI=true ONEPIC_PG_BIN=/opt/homebrew/opt/postgresql@16/bin bash scripts/ci-verify.sh：O07 回归后退出码 0，Repository verification passed；Python 22、unit 40/286、integration 26/131、内嵌 recovery、E2E 44，audit/lint/type/format/gen/build 全通过，连续生成 fingerprint 相同。
- actionlint + workflow Prettier/YAML：退出码 0；远端 runner 未触发（无 push 授权），未冒充远端执行。
- package-container-image.sh api|worker|web|static：全部退出码 0；四个 tar checksum、manifest、gzip 和 docker load 通过，load image ID 与 manifest 相同；API/Worker/Web/static payload 边界与许可证检查通过。
- package-site.sh 连续两次：退出码 0；1203 members，cmp 逐字节相同，SHA256 145f3555b08252be147b5223e6faed82b9b065c84410a4b6e5cf25dca21ce3a1。
- public/o06-artifact-negative.tmp 负例：修复 shell ! pipeline 盲点后容器打包按预期非零且未生成目标归档；Python policy tests 证明文档/临时/source-map/异常预览和凭据内容拒绝且不回显值。
- npm run verify:local-stack：Docker 权限修复后退出码 0，PG/API/Worker/Web/static health、五页深链接、静态独立和 Worker SIGTERM 全通过，外部 Provider=0。
- npm run benchmark:capacity：Sharp 0.35.4 后 O04 14 项预算 PASS，外部 Provider=0。
证据路径：docs/design/evidence/o06/release-report.md；docs/design/evidence/o06/release-artifacts.json；docs/operations/release-artifacts.md；scripts/ci-verify.sh；scripts/package-site.sh；scripts/package-container-image.sh；scripts/create_static_artifact.py；scripts/fingerprint_paths.py；.github/workflows/ci.yml；.woodpecker/deploy.yml；.tmp/o07-release-regression/（O07 后本地重打制品，不提交）；/tmp/o07-ci-verify.log。
风险或阻塞 / 下一项：未执行 commit/push/registry push/远端 CI/deploy/生产迁移；真实/付费 Provider 未调用，W06 保持未勾选。容器 tar 不宣称跨 daemon 逐字节复现；静态 tar 已实测可复现。下一项 O07。
```

```text
ID / 日期：O07 / 2026-09-07
状态：完成并勾选（真实隔离 PG backup/restore、删除清单 CLI、兼容与 no-down-SQL 回滚均通过）。
工作区版本 / 变更文件：main @ 41254dd + dirty。
- 新增 scripts/rehearse-recovery.mjs、apps/worker/src/replay-deletions.ts|replay-deletions-cli.ts|replay-deletions.test.ts、npm rehearse:recovery/replay:deletions 命令；CI 在 integration 后内嵌 recovery rehearsal 并清理 runner 临时报告。
- 新增 docs/operations/recovery-runbook.md 与 docs/design/evidence/o07/recovery-report.{md,json}，索引同步；Runbook 明确生产逐项授权、PGPASSFILE、私有对象恢复、dry/apply 删除重放、expand/contract 与应用回滚不 down-migrate。
验证命令 / 退出码 / 关键断言：
- ONEPIC_RECOVERY_REPORT=docs/design/evidence/o07/recovery-report.json npm run rehearse:recovery：退出码 0，5540 ms；v3 custom dump 42434 bytes 与 v5 dump 42662 bytes 均恢复 source=restore；schema [1,2,3]→[1..5]，五个 migration 无 DROP/TRUNCATE。
- 实际 Worker CLI 删除重放：dry-run scanned=1/removal=0；apply scanned=1/removal=1/failures=0 且恢复出的对象消失；重复 apply failures=0。
- 兼容：上一 HEAD public 经 loopback HTTP 首页/catalog 576/case-532 prompt 通过；旧列 SELECT 和忽略新增 nullable 列的 INSERT 在 v5 成功；恢复库 API live/ready=200；应用回滚探针后 schema 仍 [1..5]，未恢复旧 DB、未执行 down SQL。
- 最终 CI=true scripts/ci-verify.sh：退出码 0；Python 22、unit 40/286、integration 26/131、内嵌 recovery、E2E 44，Repository verification passed；演练后无 onepic-recovery/onepic-pgtest 临时目录。
- O07 改动后 O06 四镜像重新 build/inspect/checksum/manifest/docker load 全通过，Worker 制品包含 replay-deletions-cli.js；静态 tar SHA 保持 145f3555...。
证据路径：docs/design/evidence/o07/recovery-report.md；docs/design/evidence/o07/recovery-report.json；docs/operations/recovery-runbook.md；scripts/rehearse-recovery.mjs；apps/worker/src/replay-deletions*.ts；/tmp/o07-recovery-final.log；/tmp/o07-ci-verify.log；.tmp/o07-release-regression/（本地制品，不提交）。
风险或阻塞 / 下一项：对象演练为 phase-one LocalDiskStorage，真实 S3 需后续单独授权环境；本机小数据耗时不是生产 RTO/RPO。未 commit/push/deploy/生产迁移/付费调用，W06 仍未授权。下一项 Z01。
```

```text
ID / 日期：Z01 / 2026-09-07
状态：完成并勾选（全量回归、13 分类与最长/框架 prompt 抽查通过）。
工作区版本 / 变更文件：main @ 41254dd + dirty；新增 docs/design/evidence/z01/final-regression.{md,json}，仅脚本重建 generated library/public。
验证命令 / 退出码 / 关键断言：
- CI=true ONEPIC_PG_BIN=/opt/homebrew/opt/postgresql@16/bin bash scripts/ci-verify.sh：退出码 0；Python 22、unit 40/286、真实 PG integration 26/131、O07 recovery、Chromium E2E 44，Repository verification passed。
- npm run check：退出码 0；576=529 case+47 framework，ID 唯一，576 prompt 正文/顺序/hash 一致；529 case preview、493 reviewed generated preview、45 sidecar 全部通过。
- 实际抽查 13 分类各一项；case-532 为最长 15493 字符且产品安全适配器通过；framework-001 UI 原创限制通过；Brand/Charts/History 等专项防幻觉规则通过。
- NOTICE/LICENSE/two third_party licenses 非空；静态包重建 SHA256 仍 145f3555...；data/source tracked diff 为空且无 untracked。
证据路径：docs/design/evidence/z01/final-regression.md；docs/design/evidence/z01/final-regression.json；/tmp/o07-ci-verify.log；/tmp/z01-npm-check.log。
风险或阻塞 / 下一项：上游 ZIP 不在仓库/本机相邻路径，无法重新哈希，只核对 manifest hash 和 canonical source tree 未变；真实 Provider 未授权，W06 仍未勾选。下一项 Z02。
```

```text
ID / 日期：Z02 / 2026-09-07
状态：完成并勾选（README/静态与全栈架构/规范/DESIGN/数据字典/OpenAPI/索引/HTML 与当前实现同步）。
工作区版本 / 变更文件：main @ 41254dd + dirty；更新 README.md、docs/{architecture,full-stack-architecture,frontend-backend-standards}.md、docs/design/{DESIGN,backend-data-dictionary}.md、contracts OpenAPI/generated、三处模式隐私 UI 文案、scripts/serve.py；新增 docs/design/evidence/z02/。
验证命令 / 退出码 / 关键断言：
- Markdown 本地链接检查：README + 26 份 docs Markdown，69 链接/0 缺失；过期陈述扫描 0；engineering-review.html 与 development-handoff.html 均由 Markdown 重新生成。
- npm run gen:api:check：无漂移；Redocly valid（仅 health 无 4XX 的两条既有 warning）；成功/错误 envelope、当前 endpoint 与架构表一致。
- CI=true ONEPIC_PG_BIN=/opt/homebrew/opt/postgresql@16/bin bash scripts/ci-verify.sh：退出码 0；Python 22、unit 40/286、integration 26/131、recovery、E2E 44，Repository verification passed。
- npm run verify:local-stack：当前 UI/API 镜像 PG/API/Worker/Web/static、深链接、静态独立、SIGTERM、资源清理全通过。
- 四镜像和 standalone static tar 在 .tmp/z02-release-regression 重建；checksum/gzip/manifest/docker load 全通过；静态 tar SHA 145f3555... 未变。
- E2E 当前 UI 44 例通过并重写 U12 15 张截图；scripts/serve.py 不再输出浏览器取消 lazy image 的 BrokenPipe/ConnectionReset traceback。
证据路径：docs/design/evidence/z02/documentation-sync.{md,json}；docs/design/evidence/o05/local-stack-smoke.json；docs/design/evidence/o06/release-artifacts.json；/tmp/z02-ci-verify-final.log；/tmp/z02-local-stack.log；.tmp/z02-release-regression/（本地，不提交）。
风险或阻塞 / 下一项：实现与本地验证不代表生产部署；真实 S3、远端 CI、deploy、生产 migration 和真实/付费 Provider 均未做，W06 未授权。下一项 Z03。
```

```text
ID / 日期：Z03 / 2026-09-08
状态：完成并勾选；首轮独立复查的 2 个 MEDIUM 已关闭，最终复查 PASS（BLOCKER 0 / HIGH 0 / MEDIUM 0，findings none）。
工作区版本 / 变更文件：main @ 41254dd + dirty；W06 后 ProviderAdapter 改为 OpenAI-compatible 单图 multipart 并保持 prompt LF/hash；同步 README/架构/运行文档，新增 Z04 交付记录，`.gitignore` 忽略 `.vitest/`，重建 O06 v7 制品证据。
验证命令 / 退出码 / 关键断言：
- 首轮只读独立复查直接确认 multipart/prompt hash、W06 1/1 真实请求、gitleaks、v6 制品、CI/local stack/O04/source/session-secret 技术项通过；发现 2 个 MEDIUM：权威文档仍保留 W06/v5 旧状态，及 `.vitest/json/output.json` 未忽略。
- 已同步 README、architecture、full-stack-architecture、local-stack、development context/checklist，新增 Z04；`.gitignore` 加入 `.vitest/`；gitleaks 默认规则继续启用且仅精确 allowlist `.tmp/w06-provider.env`。
- 文档/缓存修正后重建 v7 五制品，build-time fingerprint `6ce80a41291f3b483eba147f951099bbc40c37c539b3aa07ff1608b84005c9d3`；checksum/gzip/docker load/image ID/OCI labels/manifest 全通过，standalone static 连续构建逐字节一致。
- 最终独立只读复审直接核验当前源码、W06 证据、v7 制品、依赖闭包、gitleaks、CI/local stack/O04/recovery/source/session-secret 及 Markdown/JSON/HTML 一致性；结论 PASS，0/0/0，明确“无阻断 finding，Z03 可勾选”。
证据路径：docs/design/evidence/z03/final-review.{md,json}；docs/design/evidence/z04/final-delivery.{md,json}；docs/design/evidence/o06/release-{report.md,artifacts.json}；docs/design/evidence/w06/real-provider-report.{md,json}；.tmp/z04-final-artifacts-v7/（本地，不提交）。
风险或阻塞 / 下一项：无 Z03 阻断 finding；残余生产边界已列入 Z04。未执行 commit/push/registry push/deploy/生产 migration 或额外付费调用。下一项：Z04 最终交付记录收口。
```

```text
ID / 日期：Z04 / 2026-09-08
状态：完成并勾选；最终交付记录、启动命令、测试证据、v7 制品、残余风险和操作边界均已落盘。
工作区版本 / 变更文件：main @ 41254dd + dirty；新增 docs/design/evidence/z04/final-delivery.{md,json}，同步开发索引、README/架构/运行文档、O05/Z01/Z02 历史状态说明、O06 v7 制品证据及 Z03 最终 PASS 证据。
验证命令 / 退出码 / 关键断言：
- CI=true ONEPIC_PG_BIN=/opt/homebrew/opt/postgresql@16/bin bash scripts/ci-verify.sh：退出码 0；Python 23、unit 41/292、integration 26/133、recovery PASS、Chromium E2E 44/44，Repository verification passed。
- npm run verify:local-stack：退出码 0；npm run benchmark:capacity：14/14 PASS；W06：授权上限/实际 Provider 请求 1/1，真实像素、下载、hash、metadata、sidecar PASS。
- v7 五制品 `.tmp/z04-final-artifacts-v7/` checksum/gzip/load PASS，standalone static 连续构建逐字节一致；build-time fingerprint `6ce80a41291f3b483eba147f951099bbc40c37c539b3aa07ff1608b84005c9d3`。
- gitleaks：0 findings；`.vitest/` 已精确忽略；Markdown 31 文件/89 本地链接无缺失；JSON 与制品 manifest 一致；派生 HTML 由当前 Markdown 重建。
- 最终独立复审 PASS：BLOCKER/HIGH/MEDIUM 0/0/0，findings none；所有必选清单项已勾选，未勾选项 0。
证据路径：docs/design/evidence/z04/final-delivery.{md,json}；docs/design/evidence/z03/final-review.{md,json}；docs/design/evidence/w06/real-provider-report.{md,json}；docs/design/evidence/o04/、o05/、o06/、o07/、z01/、z02/；.tmp/z04-final-artifacts-v7/（本地，不提交）。
风险或阻塞 / 下一项：本地交付无剩余必选阻塞。真实 S3、远端 CI、生产 TLS/多实例/PG 和原 2026-09-05 设计图不可恢复均已如实列为残余风险。未执行且未获授权：commit、push、registry push、deploy、生产 migration、额外付费 Provider 调用。
```

渲染命令（在仓库根运行，更新清单后同步 HTML）：

```bash
pandoc GOAL.md docs/development-context.md docs/development-checklist.md --from=gfm --standalone --toc --lua-filter=docs/render-handoff.lua --metadata title='OnePic 开发 Goal 与清单' --metadata lang=zh-CN --css=engineering-review.css -o docs/development-handoff.html
```

HTML 是阅读快照，勾选与执行记录必须编辑本 Markdown 后重新生成，禁止只在浏览器勾选。
