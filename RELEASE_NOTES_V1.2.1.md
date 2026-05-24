# MemGuard V1.2.1

## Highlights

- Fixed high-memory Codex runs where many young duplicate desktop app-server tool chains were protected until the 10 minute stale threshold; under process-count or commit pressure, MemGuard now keeps the newest two chains per tool group and cleans older duplicates immediately.
- Added pressure working-set trim for Chrome/Codex/Electron/Node tool processes. This does not kill the current Codex session; it asks Windows to release reclaimable working-set pages when memory or commit pressure is high.
- Added publish-loop protection so slow engine calls cannot overlap and pile up extra PowerShell processes.
- Rebuilds the snapshot timer when settings change.
- Logs Codex Guard and startup trim errors instead of swallowing them silently.
- Increased Codex scan/clean engine timeouts for heavy process tables.
- Fixed the dashboard sometimes requiring a second tray/context-menu click before it appeared.
- Restricted after-exit Codex cleanup to explicit orphan reasons instead of passing an empty reason filter.

## Validation

- Codex Guard self-test, including young duplicate cleanup under pressure and pressure trim assertions.
- Node syntax checks for Electron main, preload, renderer, and dashboard scripts.
- Live emergency cleanup of duplicate Codex desktop app-server chains.
- Live pressure working-set trim: memory dropped from 76.6% to 45.5%, free memory from 3.59GB to 8.37GB without killing the current Codex session.
- Electron restart smoke test with the new scheduler loaded.
- Dashboard reveal smoke via syntax and load-event fallback path.

## Artifacts

```text
MemGuard-Setup-V1.2.1.exe
MemGuard-V1.2.1-x64.exe
```
