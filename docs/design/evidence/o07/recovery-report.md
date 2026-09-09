# O07 迁移、备份、恢复与回滚演练证据

## 结论

O07 隔离演练通过。脚本在本机临时 PostgreSQL 16、临时 LocalDiskStorage 和 loopback HTTP server 中完成 v3/v5 两轮 backup/restore、expand migration、删除清单 CLI 重放、上一已跟踪静态前端、恢复库 API health 与应用回滚兼容探针；退出后 PostgreSQL/data/object/frontend 临时目录均删除。没有连接生产、没有执行生产 migration/部署、没有调用 Provider。

机器证据：`recovery-report.json`。操作步骤：`../../operations/recovery-runbook.md`。

## 实现

- `scripts/rehearse-recovery.mjs`
  - 创建并清理真实临时 PostgreSQL 16 cluster。
  - v3 旧 schema 写入带外键的 subject/catalog/template/media/precheck/generation/deletion manifest 数据。
  - 使用真实 `pg_dump --format=custom`、`pg_restore --exit-on-error`，比较 source/restore 的 schema versions、行数和旧列投影。
  - v3→v5 migration 后运行上一应用契约：旧 SELECT 投影可读，不包含 `prompt_text`/`cancel_requested_at` 的旧 INSERT 可写。
  - 再次备份 v5 并恢复至灾难恢复库，校验 source=restore。
  - 校验 `ONEPIC_PREVIOUS_RELEASE_REF`（默认 `HEAD^`）并解析为 commit，从该 revision 的 `git archive <revision> public` 启动上一静态前端，读取首页、576 项 catalog 和 `case-532` prompt。
  - 恢复库 API `/api/v1/health/live` 与 `/ready` 均 200。
  - 扫描 migration SQL，当前五个文件无 `DROP`/`TRUNCATE`。
- `apps/worker/src/replay-deletions.ts`
  - 仅遍历 `deletion_manifest` 且 media state 已为 `deleted` 的对象。
  - 默认 dry-run，显式 `apply`，UUID cursor 分批 1–5000，单对象失败继续并报告，可安全重复。
- `apps/worker/src/replay-deletions-cli.ts`
  - 默认 dry-run；只有 `--apply` 删除；结构化脱敏日志只输出计数，不输出 bucket/key、数据库 URL 或对象内容。
- `apps/worker/src/replay-deletions.test.ts`
  - 覆盖 dry-run、分页、apply、失败继续和非法 batch size。
- `docs/operations/recovery-runbook.md`
  - 记录生产授权、备份一致性、checksum、恢复、删除清单 dry/apply、expand/contract、应用回滚不回滚 SQL、失败处理与放量门禁。
- `scripts/ci-verify.sh`
  - 完整 integration 后直接运行 built recovery rehearsal，报告写 runner temp 并由 trap 删除；失败会阻断后续 E2E/发布。

## 实测命令与结果

```bash
ONEPIC_PG_BIN=/opt/homebrew/opt/postgresql@16/bin \
ONEPIC_RECOVERY_REPORT=docs/design/evidence/o07/recovery-report.json \
npm run rehearse:recovery
```

退出码 `0`，事件 `recovery_rehearsal_passed`，总耗时 `5112 ms`。

### Backup / restore

| 备份 | schema | bytes | SHA256 | 恢复结果 |
|---|---|---:|---|---|
| 兼容升级起点 | v1–v3 | 42435 | `d0f074174ff36a1c87a14d47df87634fe5af0fd4bd9eb597b084eeabc2687640` | source snapshot = restore snapshot |
| 最新灾备 | v1–v5 | 42664 | `5d44f6f20414aec09a88bece39fe1b2ac2b8a9cea4ca493b9b9e9f0c3a00ffd6` | source snapshot = restore snapshot |

这些 dump 在演练结束时随临时目录删除；表中 hash 只证明本次演练实际生成并校验了非空备份，不是可用于生产恢复的持久备份。

### Migration 与回滚

- upgrade 前 `schema_migrations=[1,2,3]`，upgrade 后 `[1,2,3,4,5]`。
- migration 文件：`0001_identity_and_catalog.sql`、`0002_generation.sql`、`0003_workspace_and_audit.sql`、`0004_prompt_snapshot.sql`、`0005_cancel.sql`。
- `destructiveSqlFiles=[]`，当前 migration 为 expand-only。
- 上一应用旧列 projection 可读；忽略新 nullable 列的 INSERT 成功，generation 从 1 增至 2。
- “应用回滚”探针不恢复旧数据库、不运行 down SQL；探针后 schema versions 仍为 `[1,2,3,4,5]`。

### 删除清单重放

实际执行 built Worker CLI：

1. dry-run：`scanned=1`、`removalAttempts=0`、`failures=0`，恢复出来的 5 字节对象仍存在。
2. `--apply`：`scanned=1`、`removalAttempts=1`、`failures=0`，对象已不存在。
3. 再次 `--apply`：`scanned=1`、`removalAttempts=1`、`failures=0`，证明幂等删除可重复。

### 兼容与健康

- 上一静态前端请求 ref：`HEAD^`（默认值）；解析 revision：`b6a293943ca73abb06fc3994e2f6fd971d617eaa`；archive 元数据在机器报告中同时记录 requested ref、来源和实际 commit。
- 首页、576 项 catalog、`case-532` prompt 均通过 loopback HTTP 实际读取。
- 当前 API 连接灾难恢复库：live 200、ready 200。
- Provider 调用：0。

### 清理

演练结束后检查 `${TMPDIR}` 与 `/tmp`，无 `onepic-recovery-*` 或 `onepic-pgtest-*` 残留目录。

## 回归

- Worker typecheck + test typecheck：通过。
- `replay-deletions.test.ts`：5/5 通过。
- 最终 `CI=true ONEPIC_PG_BIN=/opt/homebrew/opt/postgresql@16/bin bash scripts/ci-verify.sh`：退出码 0，Python 23、unit 41 files / 290 tests、integration 26/131、内嵌 recovery rehearsal、Chromium E2E 44 全部通过，输出 `Repository verification passed.`。

## 未覆盖与边界

- 本次对象恢复使用 phase-one LocalDiskStorage；未获授权连接真实 S3-compatible 服务。S3 adapter 接入后必须在私有隔离 bucket 重复相同演练，未做前不宣称生产对象恢复已验证。
- 小数据本机耗时不是生产 RTO/RPO；生产值只能来自获批的接近生产规模演练。
- 没有执行 commit、push、deploy、生产 migration 或真实/付费 Provider 调用；W06 仍未勾选。
