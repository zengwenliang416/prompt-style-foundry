# O04 本地容量测量报告

> 本报告是隔离本机、临时 PostgreSQL 16、loopback HTTP 和本地磁盘的可复跑实测，不是生产 SLA，也没有调用任何真实或外部生图 Provider。可部署 Worker 的 claim/execute 路径使用隔离 loopback simulator；规划预算与实测事实分开列示，不能直接外推为生产容量。

- 测量时间：2026-09-08T04:14:22.461Z
- 工作区：41254dd + dirty
- Node / Sharp / libvips：v22.19.0 / 0.35.4 / 8.18.6
- 主机：darwin arm64，8 CPU / 16 GiB RAM（Apple M1 Pro）
- PostgreSQL：postgres (PostgreSQL) 16.11 (Homebrew)；max_connections=100；shared_buffers=128MB

## 1. 实测事实

### 非生图 API（真实 loopback HTTP）

| 路由                             | 请求数 | 并发 |      p95 |      p99 |          吞吐 |
| -------------------------------- | -----: | ---: | -------: | -------: | ------------: |
| GET /api/v1/health/live          |    400 |   20 | 11.43 ms | 26.14 ms | 3679.23 req/s |
| POST /api/v1/collections         |    160 |    8 |   8.1 ms | 15.89 ms | 1613.47 req/s |
| GET /api/v1/collections?limit=50 |    400 |   20 | 12.39 ms | 13.39 ms | 2002.73 req/s |
| GET /api/v1/health/ready         |    120 |    8 | 12.86 ms | 13.65 ms |  857.33 req/s |

collections 读写真实经过 TCP/HTTP、Fastify schema、opaque session 查库和 PostgreSQL；readiness 只探测 PG，不探测或调用付费 Provider。全部状态分布见 JSON。

### PG 队列与 Worker

- 任务：320 个真实 PG job；执行管线 harness：8 个独立 PoolClient；实测最大同时活跃：8。
- 队列 claim p95：0.71 ms；排队等待 p95：208.11 ms；complete p95：1.68 ms。
- 吞吐：1559.13 jobs/s；重复领取：0；done/succeeded：320/320。
- 当前可部署 Worker 进程探针：136.99 ms 内 claim=1，隔离 loopback simulator 请求=1，实测生成并发=at-least-one。可部署 Worker 进程经真实 PG claim/execute/complete、真实本地存储和隔离 loopback Provider simulator 完成 1 个任务；这不是 W06 真实 Provider 验证。
- 真实/外部 Provider 调用：0。320-job harness 只测真实 PG claim/complete 与并发执行壳；进程探针的本地 simulator 只验证接线，二者都不冒充 W06 真实 Provider 兼容或生成容量。

### PostgreSQL 连接

- collections 工作负载峰值：11。
- readiness 阶段峰值：16。
- 队列阶段峰值（含观测连接）：9；Worker harness pool max=8。
- 全阶段实测峰值：16。

### 图像解码内存与磁盘

- 样本：4096×4096 JPEG（16,777,216 px），压缩输入 0.09 MiB；8 次、并发 2。
- 当前产品校验路径（metadata + 限制检查）p95：5.29 ms；诊断性强制完整像素栅格解码 p95：67.63 ms。两者不混称。
- 子进程 RSS 基线/峰值/增量：87.14 / 324.08 / 236.94 MiB。
- 隔离 TMPDIR 临时磁盘峰值/结束值：0 / 0 MiB。

## 2. 推导的本机回归预算

这些阈值用于发现明显回归，不是生产 SLO：workspace 读写 p95 < 500 ms；queue claim/complete p95 < 100 ms；排队等待 p95 < 2000 ms；队列吞吐 >= 50 jobs/s；harness 达到并发 8；PG 连接峰值 <= 20；完整解码 p95 < 2000 ms；RSS 增量 < 512 MiB；临时磁盘峰值 < 16 MiB；真实/外部 Provider 调用必须为 0。

- PASS — `liveApiP95Under100Ms`
- PASS — `workspaceReadP95Under500Ms`
- PASS — `workspaceWriteP95Under500Ms`
- PASS — `readyApiP95Under500Ms`
- PASS — `queueClaimP95Under100Ms`
- PASS — `queueCompletionP95Under100Ms`
- PASS — `queueWaitP95Under2000Ms`
- PASS — `queueThroughputAtLeast50PerSecond`
- PASS — `workerConcurrencyReachedConfiguredLevel`
- PASS — `pgConnectionsWithin20`
- PASS — `decodeP95Under2000Ms`
- PASS — `decodePeakRssDeltaUnder512MiB`
- PASS — `decodeScratchPeakUnder16MiB`
- PASS — `noExternalProviderCalls`

## 3. 未测范围与限制

- O04 不测真实 Provider 延迟、限流、结果和计费行为；W06 已另以单次授权完成最小真实兼容验证，不能外推为容量；
- S3-compatible 存储、TLS/反向代理、生产 PG 参数、多实例；
- 可部署 Worker 进程仅以 1 个任务证明 claim/execute/complete 接线；未测进程级多 slot 生图吞吐或 Provider 容量；
- 当前 `validateImage` 产品路径使用 metadata 读取；完整栅格解码是独立诊断探针；
- 结果只说明本机、当前样本和并发，不能把 20 MiB/40 MP 上限当成已证明的生产容量。

原始机器可读证据：[capacity-report.json](capacity-report.json)。
