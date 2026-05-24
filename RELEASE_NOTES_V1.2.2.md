# MemGuard V1.2.2

## Highlights

- Publishes a single recommended Windows installer asset: `MemGuard-Setup-V1.2.2.exe`.
- Removes the default portable build target so the GitHub release page no longer shows two nearly identical downloads.
- Enables maximum installer compression and keeps only `zh-CN` / `en-US` Electron locale packs in packaged builds.
- Keeps the desktop widget renderer resident as requested, but stops its permanent `requestAnimationFrame` loop when the displayed memory value is settled.
- Serializes engine calls so snapshot, Codex scan, trim, and dashboard refresh do not spawn overlapping PowerShell processes.
- Reuses very recent snapshots for the dashboard to reduce short-lived PowerShell memory spikes.
- Delays dashboard Codex scan after the first settings refresh, and uses cached scan data when available.
- In packaged builds, disables devtools/spellcheck and Chromium background network services that MemGuard does not use.

## Validation Plan

- Node syntax checks for Electron main, preload, renderer, and dashboard scripts.
- Codex Guard self-test.
- Production build with only the NSIS installer target.
- Compare installer size against V1.2.1.
- Compare local MemGuard process working set before and after restart.

## Notes

- Engine calls are intentionally serialized to reduce memory spikes. If a heavy Codex scan or clean is already running, widget refresh and automatic trim wait for that engine task to finish instead of spawning another PowerShell process.

## Artifact

```text
MemGuard-Setup-V1.2.2.exe
```
