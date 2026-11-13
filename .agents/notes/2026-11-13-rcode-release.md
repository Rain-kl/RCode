# RCode 独立仓库与版本发布

用户决定新建公开的 Rain-kl/RCode 独立仓库，发布 v3.20.171；旧版用户手动安装一次迁移。origin 改为新仓库，原仓库保留为 legacy，代码上游仍为 upstream。保留源码提交历史和版权归属，后续包、更新索引及 Server 归档均由 RCode 发布。

应用标识与 Android 签名延续。仓库迁移会重置 github.run_number，原版本码算法因此会造成覆盖升级降级；版本解析统一输出由 major/minor/patch 生成的正版本码，Android job 消费同一个 resolve 输出。

Android 四项签名 secrets 从本机已有备份配置到新仓库，值经 stdin 传入；本次提交只包含公开仓库路径与版本。代码和发布契约沿用现有测试，发布完成后核对版本、校验和、更新元数据及 APK 签名。
