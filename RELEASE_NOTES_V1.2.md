# MemGuard V1.2

## Highlights

- Added always-on Codex Guard cleanup while Codex is running, limited to old-session orphan chains and old duplicate desktop app-server tool chains so the current conversation stays protected; the default running cleanup cooldown is 5 minutes.
- Added grouped Codex Guard reporting so the dashboard can show Codex MCP/tool families instead of only long per-process lists.
- Added candidate memory totals for private memory and working set, making Electron/Codex multi-process memory easier to interpret.
- Made normal working-set trimming safer by skipping active Codex, Electron/Chromium/browser/editor, and common Node tool processes.
- Fixed dashboard settings saves so existing Codex Guard policy fields are preserved instead of reset to defaults.
- Fixed Codex dry-run execution so manual, dry-run, and auto-clean requests no longer temporarily mutate global runtime config.
- Added engine-side allowed-reason filtering and per-pass kill limits for unattended Codex cleanup.
- Polished the Codex Guard dashboard with denser 720px layout, clearer scan/preview/clean actions, group summaries, and live list counts.

## Validation

- PowerShell engine parse check.
- Codex Guard self-test with grouped candidate and safe-trim assertions.
- Live Codex scan and dry-run cleanup checks.
- Node syntax checks for Electron main, preload, renderer, and dashboard scripts.
- Electron package and Windows installer build smoke.

## Artifacts

```text
MemGuard-Setup-V1.2.0.exe
MemGuard-V1.2.0-x64.exe
```
