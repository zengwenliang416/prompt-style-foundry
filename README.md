# 一图万式 · OnePic Template Studio

一个从零搭建的、独立的单图视觉提示词模板项目。

它不会修改上游仓库，也不是上游项目的分支或换皮版本。导入脚本把上游 ZIP 当作**只读素材源**，抽离其中的规范化提示词，再通过本项目自己的单图协议编译为可直接使用的 `[System / Prompt]` 模板。

## 当前内容

- 529 条案例视觉蓝图
- 47 条框架提示词
- 合计 576 条单图模板
- 576 个独立 TXT 提示词文件
- 529 张压缩后的 WebP 预览图
- 完整来源、作者、链接和校验信息

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

## 目录结构

```text
onepic-template-studio/
├── public/                         # 可直接部署的静态网站
│   ├── index.html
│   ├── assets/
│   ├── data/
│   │   ├── catalog.json            # 轻量模板索引
│   │   └── prompts/                # 576 个可直接复制的 TXT
│   └── previews/                   # 529 张 WebP 预览图
├── data/
│   ├── source/                     # 从上游 ZIP 只读抽离的原始数据
│   └── library/templates.json      # 完整规范化模板库
├── scripts/
│   ├── import_source.py            # 只读导入与预览压缩
│   ├── prompt_protocol.py          # 我们自己的单图模板协议
│   ├── build_library.py            # 编译 576 条最终提示词
│   ├── validate_library.py         # 完整性与来源验证
│   └── serve.py                    # 零依赖本地静态服务
├── tests/
├── docs/
├── third_party/
├── AGENTS.md
├── NOTICE.md
└── package.json
```

## 直接运行

项目已经包含生成后的数据，不需要重新导入上游 ZIP。

```bash
npm run dev
```

然后打开：

```text
http://127.0.0.1:4173
```

也可以不使用 npm：

```bash
python3 scripts/serve.py
```

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

## 站内生图（可选 BYOK）

模板浏览功能完全离线可用。若想在站内直接出图，可配置自己的生图服务：

1. 点击右上角「生图设置」，填入任意 NewAPI / OpenAI 兼容接口地址与 API Key；
2. 打开任意模板，上传一张参考图，点击「生成图片」；
3. 浏览器把参考图和编译后的提示词直接发往 `{Base URL}/v1/images/edits`，返回结果可预览、下载。

隐私边界：密钥只存在本浏览器 localStorage；请求由浏览器直连你填写的服务，本项目没有服务器，不做任何中转或遥测。未开启 CORS 的接口会得到明确的错误提示。

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

## 验证

```bash
npm run check
```

该命令会验证：

- 576 条模板数量和唯一 ID
- 529 条案例与 47 条框架模板
- 576 个最终提示词文件
- 529 张预览图
- 必备 Prompt 区段
- 原比例与不追问规则
- 蓝图和最终提示词 SHA-256
- 上游缺失 Markdown fence 的确定性恢复
- 上游 ZIP 的只读来源声明

## 部署

`public/` 是完整静态站点，可部署到任意静态托管服务。发布目录设置为：

```text
public
```

不需要服务器、数据库或运行时密钥。

## 许可与来源

本项目代码采用 MIT License。上游提示词蓝图和预览素材的许可及来源说明见 [NOTICE.md](NOTICE.md) 与 `third_party/awesome-gpt-image-2-LICENSE`。
