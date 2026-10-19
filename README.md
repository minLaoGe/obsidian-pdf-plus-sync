# PDF++ Sync

**在 Obsidian 中阅读、标注 PDF，并在不同设备间接着上次的位置继续阅读。**

PDF++ Sync 是由 [minLaoGe](https://github.com/minLaoGe) 独立维护的二次开发项目，基于 [Ryota Ushio 的 PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus) **0.40.31** 开发。保留原有 PDF 标注、摘录和笔记联动能力，在此基础上增加通过笔记库同步的阅读进度。

本仓库独立发布与迭代，不是原作者的官方版本。原项目及其贡献者为本项目提供了核心代码与设计，感谢他们的工作。原始介绍保存在 [README.upstream.md](README.upstream.md)。

> **当前为开发验证阶段。** 已通过编译、生产构建和模拟跨客户端测试；真实 Obsidian 桌面端、iOS、Android 的完整联调尚未完成。欢迎通过 Issues 提交验证结果。

## 能做什么

| 能力 | 说明 | 来源 |
| --- | --- | --- |
| PDF 阅读增强 | 在 Obsidian 内置阅读器上增强使用体验 | 上游 PDF++ |
| 标注与笔记引用 | 将 PDF 内容与 Markdown 笔记、反向链接关联 | 上游 PDF++ |
| 阅读位置记录 | 保存页码、页内位置及缩放比例 | 本项目新增 |
| 跨设备续读 | 同步进度文件后，重新打开 PDF 恢复位置 | 本项目新增 |
| 独立设备记录 | 各设备写入不同文件，减少同一文件的写入冲突 | 本项目新增 |
| 链接优先 | 显式页码、选区等链接优先于续读位置 | 本项目新增 |

**不需要另外安装 PDF++。** 本项目包含其代码，是对原插件的替换版本。

## 安装

目前采用手动安装，未以独立插件身份上架 Obsidian 社区插件市场。

1. 下载 [Releases](https://github.com/minLaoGe/obsidian-pdf-plus-sync/releases) 中的 `main.js`、`manifest.json`、`styles.css`，或下载 ZIP 后解压。
2. 关闭 Obsidian，或先停用现有 PDF++。
3. 如果已经安装 PDF++，备份笔记库内的 `.obsidian/plugins/pdf-plus/`。
4. 将上述三个文件放入 `.obsidian/plugins/pdf-plus/`，保留已有的 `data.json`。
5. 重启 Obsidian，在「设置 → 第三方插件」中启用 **PDF++ Sync**。
6. 在插件设置顶部确认「跨设备 PDF 阅读进度」开启，默认已开启。

桌面端与移动端都需要安装同一版本。iOS、Android 的插件目录访问方式取决于你的笔记库与同步工具配置。

### 从 PDF++ 迁移

当前沿用 `pdf-plus` 插件 ID，以便读取已有设置，安装目录也沿用 `pdf-plus`。因此：

- 这是原 PDF++ 的替换版本，不能作为两个插件同时启用。
- 不需要删除旧设置或重新导入 PDF。
- 从社区市场更新原 PDF++ 可能覆盖本项目的文件。
- 回退时停用本版本，将备份的插件文件放回即可。阅读进度目录不会修改原 PDF。

## 如何跨设备接着读

插件负责记录与恢复；**文件传输由你现有的笔记库同步工具负责**，本项目不提供账号或云同步服务。

```text
设备 A 阅读 PDF
    ↓ 保存进度
笔记库 / PDF++ Reading Progress / *.json
    ↓ 你的同步工具
设备 B 收到 PDF 和进度文件
    ↓ 重新打开 PDF
恢复最近一次已同步的位置
```

在所有设备上：

1. 使用同一个笔记库，保持 PDF 的库内相对路径一致。
2. 安装并启用此版本。
3. 让同步工具包含 **PDF 文件**及库根目录的 **`PDF++ Reading Progress/`**。
4. 确认同步规则没有排除 JSON 文件。

例如，电脑读到第 20 页后，停止滚动约一秒，等待同步完成；手机完成同步后重新打开同一 PDF，即可恢复。手机回翻到第 5 页继续阅读，新的记录也可以作为下一次续读位置，而不是永远选最大的页码。

不同同步工具是否同步 JSON、是否启用了附件同步、文件大小是否超过限制，需要在各自设置中确认。**仅同步插件配置，不能替代同步阅读进度目录。**

## 记录与恢复规则

- 保存范围：普通 PDF 标签页；不记录 Markdown 内嵌 PDF 或悬浮预览。
- 写入条件：阅读器聚焦且发生滚轮、触摸、指针或键盘操作。仅打开文件不会主动写入新进度。
- 保存时机：位置变化停止约 700 毫秒后；进入后台或关闭时也尝试保存。
- 保存内容：PDF 的库内路径、页码、页内 PDF 坐标、缩放、设备 ID 与版本时间。
- 存储方式：普通库内 JSON 文件；每个设备为每份 PDF 写自己的文件。
- 设备标识：保存在客户端本地存储中，不放入同步的插件设置；本地存储不可用时使用临时会话 ID。
- 冲突选择：优先选择版本时间较新的记录，相同时按设备 ID 确定顺序。
- 自动恢复：正常重新打开 PDF 时恢复；明确指定目标位置的链接优先。
- 远端变化：阅读中不会突然被另一台设备的进度拉走，重新打开时才读取。
- 损坏数据：无法解析或未通过校验的记录会被忽略，不阻止 PDF 打开。

## 已知限制

- **实机兼容性仍待验证。** 使用跨平台 Obsidian API 实现，并不意味着所有客户端均已验证通过。
- 离线阅读需要等进度文件同步后，另一端才能续读；不是实时协同。
- 多端同时离线阅读时，无法准确知道未同步设备的真实操作先后。建议开启系统自动校时，避免同时操作同一 PDF。
- PDF 以库内路径识别，移动或重命名后不会自动迁移旧进度。
- PDF 页数发生变化后，超出范围的旧位置不会恢复。
- 手机系统强制结束应用前，尚未写入的最后不足一秒进度可能丢失。
- 依赖 Obsidian 的私有 PDF.js 接口；Obsidian 升级后可能需要适配。
- 进度文件包含 PDF 文件路径；同步该目录时，这些元数据也会传输到你选择的同步服务。

## 本地开发

使用 **Node.js 22.13+** 和 npm。本仓库保留上游代码历史，新增同步逻辑集中在 `src/reading-progress.ts`。

```bash
git clone https://github.com/minLaoGe/obsidian-pdf-plus-sync.git
cd obsidian-pdf-plus-sync
npm ci --ignore-scripts
npm test
npm run build
```

`--ignore-scripts` 用于避免开发依赖下载 Electron 运行时；插件构建由后续 `npm run build` 显式执行。npm 使用 `package-lock.json` 固定依赖。

开发时执行 `npm run dev` 开启构建监听。将生成的 `main.js` 与 `manifest.json`、`styles.css` 复制到测试库的 `.obsidian/plugins/pdf-plus/`，重新加载插件。先在测试库开发，避免直接修改日常笔记库。

| 文件 | 用途 |
| --- | --- |
| `src/reading-progress.ts` | 进度校验、读取、记录与恢复 |
| `src/patchers/pdf-internals.ts` | 在 PDF 加载后挂接进度功能 |
| `src/patchers/pdf-view.ts` | 处理视图恢复与进度优先级 |
| `src/settings.ts` | 阅读进度开关 |
| `tests/reading-progress.mjs` | 模拟客户端与共享库的回归测试 |
| `READING-SYNC.zh-CN.md` | 安装与测试说明 |

### 验证范围

自动化测试覆盖记录校验、确定性排序、被动加载不写入、进度保存、第二客户端恢复、回翻续读、设备独立文件、显式链接优先和损坏记录处理。测试使用模拟的 Obsidian 环境，不替代实机测试。

建议每次修改后验证：

- 电脑第 20 页 → 同步 → 手机恢复。
- 手机回翻到第 5 页 → 同步 → 电脑恢复。
- 点击指向第 12 页的链接，确认跳到第 12 页。
- 不操作的后台标签页不会覆盖新进度。
- 退出应用、重新启动、横竖屏切换后检查位置。

## 后续方向

以下为待开发方向，不代表已实现：

- 完善桌面端、iOS、Android 的兼容性与实机回归。
- 文件移动、重命名后的进度迁移。
- 同步状态提示、进度查看与清理。
- 并发离线阅读的冲突处理体验。
- 评估独立插件 ID 与设置迁移方案。

欢迎通过 [Issues](https://github.com/minLaoGe/obsidian-pdf-plus-sync/issues) 提交问题、测试结果和需求。报告问题时请提供 Obsidian 版本、设备系统、同步方式及最小复现步骤，不必上传私人 PDF。

## 来源与许可

- 上游项目：[RyotaUshio/obsidian-pdf-plus](https://github.com/RyotaUshio/obsidian-pdf-plus)
- 基线版本：`0.40.31`，提交 `6a3218b`。
- 本项目维护者：[minLaoGe](https://github.com/minLaoGe)。
- 许可证：[MIT](LICENSE)，保留 Ryota Ushio 的原始版权声明，并为本项目新增代码注明版权。
- 第三方许可：[THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES)。

上游功能与使用文档可参考 [PDF++ 文档](https://ryotaushio.github.io/obsidian-pdf-plus/)，本项目新增功能以本仓库说明为准。
