# PostgreSQL / 对象存储迁移、备份、恢复与回滚 Runbook

## 适用范围与授权

本 Runbook 覆盖 OnePic 模块化单体 API、独立 Worker、PostgreSQL job table 和私有对象存储。默认演练命令只创建 `127.0.0.1` 临时 PostgreSQL 16 与 OS 临时目录，不连接生产、不会调用 Provider。

以下生产动作必须逐次获得明确授权：执行 migration、停止写入、创建或恢复生产备份、对象存储恢复、删除清单 `--apply`、切换流量、应用回滚和部署。不要把本地演练通过当作生产备份可用证明。

## 核心原则

1. **先备份、再变更、先恢复演练、后放量。** 数据库 dump 和对象快照必须记录同一变更窗口、版本、加密位置和 SHA256/服务端校验值。
2. **migration 采用 expand/contract。** 当前 `0001`–`0005` 只新增表、索引或 nullable 列。破坏性 contract migration 必须独立审批、在旧应用退役并超过回滚窗口后执行。
3. **应用回滚不执行 down migration。** 回滚旧 API/Worker 镜像时数据库保持已应用的新 schema；旧版本必须先通过兼容探针。
4. **删除事实优先于恢复出来的旧字节。** 数据库的 `deletion_manifest` 是删除通道；对象快照恢复后必须先 dry-run，再重放删除清单，之后才能开放下载或生成流量。
5. **静态目录保持独立。** API 故障或恢复期间可继续提供已验证的 `public/` 制品；不得把“静态可读”误报为 managed generation 可用。

## 角色与最小权限

- 数据库操作员：只拥有备份、创建恢复库、执行已审核 migration 所需权限。
- 对象存储操作员：私有 bucket 的 snapshot/restore/delete 权限，无 public ACL 权限。
- 应用发布者：可切换 API/Worker/Web 版本，不应持有数据库超级用户密码。
- 复核者：独立校验 backup checksum、schema versions、对象删除重放报告与 API health。

凭据通过 secret manager、受管环境或 `.pgpass` 注入。命令历史、工单和证据文档不得记录数据库 URL 密码、对象签名 URL、图片内容或 Provider key。

## 本地一键演练

前置：Node lockfile 依赖、PostgreSQL 16 的 `initdb/pg_ctl/pg_dump/pg_restore/psql`。

```bash
npm ci
ONEPIC_PG_BIN=/opt/homebrew/opt/postgresql@16/bin \
ONEPIC_PREVIOUS_RELEASE_REF='HEAD^' \
ONEPIC_RECOVERY_REPORT=.tmp/o07-recovery-report.json \
npm run rehearse:recovery
```


`ONEPIC_PREVIOUS_RELEASE_REF` 应指向实际上一发布版本的 commit/tag；未设置时演练默认 `HEAD^`，CI checkout 保留至少两层历史。脚本会验证该 ref、记录解析后的 commit，并拒绝不存在的 ref。
演练执行：

1. 临时库迁移到 v3，写入旧应用契约数据。
2. `pg_dump --format=custom --no-owner --no-privileges`，恢复到空库并逐字段比较关键快照。
3. 恢复库从 v3 expand 到 v5；用旧版列投影和不包含新列的 INSERT 验证应用回滚兼容。
4. v5 再次备份并恢复到灾难恢复库，比较 schema versions、行数和旧版投影。
5. 模拟对象快照把已经删除的对象字节恢复回来；实际执行 Worker 删除清单 CLI 的 dry-run、`--apply` 和重复 `--apply`，确认字节删除且重放幂等。
6. 从 `ONEPIC_PREVIOUS_RELEASE_REF`（默认 `HEAD^`）解析出的 commit 执行 `git archive <revision> public`，启动前一已跟踪静态前端，读取首页、catalog 和 `case-532` prompt。
7. 当前 API 连接恢复库，`live`/`ready` 均须 200。
8. 核验 migration 无 `DROP`/`TRUNCATE`，应用回滚探针后数据库仍为 v1–v5；清理临时库、对象目录和 HTTP server。

