# MemGuard V1.3.0

V1.3.0 是面向 16GB Windows 机器的高强度智能内存管理版本。目标是降低 MemGuard 自身常驻占用，减少长时间不重启后的卡顿，并让自动处理更主动、更可验证。

## 重点变化

- 默认启用 `lowResourceMode: true`、`showWidgetOnStart: false` 和 `disableHardwareAcceleration: true`，后台常驻更省内存。
- 默认启用 `aggressive` 内存模式，Codex 运行中策略升级为 `allow-stale`。
- 新增压力评分：结合物理内存、commit、可用内存、进程数和句柄数，输出 `normal`、`watch`、`pressure`、`critical`。
- 常驻应用的高频快照改走 Node 快路径，并加入定期全量快照兜底，避免 `commitPercent` 和 `processCount` 长期陈旧。
- 新增 `trim-plan` 普通清理预演，只生成候选计划，不实际修剪进程。
- 新增 `rescue` 强制抢救路径：执行前展示当前压力、Codex 候选和保护范围，确认后先清理 Codex 过期/重复工具链，再用高强度策略修剪大工作集。
- Dashboard 增加自身占用、压力等级、压力处置建议、下次采样、操作结果反馈、未保存设置提示和需重启提示。
- 新增低资源推荐配置按钮，方便快速套用后台省资源策略。
- 新增 `npm run bench:snapshot`、`npm run bench:runtime`、`npm run smoke:dashboard` 和 `npm run smoke:widget`。
- Runtime benchmark 默认测量打包后的 `dist\win-unpacked\MemGuard.exe`，并增加 `--mode dev`、峰值/稳定值提示、非 Electron helper 统计、`dashboard-gpu-off` 场景和 `--extra-switch` 实验参数。
- 打包后自动裁剪未使用的 D3D12/Vulkan/SwiftShader fallback 文件，降低 `win-unpacked` 体积；设置 `MEMGUARD_KEEP_GPU_FALLBACKS=1` 可保留这些文件用于兼容性回退。
- 低资源模式下，仅 Dashboard 可见或内存压力活跃时才保持短间隔 Codex 扫描；单独显示桌面小窗不再缩短后台扫描间隔。

## 默认策略

- `memoryMode`: `aggressive`
- `lowResourceMode`: `true`
- `showWidgetOnStart`: `false`
- `disableHardwareAcceleration`: `true`
- `codexCleanWhileRunning`: `allow-stale`
- `codexDryRunByDefault`: `true`
- `codexAutoCleanWhileRunningCooldownMinutes`: `3`
- `codexAutoCleanWhileRunningMaxKillsPerPass`: `48`
- `codexPolicyVersion`: `3`

## 验证结果

- `npm run verify`: 通过。
- `npm run pack`: 通过，`dist\win-unpacked` 包含真实 `使用说明.txt`。
- `npm run smoke:dashboard`: 通过，打包产物可打开 Dashboard，并验证关键 DOM、`getDashboardState()`、自身占用、全量快照兜底和强制抢救确认文案。
- `npm run smoke:widget`: 通过，打包产物可打开桌面小窗，并验证关键 DOM、preload 小窗 API、渲染内存数值、进度条、按钮状态和快照字段。
- `codex-self-test`: 15 条断言通过。
- `trim-plan`: dry-run JSON contract 通过，包含 `trimPlan`、候选数量和敏感进程跳过列表。
- `npm run bench:snapshot`: 1000 次常驻快照平均约 `0.06 ms`，P50 约 `0.06 ms`。
- `npm run pack`: `win-unpacked` 体积约 `250.1 MB`，afterPack 裁剪约 `32.6 MB` GPU fallback 文件。

## Runtime Benchmark

命令：

```powershell
npm run bench:runtime
npm run bench:runtime -- --mode dev
npm run bench:runtime -- --compare
```

默认 `packed` 模式需要先执行 `npm run pack`，用于测真实发布包；`--mode dev` 会通过本地 Electron 从源码启动，适合开发态快速对照。

场景：

- `tray`: 低资源托盘后台。
- `tray-gpu-off`: 低资源托盘后台，并禁用 GPU 加速。
- `widget`: 显示桌面小窗。
- `widget-gpu-off`: 显示桌面小窗，并禁用 GPU 加速。
- `dashboard`: 打开 Dashboard。
- `dashboard-gpu-off`: 打开 Dashboard，并禁用 GPU 加速。

最近一次短样本数据来自 `packed` 模式：`tray-gpu-off` 约 `137.9 MB` 工作集 / `55.1 MB` 私有内存，`tray` 约 `162.4 MB` 工作集 / `106.0 MB` 私有内存。上一轮稳定态数据中，`dashboard-gpu-off` 约 `311.8 MB` 工作集 / `135.7 MB` 私有内存；额外加 `--extra-switch disable-gpu` 后约 `312.1 MB` 工作集 / `142.5 MB` 私有内存，GPU 进程仍存在，因此暂不把 `disable-gpu` 作为默认产品开关。显示小窗和 Dashboard 会增加 Electron 渲染器开销，默认低资源后台常驻仍是合理选择。

## 性能说明

上一版通过 PowerShell 冷启动采集 snapshot，单次通常在秒级。V1.3.0 的常驻 Node 快照热路径在毫秒以下，适合短间隔调度；同时每隔一段时间或冷启动时做全量快照，确保 commit 压力和进程数不会长期缺失。

`codex-scan` 仍需要全量进程链扫描，因此不会放进高频热路径；低资源模式在没有可见 UI、没有内存压力时会自动拉长 Codex 扫描间隔。
