# 本地容量压测与预算操作说明

## 目的与边界

本操作用于复跑开发清单 O04 的隔离本地容量测量，覆盖：

- 非生图 HTTP API 的延迟与吞吐；
- PostgreSQL job 队列的 claim/complete 延迟与吞吐；
- 多 Worker 并发领取的重复执行保护；
- PostgreSQL 客户端连接峰值；
- 大图校验与完整像素解码的延迟、RSS 增量和临时磁盘使用。

它不是生产 SLA、容量承诺或真实 Provider 兼容验证。脚本不会调用真实或外部生图 Provider，不需要真实 Provider key，不连接远程数据库，也不写入 `public/`。可部署 Worker 接线探针会调用一次仅监听 loopback 的本地 simulator；W06 仍必须在用户明确批准付费调用后单独验证。

## 前置条件

- Node.js 22（项目最低要求为 Node.js 20）；
- 已执行 `npm ci`；
- 本机 PostgreSQL 16 命令行工具。默认路径为 `/opt/homebrew/opt/postgresql@16/bin`，其他位置通过 `ONEPIC_PG_BIN` 指定；
- 至少约 1 GiB 可用内存。脚本以并发 2 完整解码 4096×4096 JPEG，当前本机预算将 RSS 增量限制在 512 MiB 内。

示例：

```bash
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
export ONEPIC_PG_BIN="/opt/homebrew/opt/postgresql@16/bin"
npm run benchmark:capacity
```

## 隔离与清理

脚本 `scripts/benchmark-capacity.mjs` 会：

1. 构建全部 npm workspace；
2. 在系统临时目录启动只监听 `127.0.0.1` 随机端口的临时 PostgreSQL 集群；
3. 创建临时数据库并执行当前 migrations；
4. 在 loopback 随机端口启动 API，压测 health 基线以及带真实 opaque session/PG 访问的 collections 读写；
5. 写入 1 个可执行测试 job，由当前可部署 Worker 进程经真实 PG、真实本地存储和 loopback simulator 完成；再写入 320 个独立测试 job，以 8 个 PG PoolClient 并发 claim/complete 执行管线；
6. 从 `pg_stat_activity` 采样 API、readiness 与队列阶段连接峰值；
7. 在独立子进程和隔离 `TMPDIR` 中分别测量当前 metadata 校验路径与诊断性完整像素解码；
8. 无论成功或失败，关闭 API/Worker/PG 并删除临时数据库、媒体目录和解码样本。

可部署进程探针必须恰好产生 1 次 loopback simulator 请求并完成 job；真实/外部 Provider 调用计数必须为 0。任何偏差都会使命令失败。

## 输出与判定

每次成功运行会覆盖以下可复查证据：

- `docs/design/evidence/o04/capacity-report.json`：机器可读环境、参数、原始汇总值与断言；
- `docs/design/evidence/o04/capacity-report.md`：人类可读报告。

当前本机回归预算：

| 指标 | 门禁 |
|---|---:|
| live API p95 | < 100 ms |
| collections 读/写 API p95 | 各 < 500 ms |
| ready API p95 | < 500 ms |
| queue claim / complete p95 | 各 < 100 ms |
| queue 排队等待 p95 | < 2000 ms |
| queue 吞吐 | >= 50 jobs/s |
| Worker 并发 | 实测达到配置的 8 |
| PG 客户端连接峰值 | <= 20 |
| 4096×4096 完整解码 p95 | < 2000 ms |
| 解码 RSS 增量 | < 512 MiB |
| 隔离临时磁盘峰值 | < 16 MiB |
| 真实/外部 Provider 调用 | 0 |

预算有意保留明显余量以减少开发机瞬时抖动，但只约束当前脚本、样本、并发和本地环境。不能把这些数值外推为生产实例规模，也不能把输入上限 20 MiB/40 MP 当成已经证明的生产容量。

当前 O04 报告还必须如实列出两个边界：可部署 Worker 进程只以 1 个任务验证 claim/execute/complete 接线，不能把 8-client harness 冒充进程生图并发或真实 Provider 容量；`validateImage` 当前使用 metadata 读取，完整像素栅格解码数据来自独立诊断探针。实现或依赖改变后必须复跑，不能被报告文字隐藏。

命令退出码非 0 时不得更新 O04 为通过。先查看控制台中的失败断言和 JSON 报告；如果脚本在写报告前失败，检查 PostgreSQL 路径、端口权限、可用内存和 workspace 构建。

## 变更后的复跑要求

以下改动至少应复跑本项：

- health/readiness 路由、Fastify 插件或日志配置；
- PG pool 大小、job 索引、claim/lease/complete SQL；
- Worker 并发模型；
- `validateImage`、sharp 版本、输入像素/字节上限；
- 本地存储或临时文件策略。

如果回归超过预算，不能仅放宽阈值。应先确认环境差异并保存新旧报告；确需调整预算时，在开发清单记录测量依据、风险和审阅结论。
