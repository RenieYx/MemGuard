# MemGuard V1.1

## Highlights

- Added Codex Process Guardian for stale Codex MCP process cleanup.
- Added dashboard scan, dry-run, and confirmed cleanup controls.
- Added commit memory pressure visibility to the PowerShell engine.
- Improved installer upgrade behavior so V1.1 can replace a running older MemGuard install.
- Throttled automatic Codex scans to reduce WMI overhead while keeping manual scans immediate.

## Upgrade Notes

The V1.1 NSIS installer stops the existing MemGuard scheduled task and MemGuard-owned processes before replacing files. It only targets `MemGuard.exe`, MemGuard-launched `electron.exe`, and MemGuard-launched `wscript.exe` instances whose command line or executable path belongs to the current install directory.

Recommended installer artifact:

```powershell
MemGuard-Setup-V1.1.0.exe
```

Portable artifact:

```powershell
MemGuard-V1.1.0-x64.exe
```

## Safety

- Codex Guard never kills all `node.exe` or `cmd.exe` by process name.
- It protects processes that are still attached to a live Codex process tree.
- While Codex is running, the default `orphan-only` mode only marks stale orphan chains from a previous Codex desktop session as cleanable.
- Dev servers such as Vite, `npm run dev`, Chrome, Playwright, and Cloudflare tunnels are reported for review but not automatically cleaned.
- Cleanup writes PID, reason, command summary, process chain, and before/after memory state to logs.
