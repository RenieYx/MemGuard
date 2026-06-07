# Smart Background Relief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MemGuard smarter in unattended background mode by letting safe Codex cleanup satisfy pressure before running a heavier working-set trim.

**Architecture:** Add a pure decision module in `src/auto-relief.js`, wire it into `src/main.js`, and cover it through `tools/verify.js`. Keep PowerShell trim behavior unchanged and keep version `1.3.0`.

**Tech Stack:** Electron main process, Node CommonJS, PowerShell engine, existing npm verification and packed smoke scripts.

---

### Task 1: Add Pure Auto-Relief Decisions

**Files:**
- Create: `src/auto-relief.js`
- Modify: `tools/verify.js`

- [ ] Create `src/auto-relief.js` with pure functions for pressure counting, cooldowns, and post-Codex trim suppression.
- [ ] Export `isPressureActive`, `shouldCountHighCheck`, `trimCooldownMs`, `shouldAutoTrim`, and `shouldSkipTrimAfterCodex`.
- [ ] Add `verifyAutoReliefPolicy()` in `tools/verify.js` with deterministic fixtures for normal, watch, pressure, critical, and post-Codex after-snapshot cases.
- [ ] Add `src/auto-relief.js` to `package.json` build files and `tools/verify.js` runtime file assertions.

### Task 2: Wire Smart Relief Into Background Scheduler

**Files:**
- Modify: `src/main.js`

- [ ] Import the new decision helpers.
- [ ] Replace duplicated pressure and cooldown logic in `publishSnapshot()`.
- [ ] After `autoCleanCodex()` returns an `after.snapshot`, use `shouldSkipTrimAfterCodex()` to skip the real trim if pressure is no longer meaningful; `autoCleanCodex()` keeps the existing responsibility for caching that snapshot.
- [ ] Log the skip reason so unattended behavior is auditable.
- [ ] Keep manual `trim-now`, `trim-plan`, `codex-clean`, and `rescue-now` unchanged.

### Task 3: Verify, Package, and Publish

**Files:**
- Modify only if verification reveals an issue.

- [ ] Run `npm run verify`.
- [ ] Run `npm run dist`.
- [ ] Run `npm run smoke:dashboard -- --mode packed --timeout-ms 30000 --json`.
- [ ] Run `npm run smoke:widget -- --mode packed --timeout-ms 30000 --json`.
- [ ] Confirm `package.json` still has version `1.3.0`.
- [ ] Commit the source/docs changes.
- [ ] Push the current branch to GitHub.
- [ ] Replace GitHub Release `v1.3.0` assets with the newly verified `dist` files and update release notes/hash values.
