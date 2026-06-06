# MemGuard V1.3.0

MemGuard 是一个轻量 Windows 内存守护工具。它默认无感后台常驻，只保留托盘和自动守护；需要时再打开可视化 Dashboard、手动/自动工作集修剪，以及专门处理 Codex Desktop 残留 MCP 工具链的 Codex Guard。

V1.3.0 的重点是：降低 MemGuard 自身体积和常驻占用，让默认策略更适合 16GB Windows 机器；日常保持安静后台守护，高压抢救、预演清理、运行时占用和验证工具则在打开 Dashboard 时可见。

## 功能

- 默认无感低资源后台常驻：不开桌面小窗、不启动即强制清理，也能保留托盘和自动守护。
- 托盘单击只弹出菜单，双击或菜单项才打开 Dashboard，避免重复启动或误触时打断当前工作。
- 默认禁用 GPU 加速，降低 Electron 常驻私有内存；如果遇到透明小窗黑屏或闪烁，可在 Dashboard 里关闭该项后重启。
- Dashboard 显示内存占用、可用内存、自身占用、压力等级、压力处置建议、下次采样、最近清理记录和 Codex Guard 状态。
- 支持普通清理预演：先生成清理计划，不实际修剪进程。
- 支持强制抢救：高压或卡顿时先展示当前压力、Codex 候选和保护范围，再处理过期 Codex 工具链并执行高强度工作集修剪。
- 支持低资源推荐配置，一键填入更省内存的后台运行设置。
- Codex Guard 可扫描、预演并清理 Codex 遗留的 MCP/node/cmd 工具链，同时保护当前会话、Chrome、dev server 和无法确认的进程。
- 提供 snapshot benchmark、runtime benchmark、dashboard smoke 和 widget smoke，方便验证优化后的实际开销和 UI 可用性。

## 默认策略

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `memoryMode` | `aggressive` | 更主动地响应物理内存、commit、可用内存和进程数量压力。 |
| `lowResourceMode` | `true` | 隐藏桌面小窗时释放窗口进程，只保留后台守护。 |
| `showWidgetOnStart` | `false` | 启动后默认只显示托盘，减少常驻渲染器开销。 |
| `disableHardwareAcceleration` | `true` | 下次启动禁用 GPU 加速，通常能降低私有内存。 |
| `trimOnStart` | `false` | 启动后先静默采样，只有达到压力条件才自动清理，减少开机打扰和误修剪。 |
| `codexCleanWhileRunning` | `allow-stale` | Codex 运行中允许清理明确过期、断链或重复的旧工具链。 |
| `codexDryRunByDefault` | `true` | 手动 Codex 清理默认先预演，避免误结束进程。 |
| `codexAutoCleanWhileRunningCooldownMinutes` | `3` | 运行中自动清理冷却时间。 |
| `codexAutoCleanWhileRunningMaxKillsPerPass` | `48` | 单轮最多结束的 Codex 工具链目标数。 |

## Codex Guard

Codex Desktop 长时间运行后，可能留下大量 MCP 工具链进程，例如：

- `@shell-mcp/mcp-lite`
- `shell-mcp-lite`
- `@modelcontextprotocol/server-filesystem`
- `@modelcontextprotocol/server-sequential-thinking`
- `node_repl.exe`

Codex Guard 会：

- 区分 Codex Desktop 主进程、desktop app-server、stdio app-server、断链 MCP 和普通开发进程。
- 按 `root 类型 + 工具 key` 分组，保护最新或仍挂在当前 Codex 树下的工具链。
- 汇总候选组、可清理/保护/待确认数量、私有内存和工作集。
- 清理前二次扫描并校验 PID、创建时间和归一化工具 key，降低 PID 复用误杀风险。
- 不按进程名粗暴结束全部 `node.exe` 或 `cmd.exe`。
- 不自动清理 Chrome、Vite、`npm run dev`、Playwright、Cloudflare tunnel 等用户项目进程。

## 安装

开发环境：

```powershell
npm install
npm run dist
```

打包产物在 `dist` 目录。普通用户请下载并运行推荐安装包：

```text
MemGuard-Setup-V1.3.0.exe
```

源码目录安装：

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-MemGuard.ps1
```

日常用户也可以直接双击：

```text
Install-or-Repair.bat
```

## 升级

直接运行新版安装包：

```text
MemGuard-Setup-V1.3.0.exe
```

安装器使用固定应用 GUID，并在安装前停止旧版 MemGuard 计划任务和自身进程，避免覆盖升级时出现安装目录占用冲突。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\Uninstall-MemGuard.ps1
```

或双击：

```text
Uninstall.bat
```

## 验证与性能

常用验证命令：

```powershell
npm run verify
npm run pack
npm run smoke:dashboard
npm run smoke:widget
```

性能观察命令：

```powershell
npm run bench:snapshot
npm run bench:runtime
npm run bench:runtime -- --mode dev
npm run bench:runtime -- --compare
npm run bench:runtime -- --scenario dashboard-gpu-off --settle-ms 8000 --sample-ms 5000
npm run bench:runtime -- --scenario tray-gpu-off --extra-switch disable-gpu
```

- `verify` 覆盖语法检查、snapshot benchmark、Codex self-test、`trim-plan` dry-run、Dashboard 配置绑定和打包配置检查。
- `smoke:dashboard` 启动打包后的 `dist\win-unpacked\MemGuard.exe`，用隔离 `userData` 打开 Dashboard，并检查关键 DOM、`getDashboardState()`、自身占用和全量快照兜底。
- `smoke:widget` 默认启动打包后的 `dist\win-unpacked\MemGuard.exe`，用隔离 `userData` 打开桌面小窗，并检查关键 DOM、preload 小窗 API、渲染后的内存数值、进度条、按钮状态、快照值和进程残留清理；可用 `--mode dev` 做开发态对照。
- `bench:runtime` 默认启动打包后的 `dist\win-unpacked\MemGuard.exe`，用于观察更接近真实发布包的进程数、工作集和私有内存；首次运行前请先执行 `npm run pack`。
- `bench:runtime -- --mode dev` 使用本地 Electron 从源码启动，适合快速对照开发态；`--compare`、`--scenario`、`--settle-ms`、`--sample-ms` 和 `--extra-switch` 可与两种模式组合使用。
- `pack` 会通过 `build/afterPack.js` 移除未使用的 D3D12/Vulkan/SwiftShader fallback 文件来降低解压体积；如需兼容性回退，可设置 `MEMGUARD_KEEP_GPU_FALLBACKS=1` 后重新打包。

## 配置

首次运行会生成本机 `config.json`。仓库提供 `config.example.json` 作为默认配置参考。

配置、历史和日志会写入当前用户的应用数据目录或安装目录中的运行态文件，不建议把这些运行态文件提交到仓库。

## 注意

MemGuard 不能真正增加物理内存，也不能修复应用本身的内存泄漏。它适合缓解工作集膨胀、Codex MCP 残留和大量 Node 工具链堆积导致的卡顿；如果经常同时运行浏览器、QQ、微信、MATLAB、仿真软件和 IDE，升级到 32GB 内存仍然是更稳定的方案。
