# Verification Report: 001-videospec-core

**Verified:** 2026-09-06
**Model:** claude-sonnet-4.5
**Verdict:** PASS

## Acceptance Criteria

- ✅ **AC1:** `parseSpec` accepts a minimal valid spec (1 scene, 1 text layer) and returns `{ ok: true }` — `test/diagnostics.test.ts` "parseSpec (AC1)" calls `parseSpec(minimalSpec())` and asserts `result.ok === true`; `src/diagnostics.ts` returns `{ ok: true, spec: result.data }` on `safeParse` success.
- ✅ **AC2:** rejects out-of-range `fontSize` with a correct JSON pointer — `test/diagnostics.test.ts` "parseSpec (AC2)" sets `fontSize = -5` and asserts `diagnostic!.path === "/scenes/0/layers/0/fontSize"`.
- ✅ **AC3:** rejects a `group` nested 3 levels deep, naming the path (not a raw error) — `checkNestingDepth` (layers.ts) + `sceneSchema.superRefine` (schema.ts) produce a diagnostic with message matching `/nesting/i` and path `/^\/scenes\/0\/layers/`. Hand-traced: g1 depth1 (ok), g2 depth2 (ok), g3 depth3 (>2, violation) — correctly rejects the 3rd level.
- ✅ **AC4:** fractional-duration frame windows are exact and contiguous — `[2.5, 3.333, 1.0]` at fps 30 → `[0,75],[75,175],[175,205]`, `frameCount === 205`.
- ✅ **AC5:** no float drift over 3600 one-second scenes at 24fps — `frameCount === 86400`, last `endFrame === 86400`.
- ✅ **AC6:** `duration:"auto"` with no matching `audioDurations` entry throws `MissingAudioDurationError` naming the scene id. No fallback/estimate path exists in the code.
- ✅ **AC7:** `duration:"auto"` with a matching entry sizes the window from that entry (`4.2s @ 30fps → 126 frames`, no default used).
- ✅ **AC8:** `activeAt(frame)` returns exactly the layers whose resolved window contains the frame — binary search + per-scene filter verified against an always-on/first-half/second-half layer fixture, both directions.
- ✅ **AC9:** `registerLayer("caption", captionLayerSchema)` lets `parseSpec` accept a `caption` layer without touching `layers.ts` — verified from the test file itself with no source edit.
- ✅ **AC10:** JSON Schema round-trips against the same minimal spec via `ajv` — accepts the valid spec, rejects one missing `scenes`.
- ✅ **AC11:** build and test both succeed from the current checkout — reran independently: `pnpm --filter @claudevid/core test` → 7 files / 28 tests passed; `pnpm --filter @claudevid/core build` → tsup ESM + DTS build succeeded.

## Additional correctness checks

- **NFR1 (zero I/O):** only runtime deps are `zod`/`zod-to-json-schema`; no `fs`/`child_process`/`net` imports anywhere in `src/`.
- **NFR2 (determinism):** no `Date.now()`/`Math.random()` in `src/`.
- **NFR3 (type/validator parity):** all types are `z.infer` except `GroupLayer` and `Scene`, which are hand-written interfaces annotated as `z.ZodType<T>` so `tsc` rejects any drift — a documented, deliberate exception for Zod's lack of native self-referential-type inference.
- **FR11 (monorepo scaffolding):** `pnpm-workspace.yaml`, `tsconfig.base.json`, per-package `tsconfig.json`/`tsup.config.ts`/`vitest.config.ts` all present and functioning.

## Test Results

```
✓ test/easing.test.ts (4 tests)
✓ test/resolve.test.ts (6 tests)
✓ test/timeline.test.ts (8 tests)
✓ test/diagnostics.test.ts (4 tests)
✓ test/schema.test.ts (3 tests)
✓ test/layers.test.ts (1 test)
✓ test/json-schema.test.ts (2 tests)
Test Files  7 passed (7)
     Tests  28 passed (28)
```

## Issues Found

None. Implementation matches spec and design; nesting-depth, binary-search, and frame-rounding logic were hand-traced independently rather than trusting the test assertions alone.

## Summary

**Passed:** 11/11 criteria
**Failed:** 0/11 criteria
**Verdict:** PASS
