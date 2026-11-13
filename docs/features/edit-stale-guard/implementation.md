# 文件编辑与覆盖保护：落地与验收

设计见 [design.md](design.md)。

## 功能落点

| 范围 | 文件 | 职责 |
| --- | --- | --- |
| 局部编辑 | core/src/tool/handlers/edit.ts | 已读资格、当前片段匹配、写回版本与成功状态 |
| 全文覆盖 | core/src/tool/handlers/write.ts | 基于已读内容版本拒绝覆盖冲突 |
| 读取与去重 | core/src/tool/handlers/read.ts | 保存实际内容版本，变化后返回当前正文 |
| 读取状态快照 | core/src/tool/read-file-state-metadata.ts | 保存和解析可选内容哈希，兼容历史快照 |
| 会话恢复 | core/src/agent/read-file-state-hydrator.ts | 恢复历史内容版本 |
| 原始字节版本 | adapters/src/fs/index.ts、text-range-reader.ts | 提供整文件、范围、流式读取与写入的统一字节哈希 |

上述路径相对于 apps/zcode-cli/packages。产品接线使用 FORK(edit-stale-guard) 标记。

## 回归证据

既有 forkEditStaleGuard.test.ts 覆盖当前内容匹配、外部变化保留、歧义拒绝与 replace_all、截断视图限制、Write 内容保护；真实文件系统场景验证 Read 哈希、时间戳误报消除以及覆盖冲突后重新读取再写入。

read-file-state-hydrator.test.ts 覆盖新快照哈希恢复与历史快照兼容；Read/Edit/Write 契约套件验证工具调用与模型结果。

### 2026-11-13 验证结果

| 检查 | 结果 |
| --- | --- |
| 针对性文件编辑回归 | 11/11 通过，修复前 6 项失败 |
| Read/Edit/Write、恢复与快照顺序默认契约 | 6 个文件通过，90 项通过，20 项按默认开关跳过 |
| Write 严格契约 | 18/18 通过 |
| compact 文件恢复 | 10/10 通过 |
| 根与 CLI 类型检查 | 通过，CLI 34 个任务成功 |
| 根 Lint | 0 errors，85 warnings |
| CLI Lint | 2 个既有 max-lines 错误：adapters/src/fs/index.ts、bootstrap/src/zcode-protocol-v4/cold-event-merge.ts；72 warnings |
| 架构检查与移除守卫 | 通过 |

额外开启 Read 严格契约后，相对路径展示与 Notebook 类型两项失败；原始 HEAD 复跑同样失败。
