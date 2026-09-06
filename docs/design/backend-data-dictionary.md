# 后端数据字典与接口设计（首期）

- 状态：设计稿，D06 产物；实施依赖 D00 门禁。
- 依据：目标架构 §6–9、ADR 0001（D-1～D-4）、ADR 0002、提示词协议与来源说明。
- 命名：数据库 snake_case，API camelCase；ID 用 UUID/ULID；时间 UTC ISO-8601；分页 cursor。
- Schema 与示例：`docs/design/backend-schemas/`，由 `scripts/validate_design_schemas.py` 校验。

## 1. 实体与字段

### 1.1 subject（身份主体）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | 内部主体 ID |
| issuer | text | not null | OIDC issuer |
| subject_claim | text | not null | OIDC sub |
| role | text | not null, check in ('guest','member','admin') | 角色 |
| created_at / disabled_at | timestamptz | | |

- 唯一约束：`(issuer, subject_claim)`。
- 索引：PK。
- 说明：游客不落库，仅目录只读；admin 无默认图片读取权（ADR 0001 D-4）。

### 1.2 session（服务端 opaque 会话）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | Cookie 只存 opaque token 哈希 |
| subject_id | uuid | FK → subject.id | |
| token_sha256 | text | unique, not null | 不存明文 token |
| expires_at / revoked_at / rotated_from | timestamptz / uuid | | 过期、撤销、轮换 |

- 索引：`(subject_id)`、`(expires_at)`（清理）。
- CSRF：非 GET 请求要求同源 + 自定义头校验（B03）。

### 1.3 catalog_release（不可变目录发布）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| schema_version | text | not null | 对应 templates.json schemaVersion |
| source_sha256 | text | not null | 源档哈希（当前 ca672924…b4d8d） |
| library_sha256 | text | unique, not null | 整库哈希，重复导入幂等（B02） |
| template_count | int | not null | 当前 576 |
| imported_at | timestamptz | not null | |

### 1.4 template_version（不可变模板版本）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| catalog_release_id | uuid | FK → catalog_release.id | |
| template_key | text | not null | case-532 / framework-001 |
| version | int | not null | 单调递增 |
| compiled_prompt_sha256 | text | not null | 编译提示词哈希 |
| blueprint_sha256 | text | not null | |
| 元数据 | jsonb | not null | title/category/styles/blueprintInputMode 等 |

- 唯一约束：`(template_key, version)`、`(template_key, compiled_prompt_sha256)`。
- 索引：`(catalog_release_id)`。
- 说明：API 不接受浏览器正文替换；预审改词必须走维护流程产生新 version（M05）。

### 1.5 media_object（私有对象存储登记）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | API 称 sourceObjectId / resultObjectId |
| owner_id | uuid | FK → subject.id | 对象级授权锚点 |
| kind | text | check in ('input','result') | |
| state | text | check in ('quarantine','ready','rejected','expired','deleted') | 隔离区状态机 |
| bucket / object_key | text | not null | 服务器生成，拒绝客户端伪造路径 |
| mime / bytes / width / height | text / bigint / int | | 解码后实测值 |
| sha256 | text | not null | 内容哈希 |
| expires_at | timestamptz | not null | 保留策略见 §3 |

- 唯一约束：`(bucket, object_key)`；索引：`(owner_id, kind)`、`(state, expires_at)`。

### 1.6 upload（上传会话）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| media_object_id | uuid | FK → media_object.id, unique | 一上传一对象 |
| declared_bytes / declared_mime | bigint / text | not null | 预校验声明值 |
| confirmed_at | timestamptz | | 完成确认后置位 |

- 说明：未确认或 quarantine 对象不可用于生图（M01）。

### 1.7 precheck（提交前预审）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| subject_id / media_object_id | uuid | FK | |
| template_version_id | uuid | FK → template_version.id | |
| settings | jsonb | not null | 比例/质量等请求参数 |
| result | text | check in ('passed','failed') | |
| error_code / error_detail | text | | 失败原因（M04） |
| expires_at | timestamptz | not null | 过期预审不可用 |

