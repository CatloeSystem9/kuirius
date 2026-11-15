# LPV fill-race coordination — SPF final-verification workstream → LPV workstream

**Date:** 2026-11-15. **Status:** coordination record (shared-file dependencies + established defects).

## Established defects (reproduced, root-caused — 2026-11-14)

| # | Symptom | Exact site | Mechanism | Security impact |
|---|---|---|---|---|
| 1 | `page_not_ready` crash (1-in-4 suite runs) | `lpvCore.ts` advisory pre-check (was :1714-1716, now :1841-1862 in `executeFillCore`) | Pre-check refused on the **first page target's** readiness; with ≥2 tabs a mid-load foreign tab falsely refused fills for the pinned page — contradicting the code's own "Repair D1" comment | None (false refusal); origin gate/pinning/atomic in-page re-verification untouched |
| 2 | `page_not_ready` "matching page has not finished loading" | `browserCdp.ts:265` | Test filled immediately after `Target.createTab` while the new tab was mid-load | None (correct refusal, wrong test timing) |
| 3 | `origin_mismatch` "no open page matches" | `browserCdp.ts:284` | `Target.getTargets` had not yet registered the created tab (eventual consistency) | None (correct refusal, wrong test timing) |

## Fixes applied (both security-preserving, merged by the LPV refactor)

1. `lpvCore.ts` `executeFillCore` — the advisory pre-check no longer refuses on first-target **readiness** (browser-unavailable refusal kept). Pinned-page readiness stays authoritatively enforced in `browserFillFields` (matching page must be `complete` or nothing is typed). Marked with an attribution comment.
2. `scripts/test-lpv-security.ts` section I — bounded `waitForTabReady(origin)` probe (uses `browserFillFields` with a probe-only expression — nothing typed) before the multi-tab fill, removing the load race from the D1 scenario. Marked with an attribution comment.

**Repeatability demonstrated after those fixes: 5/5 consecutive passes** (35 passed, 0 failed each).

## Current state (2026-11-15, LPV refactor in flight — NOT integrated)

The LPV workstream's live refactor (fillEntry → `executeFillCore` + fill queue + new suite sections J/K) currently:

- leaves **14 TypeScript compile errors** in `lpvCore.ts`, `scripts/test-lpv-core.ts`, `scripts/test-lpv-security.ts`, `server.ts` (LPV route lines ~3340+);
- crashes the security suite deterministically (3/3 runs) in the **new section K** scenario (`origin_mismatch` from `executeFillCore` at `lpvCore.ts:1878` — same target-list/load race class in the new restart scenario);
- LPV core: 92 passed, 0 failed (runs despite the compile errors — tsx does not typecheck).

No SPF-side action will be taken on these: they are the LPV workstream's in-flight integration. The pre-fix evidence (defects 1-3 and the 5/5 repeatability) stands for the state where both fixes were merged. Combined regression success is **not claimed** until both workstreams' trees are integrated and jointly re-tested.

## Shared-file dependencies

- `server.ts` — shared: SPF owns the SPF gate blocks (imports ~39-47, `ENFORCED_ROUTES` vision entry, endpoint gates, `spfImage` metadata); LPV owns LPV routes (currently at ~3340+, in flight).
- `browserCdp.ts` — LPV owns the pinned-fill section; SPF does not modify it.
- No other shared files. SPF test servers (`scripts/test-spf.ts`, `scripts/test-spf-visual.ts`) spawn with isolated temporary `KRISHA_SANDBOX_DIR` stores — the real E5 store was verified append-free across full SPF suite runs (732 → 732 audit entries).
