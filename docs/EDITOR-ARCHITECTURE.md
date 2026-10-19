# 页面文字编辑器：开源选型与性能

## 选型

本项目继续使用 Obsidian 已加载的 PDF.js 阅读器，不另起一个完整阅读器。

- [Mozilla PDF.js](https://github.com/mozilla/pdf.js)：Apache-2.0。现有阅读器的 `PDFPageProxy.getAnnotations()` 提供文字、位置和颜色；编辑入口复用已经加载的批注数据，不再在点击时读取并解析完整 PDF。没有将 Firefox 的整套编辑器直接复制到本项目。
- [Interact.js](https://github.com/taye/interact.js)：MIT，当前固定 1.10.27。实际打包集成，用于移动与宽度调整，包含鼠标与触摸手势识别。许可证见 `licenses/interactjs-MIT.txt`。
- [EmbedPDF](https://github.com/embedpdf/embed-pdf-viewer)：评估过其独立 PDF 引擎与批注系统。为了保留 PDF++ 的反向链接、高亮、原生 PDF 标签页及阅读进度接口，本次没有用它替换阅读内核。

这是一套浏览器风格的自有编辑交互，并非移植 Chrome 的 PDF 编辑器源码。项目原有 MIT 许可及第三方许可继续保留。

## 三层结构

1. **交互层**：原生 `contenteditable="plaintext-only"` 输入，保留浏览器光标、选区和撤销体验；双击才进入编辑，透明底色，文字框从一个字宽起步并随内容增长。浮动工具条提供字号、颜色、删除及完成操作。Interact.js 负责拖动和调整宽度。
2. **草稿层**：多个文字框修改暂存在本机内存与 Obsidian 客户端本地存储。点击空白或“完成”只结束当前输入，不重写 PDF。标题栏“保存更改”或 Ctrl/Cmd+S 才将当前文件所有修改写入 PDF。
3. **后台层**：打包在 main.js 中的 Blob Worker 使用现有 @cantoo/pdf-lib 一次解析、一批修改、一次导出。字形通过 OffscreenCanvas 生成显示外观；SHA-256 校验也在 Worker 中运行。PDF 字节使用 transferable ArrayBuffer 传递，避免主线程复制完整文档。

## 性能约束

- 点击文字框不得同步读取或解析 PDF。旧版文字的精确字号索引由后台异步补齐，不阻塞输入。
- 输入、改色、移动和缩放不得写入 PDF。
- 一批文字框应只解析、导出和写入一次。
- 保存前核对源文件摘要，冲突或后台处理失败时保留本机草稿。
- 保留首次文字修改前的 PDF 基线备份，不逐字复制整本 PDF。

## 验证

自动化测试覆盖零 I/O 草稿编辑、批量保存、批注索引缓存、重启恢复草稿、保存冲突、Worker 实际线程运行、ArrayBuffer 转移及摘要校验。

`PDF_SYNC_BENCHMARK_FILE=/absolute/path/to/test.pdf node tests/free-text-worker.mjs` 可以运行只读导出基准，原文件不会改写。该基准监测 Node 主事件循环，不等同于 Obsidian 浏览器输入延迟，也不包含云端同步耗时。

本机一次约 61 MiB PDF 测试：后台处理约 605 ms，主事件循环 10 ms 心跳执行 55 次，最大间隔约 11 ms。不同文件、设备和系统会有差异。

## 保存与兼容性

- 草稿只保留在当前 Obsidian 客户端，不跨设备同步；保存到 PDF 后才由笔记库同步工具传输。
- 云端传输、磁盘写入及 Obsidian 原生 PDF 重载仍有各自耗时。
- 页面旋转 0° 时开放编辑；现有标准 FreeText 及 0.41.0 生成的文字框可继续编辑。
- 需要 Web Worker 与 OffscreenCanvas。手机实机兼容性仍需验证；失败时不会丢弃草稿。

透明编辑旧批注时，使用已加载 PDF.js 页面重绘原批注所在的小区域（关闭批注渲染），保留页面原有图文背景，避免白色遮挡。正文选区复用上游几何计算，正文和框选高亮均暂存草稿，Worker 批量写入标准 Highlight；用户新增要求的这部分交互未做运行测试，由用户自行验证。

0.44.0 将 Highlight 操作并入现有批量任务：页面矩形与颜色先用于 DOM 预览，点击保存时才和 FreeText 一起解析与导出。模式与颜色记在本机；草稿本地检查点不等于写入 PDF。
