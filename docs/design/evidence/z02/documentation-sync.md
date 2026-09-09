# Z02 文档、契约与派生 HTML 同步证据

## 结论

Z02 通过。README、静态/全栈架构、代码规范、DESIGN、数据字典、OpenAPI、上下文索引与两份派生 HTML 已同步到当前实现；明确区分“已在本地实现并验证”与“尚未部署/未做真实 Provider/S3 验证”，移除了“后端不存在”“仅 health endpoint”“Woodpecker 可由 main push 部署”等过期陈述。

机器摘要：`documentation-sync.json`。

## 主要同步

- `README.md`
  - 记录 576 prompt、570 public preview 文件名、493 reviewed generated previews、五页 Vue、API/Worker/PG 与三种运行模式。
  - 分开说明原 `public/` 静态运行、五页本地栈和受管配置。
  - direct-BYOK 与 managed-generation 的密钥/数据路径分别表述。
  - CI、五种制品和 manual-only Woodpecker 与真实配置一致；不宣称已远端运行或部署。
- `docs/architecture.md`
  - 明确只描述必须保留的 static catalog/compiler boundary，并链接已实现全栈扩展。
- `docs/full-stack-architecture.md`
  - 状态改为已实现、本地隔离验证、未部署/未真实付费调用。
  - 五页表和 API endpoint 表与当前 OpenAPI 一致。
  - 标明 phase-one LocalDiskStorage 与生产 S3 gap、已实现 retention defaults、O01–O07 验证和剩余门禁。
- `docs/frontend-backend-standards.md`
  - 成功/错误 envelope 与 OpenAPI 一致。
  - migration 规范改为 expand/contract；应用回滚不自动 down-migrate。
- `docs/design/DESIGN.md`
  - D03/D04/U12 状态与用户批准的重建五图事实一致；原图仍不可恢复。
  - 三模式数据去向、工作区显式导入和 U12 当前证据写入规范。
- `docs/design/backend-data-dictionary.md`
  - 从“D00 前设计稿”改为实现对照；声明 migration/OpenAPI 为权威。
- `packages/contracts/openapi/api-v1.yaml`
  - info description 与全部当前 endpoint 同步；health ready 说明 PostgreSQL/catalog-only 语义并明确不探测 Provider。
  - Z03 后补齐 auth login/callback/me/refresh/logout、签名 media 与 generation sidecar；runtime、contracts 生成物和 client 方法一致。
  - 已重新生成 `api-v1.json` / TypeScript declaration，drift check 通过。
- `docs/development-context.md`
  - 索引当前 Vue/static 双前端、ADR 0003、OpenAPI、O04–O07 和 Z01 证据。
- `docs/engineering-review.html`、`docs/development-handoff.html`
  - 均由 Markdown 权威源重新生成，不手改 HTML。

## 产品文案修正

`HomePage.vue`、`GuidePage.vue`、`SettingsDialog.vue` 的通用隐私文字从“总是直连自定义接口”改为：目录浏览不上传，只有明确点击生成后才按所选模式发送。direct-BYOK 的直连/本机 Key 说明仍保留；managed 说明明确经服务端/Worker，避免把受管路径误写成直连。

静态 server 同时忽略浏览器取消 lazy image 下载时的 `BrokenPipeError` / `ConnectionResetError`，完整 E2E 不再打印断连 traceback。

## 校验

```bash
npm run gen:api
npm run gen:api:check
npm run lint:contract
CI=true ONEPIC_PG_BIN=/opt/homebrew/opt/postgresql@16/bin bash scripts/ci-verify.sh
npm run verify:local-stack
bash scripts/package-container-image.sh api|worker|web|static ...
bash scripts/package-site.sh ...
```

结果：

- OpenAPI generated output 无漂移；Redocly valid、0 error，保留 5 条建议性 response warning（2 条 health 无 4XX，3 条 302-only auth redirect 无 2XX/4XX）。
- Z03 修复后全量 CI 退出码 0：Python 23、unit 41/290、integration 26/131、O07 recovery、Chromium E2E 44，`Repository verification passed.`。
- README 与 26 份 docs Markdown（共 27 个文件）中的 70 个本地链接全部存在。
- 过期陈述扫描 0 命中；engineering review 不再包含“待实施目标方案”。
- local stack 在当前 UI/API/镜像上再次通过并清理容器/卷。
- 四镜像 + standalone static tar 再次 checksum/gzip/manifest/docker load 通过；static tar SHA256 保持 `145f3555b08252be147b5223e6faed82b9b065c84410a4b6e5cf25dca21ce3a1`。
- E2E 44 例通过，static server 无 disconnect traceback；U12 15 张截图由当前页面重新写入。

## 边界

Z02 执行当时没有执行 commit、push、registry push、远端 CI、deploy、生产 migration、真实 S3 或真实/付费 Provider 调用，且未用 mock 冒充 W06。W06 后续已在单次授权下独立完成，见 [`../w06/real-provider-report.md`](../w06/real-provider-report.md)；真实 S3 与其余未授权动作至今仍未执行。