- 索引：`(subject_id, created_at)`。
- 说明：校验模板/版本/单图/参数/协议/Provider 能力；需要改词时 failed 并阻断（M05）。

### 1.8 generation（生图任务）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| owner_id | uuid | FK → subject.id | |
| template_version_id | uuid | FK → template_version.id | 旧任务锁定原版本 |
| catalog_release_id | uuid | FK → catalog_release.id | |
| precheck_id | uuid | FK → precheck.id | 不可绕过预审 |
| input_object_id / input_sha256 | uuid / text | FK → media_object.id | |
| compiled_prompt_sha256 / effective_prompt_sha256 | text | not null | 默认相等（§7 目标架构） |
| provider_id / model | text | not null | allowlist 内 |
| settings | jsonb | not null | |
| idempotency_key | text | not null | |
| state | text | check in ('created','queued','running','succeeded','failed','cancelled','expired','outcome_unknown') | ADR 0001 D-2 |
| error_code | text | | 稳定错误码，见 §5 |
| created_at / updated_at / completed_at | timestamptz | | |

- 唯一约束：`(owner_id, idempotency_key)`（J01）。
- 索引：`(owner_id, created_at desc)`（工作区分页）、`(state)`（运营查询）。

### 1.9 attempt（真实发送追溯）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| generation_id | uuid | FK → generation.id | |
| attempt_no | int | not null | |
| sent_prompt_sha256 | text | not null | 捕获上游请求字节比对（J05） |
| provider_request_id | text | | 对账依据（J06） |
| state | text | check in ('sent','accepted','succeeded','failed','unknown') | |
| error_code / http_status | text / int | | |
| started_at / finished_at | timestamptz | | |

- 唯一约束：`(generation_id, attempt_no)`；索引：`(provider_request_id)`。

### 1.10 result（结果登记）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| generation_id | uuid | FK → generation.id, unique | 一任务一结果 |
| attempt_id | uuid | FK → attempt.id | |
| media_object_id | uuid | FK → media_object.id | kind='result' |
| actual_mime / actual_bytes / actual_width / actual_height | | | 实测值，与请求参数分开记录 |

### 1.11 job（PG 任务队列，首期即队列——ADR 0001 D-3）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| generation_id | uuid | FK → generation.id | |
| kind | text | not null | generate/cleanup 等 |
| state | text | check in ('pending','leased','done','dead') | |
| lease_owner / lease_expires_at | text / timestamptz | | 租约 |
| heartbeat_at | timestamptz | | |
| attempts / max_attempts | int | | 有界重试（J07） |
| run_after | timestamptz | not null | 退避 |
| dead_reason | text | | 死信原因 |

- 领取：`UPDATE … SET state='leased' … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`，CAS 防双 Worker（J03）。
- 索引：`(state, run_after)`、`(lease_expires_at)`（过期回收）。
- generation 与 job 同事务写入（J2）。

### 1.12 quota_ledger（配额账本）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| subject_id | uuid | FK → subject.id | |
| generation_id | uuid | FK → generation.id | 预留/释放幂等锚 |
| delta | int | not null | 预留 -1，释放 +1 |
| reason | text | not null | reserve/release/refund |
| created_at | timestamptz | | |

- 唯一约束：`(generation_id, reason)`——同一任务同一动作只记账一次（B05）。
- 未知付费结果不自动释放（B05/J06）。

### 1.13 collection / collection_item（集合与收藏）

| collection 字段 | 类型 | 约束 |
|---|---|---|
| id / owner_id / name / created_at | uuid / uuid FK / text / timestamptz | unique `(owner_id, name)` |

| collection_item 字段 | 类型 | 约束 |
|---|---|---|
| collection_id / item_type / item_key / added_at | FK / check in ('template','generation') / text / timestamptz | PK `(collection_id, item_type, item_key)`——重复收藏幂等（W03） |