权威机器结果：`docs/design/evidence/o07/recovery-report.json`。

## 生产变更前备份清单

在获批维护窗口中：

1. 记录当前 Git revision、API/Worker image ID、OpenAPI/schema 版本、`schema_migrations`、数据库版本和对象存储版本/快照 ID。
2. 停止新的 managed generation claim；等待在途任务完成或按 O05 停机规则进入安全终态。不要盲目重发 `outcome_unknown`。
3. 短暂冻结会改变数据库或对象的写路径，或使用数据库/对象存储提供的时间一致性机制。记录冻结起止时间和预计 RPO。
4. 创建 PostgreSQL custom-format backup：

```bash
PGPASSFILE="$ONEPIC_PGPASSFILE" pg_dump \
  --host="$ONEPIC_DB_HOST" \
  --port="$ONEPIC_DB_PORT" \
  --username="$ONEPIC_DB_USER" \
  --dbname="$ONEPIC_DB_NAME" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="onepic-${RELEASE_ID}.dump"
sha256sum "onepic-${RELEASE_ID}.dump" > "onepic-${RELEASE_ID}.dump.sha256"
pg_restore --list "onepic-${RELEASE_ID}.dump" > "onepic-${RELEASE_ID}.dump.list"
```

生产中优先用 `.pgpass`/受管身份，避免密码出现在参数或日志；以上变量只展示名称，不写真实值。

5. 创建私有对象存储快照/版本清单，记录 bucket、version ID/快照 ID、对象计数、总字节和服务端 checksum；确认无 public ACL。
6. 将数据库 backup、对象 snapshot metadata、checksum、migration 列表和删除清单最大 `deleted_at` 放入同一加密恢复包。备份访问要审计并有到期策略。
7. 在隔离账户/网络执行恢复演练。未恢复成功、checksum 不符、版本不符或删除重放失败时禁止迁移/发布。

## 数据库恢复

绝不覆盖唯一生产库。先恢复到新的隔离数据库/实例：

```bash
sha256sum -c "onepic-${RELEASE_ID}.dump.sha256"
PGPASSFILE="$ONEPIC_RESTORE_PGPASSFILE" createdb \
  --host="$ONEPIC_RESTORE_DB_HOST" \
  --port="$ONEPIC_RESTORE_DB_PORT" \
  --username="$ONEPIC_RESTORE_DB_USER" \
  "$ONEPIC_RESTORE_DB_NAME"
PGPASSFILE="$ONEPIC_RESTORE_PGPASSFILE" pg_restore \
  --host="$ONEPIC_RESTORE_DB_HOST" \
  --port="$ONEPIC_RESTORE_DB_PORT" \
  --username="$ONEPIC_RESTORE_DB_USER" \
  --dbname="$ONEPIC_RESTORE_DB_NAME" \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  "onepic-${RELEASE_ID}.dump"
PGPASSFILE="$ONEPIC_RESTORE_PGPASSFILE" psql \
  --host="$ONEPIC_RESTORE_DB_HOST" \
  --port="$ONEPIC_RESTORE_DB_PORT" \
  --username="$ONEPIC_RESTORE_DB_USER" \
  --dbname="$ONEPIC_RESTORE_DB_NAME" \
  -c 'SELECT version, name, applied_at FROM schema_migrations ORDER BY version;'
```

恢复后必须校验：

- `schema_migrations` 与备份 manifest 一致，版本无缺口。
- subject/template/media/generation/job/deletion_manifest 的行数与抽样哈希一致。
- 外键、唯一约束和关键索引存在。
- `outcome_unknown`、leased job、quota ledger 和 deletion manifest 数量符合备份时事实。
- API `live`/`ready` 通过；健康检查不触发 Provider。

## 对象存储恢复与删除清单重放

先恢复到私有隔离 bucket/prefix，不开放下载。数据库和对象 snapshot 恢复完成后：

