# 局部编辑与全文覆盖使用各自的冲突语义

局部 Edit 的整文件 freshness 门禁位于目标匹配之前，导致其他位置变化也报 STALE_FILE。改为保留已读资格检查，使用现有当前内容匹配器决定目标缺失和歧义，写回继续携带执行时 revision。

Read 保存版本时优先取 stat.revision；真实 stat 返回的 revision 不含 hash，遮蔽了范围读取的完整字节哈希。原测试手工构造带 hash 的状态，绕过真实 Read，未覆盖此断点。现在版本和大小优先来自真实读取，新增证据直接驱动真实 adapter 与 Read/Write。

Read 去重先读取当前内容版本再决定返回存根，避免相同 mtime/size 隐藏内容变化，让 stale Write 能通过重新 Read 正常恢复。只返回存根时仍不写 live 状态和快照，维持 compact/resume 的模型可见视图不变量。

快照增加可选 contentHash，schemaVersion 保持 1：现有解析器按字段读取并忽略未知字段，旧版可读；新版本缺字段沿用旧判据。hydrator 只恢复历史哈希，不从当前磁盘补造已读基线。

防回归重点是局部 Edit 保留无关修改、目标缺失与歧义明确拒绝、Write 阻止同时间戳同大小的覆盖，以及重读与恢复后的版本一致性。

验证：针对性回归 11/11，默认契约 90 项通过，Write 严格契约 18/18，compact 恢复 10/10；根与 CLI 类型检查、架构和移除守卫通过。CLI lint 的两项 max-lines 错误来自未改动的 adapter/bootstrap 文件；额外开启 Read 严格契约的两项失败用原始 HEAD 临时副本重现，副本已清理。
