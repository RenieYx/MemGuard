# Smart Background Relief Design

## Goal

MemGuard should feel like a quiet background memory steward: after installation, ordinary users should not need to open the Dashboard or understand Windows memory terminology. The app should observe pressure, clean safe Codex leftovers automatically, and only trim process working sets when pressure remains meaningful.

## Product Direction

The product should prefer "explain and act carefully" over "clear everything". This follows the safer lesson from tools such as RAMMap and Process Explorer: diagnose pressure and responsibility first, then choose the smallest action that can help.

MemGuard V1.3.0 keeps the current version number. This round does not add standby-list clearing, modified-page clearing, system cache limit changes, or broad all-process trimming.

## Behavior

1. Normal state:
   - Keep the app quiet in the tray.
   - Stretch snapshot and Codex scan intervals as already implemented.
   - Do not run real working-set trim just because memory is somewhat used.

2. Watch state:
   - Prefer Codex Guard maintenance when there are safe stale or duplicate tool chains.
   - Avoid real working-set trim unless repeated high checks also pass the existing configured threshold.

3. Pressure or critical state:
   - Run Codex Guard first when enabled.
   - Take a fresh snapshot after Codex cleanup.
   - If pressure drops below the real trim threshold, skip the working-set trim and record/log that Codex cleanup was enough.
   - If pressure remains high for the configured consecutive checks and cooldown allows it, run the existing trim path.

4. Manual actions:
   - Manual trim, trim-plan, Codex scan, Codex clean, and rescue keep their current behavior.
   - This change only affects unattended background automation.

## Architecture

Add a focused pure JavaScript module under `src/auto-relief.js`. It owns the decision logic for background actions and exports:

- `isPressureActive(snapshot, config)`
- `shouldCountHighCheck(snapshot, config)`
- `trimCooldownMs(snapshot, config)`
- `shouldAutoTrim({ snapshot, config, highCount, lastAutoTrim, now })`
- `shouldSkipTrimAfterCodex({ snapshot, config })`

`src/main.js` continues to own Electron, IPC, timers, and engine calls. `publishSnapshot()` delegates threshold and cooldown decisions to the new module. After `autoCleanCodex()` returns a real result with an `after.snapshot`, `publishSnapshot()` re-evaluates whether a working-set trim is still needed.

## Data Flow

```text
publishSnapshot
  -> getSnapshot(fast)
  -> auto-relief decides whether this tick counts as pressure
  -> codexScan(false)
  -> autoCleanCodex(scan)
  -> if Codex cleanup produced after.snapshot, re-check trim need
  -> runEngine('trim', 'auto') only when pressure still qualifies
```

## Safety Rules

- Do not lower existing user-configured thresholds.
- Do not increase the number of processes selected by the PowerShell trim engine.
- Do not make watch-level pressure alone trigger real trim unless existing `triggerPercent` / consecutive checks say so.
- Keep `engineQueue` serialization and existing cooldown behavior.
- Keep version `1.3.0`.

## Validation

Add deterministic unit-style checks inside `tools/verify.js` for the new decision module:

- Normal state does not trigger auto trim.
- Watch state counts only in aggressive mode, but still requires the consecutive check count.
- Pressure and critical states use shorter cooldowns.
- Codex cleanup after-snapshot can suppress a pending trim when pressure drops.
- Pressure after-snapshot does not suppress a needed trim.

Run:

```powershell
npm run verify
npm run dist
npm run smoke:dashboard -- --mode packed --timeout-ms 30000 --json
npm run smoke:widget -- --mode packed --timeout-ms 30000 --json
```

Before release upload, confirm the generated installer assets and remote Release hashes match.