```bash
DATABASE_URL="$ONEPIC_RESTORE_DATABASE_URL" \
MEDIA_STORAGE_ROOT="$ONEPIC_RESTORE_STORAGE_ROOT" \
npm run replay:deletions -w @onepic/worker
```

默认是 dry-run，仅输出 scanned/batches，`removalAttempts=0`。人工比对范围后，单独批准 apply：

```bash
DATABASE_URL="$ONEPIC_RESTORE_DATABASE_URL" \
MEDIA_STORAGE_ROOT="$ONEPIC_RESTORE_STORAGE_ROOT" \
npm run replay:deletions -w @onepic/worker -- --apply
```

要求 `failures=0`。重复执行必须仍成功，因为对象 DELETE 必须幂等。phase-one CLI 使用 `LocalDiskStorage`；生产 S3-compatible adapter 接入后必须以相同 `replayDeletionManifest` 端口做一次真实私有 bucket 演练，未演练前不得声称 S3 恢复已验证。

重放只选择 `media_object.state='deleted'` 且存在 `deletion_manifest` 的对象，不会删除 ready/quarantine/expired 数据。不要通过手工 SQL 改状态来扩大删除范围。

## Expand migration

1. 对恢复库先运行 migration，记录命令和版本：

```bash
DATABASE_URL="$ONEPIC_RESTORE_DATABASE_URL" node apps/api/dist/db/migrate-cli.js
```

2. 用当前版本 API/Worker 运行 integration、health 和一条无 Provider 的目录/工作区路径。
3. 用“上一应用版本”执行兼容探针：旧 SELECT 投影和不包含新增 nullable 列的 INSERT 必须成功。
4. 确认新增字段允许旧应用忽略；禁止在同一发布中删除/重命名旧字段或立即加非空无默认约束。
5. 通过后才可在获批生产窗口执行相同 migration。migration 失败由单 migration transaction 回滚；不要手工伪造 `schema_migrations` 记录。

## 应用回滚

触发条件包括：新应用错误率、队列/unknown、权限或数据完整性指标越界，且无法在允许时间内前滚修复。

1. 停止新 Worker claim，保存日志/指标和 correlation ID；不要中止后盲目重发未知任务。
2. 将 API/Worker/Web 切换到上一已验证 image/artifact。
3. **保持数据库在当前 schema version，不运行 down SQL、不恢复发布前数据库 backup。** 恢复旧数据库会丢失发布后的任务/配额/删除事实。
4. 运行旧应用兼容 health、目录、工作区读写和静态前端 smoke。
5. 如果旧应用无法使用 expand 后 schema，停止流量并前滚修复；不得临时 DROP 新列/表。
6. 只有灾难恢复（数据损坏/实例丢失）才使用 backup restore；这不是普通应用回滚。

Contract migration 必须在回滚窗口结束后单独发布，并先证明所有在用应用都不再读写旧结构。破坏性 SQL 永不跟随应用镜像自动执行。

## 恢复完成与放量

- checksum、schema、行数/抽样哈希、删除重放、对象私有性、API health、上一版本兼容全部通过。
- 先只读/小流量 API，再恢复 Worker claim；监控 queue age、unknown、storage failures、purge backlog 和 PG connections。
- 保留恢复报告，但删除临时明文图片/对象和临时数据库。
- 记录实际 RTO/RPO。O07 本机演练耗时仅代表本机小数据集，不作为生产预算。

## 失败处理

- backup checksum/restore 失败：停止，重新生成或从上一份已验证备份恢复。
- deletion replay 有 failures：保持 bucket 私有和下载关闭，修复存储访问后重复 replay。
- 旧应用契约失败：禁止发布 migration；改为更兼容的 expand migration。
- migration transaction 失败：保留错误证据，修复 migration 后在新隔离库重演；禁止手改版本表。
- 恢复后 Provider 相关功能未验证：保持 managed generation 关闭；W06 必须另行授权。
