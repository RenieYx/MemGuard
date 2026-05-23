# MemGuard V1.2

MemGuard 是一个轻量 Windows 内存守护工具。它提供桌面内存小组件、手动/自动工作集修剪，以及专门针对 Codex Desktop 残留 MCP 工具链的 Codex Guard。

## 功能

- 显示当前内存占用、可用内存和上次清理时间。
- 支持双击小组件或点击按钮执行手动清理。
- 支持按阈值自动清理大进程工作集。
- 提供中文可视化设置面板、历史记录和日志入口。
- Codex Guard 可扫描、预演并清理 Codex 遗留的 MCP/node/cmd 工具链。
- V1.2 会按 Codex 工具分组显示候选进程和内存口径，并让普通清理避开活跃的 Codex/Electron/Chromium/Node 工具树。
- V1.2 安装器支持覆盖升级，会在安装前停止旧版 MemGuard 相关进程，避免安装目录占用冲突。

## Codex Guard

Codex Desktop 长时间运行后，可能留下大量 MCP 工具链进程，例如：

- `@shell-mcp/mcp-lite`
- `shell-mcp-lite`
- `@modelcontextprotocol/server-filesystem`
- `@modelcontextprotocol/server-sequential-thinking`
- `node_repl.exe`

V1.2 的 Codex Guard 会：

- 区分 Codex Desktop 主进程、desktop app-server、stdio app-server 和断链 MCP。
- 按 `root 类型 + 工具 key` 分组，保护最新或仍挂在当前 Codex 树下的工具链。
- 汇总候选组、可清理/保护/待确认数量、私有内存和工作集，避免把 Electron 多进程误读成单个软件异常。
- 对旧的重复工具链、断链 shell MCP 做 dry-run、手动清理和运行中自动清理。
- 清理前二次扫描并校验 PID、创建时间和归一化工具 key，降低 PID 复用误杀风险。
- 不按进程名粗暴杀全部 `node.exe` 或 `cmd.exe`。
- 不自动清理 Chrome、Vite、`npm run dev`、Playwright、Cloudflare tunnel 等用户项目进程。

## 默认策略

- 内存占用连续 2 次达到 85% 后触发自动清理。
- 每 20 分钟最多自动清理一次。
- 只修剪工作集超过 180MB 的普通应用。
- 启动时先执行一次温和清理。
- Codex 运行中默认启用自动清理：只结束旧会话断链残留和旧的重复 desktop app-server 工具链，当前 stdio/app-server 链、最近启动链和无法确认的目标会被保护或列为“需人工确认”。
- Codex 运行中自动清理每 5 分钟最多触发一次，单轮最多结束 24 个目标；退出后残留仍会继续自动清理。

## 安装

开发环境：

```powershell
npm install
npm run dist
```

打包产物在 `dist` 目录：

- `MemGuard-Setup-V1.2.0.exe`：安装版
- `MemGuard-V1.2.0-x64.exe`：便携版

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
MemGuard-Setup-V1.2.0.exe
```

V1.2 安装器使用固定应用 GUID，并在安装前停止旧版 MemGuard 计划任务和 MemGuard 自身进程，避免版本迭代时出现安装冲突。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\Uninstall-MemGuard.ps1
```

或双击：

```text
Uninstall.bat
```

## 配置

首次运行会生成本机 `config.json`。仓库提供 `config.example.json` 作为默认配置参考。

配置、历史和日志会写入当前用户的应用数据目录或安装目录中的运行态文件，不建议把这些运行态文件提交到仓库。

## 注意

MemGuard 不能真正增加物理内存，也不能修复应用本身的内存泄漏。它适合缓解工作集膨胀、Codex MCP 残留和大量 Node 工具链堆积导致的卡顿；如果经常同时运行浏览器、QQ、微信、MATLAB、仿真软件和 IDE，升级到 32GB 内存仍然是更稳的方案。