### 1.14 audit_event（脱敏安全事件）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id / actor_id / action / object_type / object_id / created_at | | | 不含密钥、提示词正文、图片 URL |
| detail | jsonb | | 仅低基数字段 |

### 1.15 deletion_manifest（删除清单，备份用）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id / media_object_id / deleted_at / reason | | | 支撑恢复演练与备份删除（O01/O07） |

## 2. 接口设计（首期 API，/api/v1）

目录接口首期不实现（ADR 0001 D-1）。信封：成功 `{ data, meta }`，错误 `{ error: { code, message, details }, correlationId }`。

| 方法/路径 | 请求要点 | 响应要点 |
|---|---|---|
| POST /uploads | declaredBytes、declaredMime | 201：uploadId、签名上传目标（短期）、限制值 |
| POST /uploads/{id}/confirm | — | 200：objectId、实测 mime/bytes/宽高/sha256；魔数/解码失败 422 |
| POST /prechecks | templateKey、version、objectId、settings | 201：precheckId、passed/failed + errorCode |
| POST /generations | templateId、templateVersion、promptSha256、sourceObjectId、settings + Idempotency-Key 头 | 202：generationId、state=queued；同 key 同请求返回原任务，不同请求 409 |
| GET /generations/{id} | — | 200：state、result 元数据（含实际尺寸/hash）、attempt 摘要 |
| POST /generations/{id}/cancel | — | 200/202：如实返回排队已取消或运行中已请求取消 |
| GET /collections、POST /collections、POST /collections/{id}/items | cursor 分页 | 幂等收藏 |
| GET /exports/workspace | — | 200：收藏/集合/历史导出（不含密钥） |
| GET /health/live、/health/ready | — | 不触发付费探测 |

Schema 与示例见 `docs/design/backend-schemas/`。

## 3. 保留与删除策略

默认值为待产品确认的建议（目标架构 §9）：未完成上传 1 小时；输入媒体终态后 24 小时；结果媒体 7 天；任务与提示词快照 30 天；脱敏安全事件 90 天。到期 `media_object.state → expired`，generation 终态 succeeded → expired 由清理流程转移（ADR 0001 D-2），历史成功事实（attempt/result 元数据）保留至任务保留期结束。用户删除与导出遵循同一授权矩阵；删除写入 deletion_manifest。

## 4. 权限矩阵

| 资源 | 游客 | 成员 | 管理员 |
|---|---|---|---|
| 目录（静态） | 读 | 读 | 读 |
| 本人 upload/media/generation/collection | — | 读写本人 | 元数据可见，图片默认不可读 |
| 他人资源 | — | 拒绝（404） | 拒绝默认读图，审计内可见元数据 |
| 配额/限流配置 | — | 读本人用量 | 管理 |
| 维护流程（模板新版本） | — | — | 专用维护角色 |

## 5. 稳定错误码（首版）

`VALIDATION_FAILED`、`UNSUPPORTED_MEDIA_TYPE`、`PAYLOAD_TOO_LARGE`、`PIXEL_LIMIT_EXCEEDED`、`QUARANTINE_NOT_READY`、`FORGED_OBJECT_PATH`、`TEMPLATE_VERSION_MISMATCH`、`PROMPT_REWRITE_BLOCKED`、`PRECHECK_FAILED`、`PRECHECK_EXPIRED`、`QUOTA_EXCEEDED`、`RATE_LIMITED`、`IDEMPOTENCY_CONFLICT`、`GENERATION_STATE_ILLEGAL`、`CANCEL_NOT_GUARANTEED`、`MEDIA_EXPIRED`、`FORBIDDEN`、`UNAUTHENTICATED`、`PROVIDER_REJECTED`、`PROVIDER_TIMEOUT_UNKNOWN`、`INTERNAL`。错误码稳定，前端不得字符串匹配 message。
