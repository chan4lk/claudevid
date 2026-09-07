# Verification Report: 006-tts-voiceover-captions

**Verified:** 2026-09-07
**Model:** claude-sonnet-5
**Verdict:** PARTIAL

## Note on evidence payload

`/tmp/verify-006-ctx.txt`'s "Implementation (changed files)" section literally read "No changed files found" — it contained spec/design prose and unrelated auto-discovered docs (a generic architecture-plan markdown and GOALS.md) but no actual source. The agent read the real files directly from the `specclaw/006-tts-voiceover-captions` branch (`packages/audio/src/*.ts`, `packages/audio/test/*.test.ts`, `packages/core/test/schema.test.ts`, `.specclaw/changes/006-tts-voiceover-captions/{design,tasks}.md`) and re-ran `pnpm -r run test` for real evidence.

## Acceptance Criteria

- ✅ **AC1:** `narration: "hello world"` normalizes to `[{ text: "hello world" }]` — `packages/core/test/schema.test.ts:58-67` asserts `result.data.scenes[0].narration` `toEqual([{ text: "hello world" }])` after `videoSpecSchema.safeParse`. `schema.ts`'s `narrationSchema` uses `z.preprocess` to wrap non-array input, confirmed in `packages/core/src/schema.ts:39-47`.
- ✅ **AC2:** array-of-`NarrationBlock` parses unmodified — `schema.test.ts:80-90` asserts `toEqual(narration)` (byte-identical).
- ✅ **AC3:** identical request → single write, second call is a cache hit — `cache.test.ts:65-87` asserts `fn` `toHaveBeenCalledTimes(1)` after two calls with a fresh object literal of the same values, plus exactly one cache file exists.
- ✅ **AC4:** any single field change → cache miss — `cache.test.ts:89-113` covers `speed` and `modelDigest` independently; `cache.test.ts:115-132` proves key-order-independence (canonical JSON).
- ✅ **AC5:** editing one block's text re-synthesizes only that block — `cache.test.ts:134-162` uses two independent fixtures with call-count and per-call `.text` assertions.
- ✅ **AC6:** interrupted write leaves no partial entry, read is a miss — `cache.test.ts:164-219` covers truncated/invalid JSON, valid-JSON-wrong-shape, and a leftover `.tmp` file; `cache.ts:83-115`'s `readCacheEntry` treats all three as `null`.
- ✅ **AC7:** duration for every `"auto"` scene = fixture audio length + padding — `durations.test.ts:52-81` computes exact expected values and asserts fixed-duration scenes are absent from output.
- ✅ **AC8:** both directions tested — floor silently raised (`durations.test.ts:96-107`), ceiling throws `MaxDurationExceededError` naming scene/value (`durations.test.ts:109-129`), plus an ordering-bug guard (`durations.test.ts:131-145`).
- ⚠️ **AC9 (gated integration tier):** PARTIALLY MET. Real synthesis genuinely ran (`tts.live.test.ts` executed, not skipped, ~1.7s warmup) and asserted non-empty audio/positive sampleRate. But "model digest verifies against the pinned value" is NOT exercised — the live test only regex-checks `PINNED_MODEL.digest` is syntactically 64 hex chars, never compares against what Kokoro actually loaded. Root cause: `tts.ts` ignores `request.modelId`/`modelDigest` entirely and calls kokoro-js's own default model resolution directly (documented in its own comment as a "T4 follow-up" that never happened).
- ⚠️ **AC10:** PARTIALLY MET. Digest verification and fail-closed-on-corruption are genuinely tested at the function level (`models.test.ts:67-99`). But there's no CLI to run the literal "`claudevid models install`" (that's change 007), and `PINNED_MODEL.digest` is an explicitly-flagged 64-zero-char placeholder, not a real digest.
- ✅ **AC11:** `pnpm -r run build`/`test`/`lint` all pass; 001-005 unaffected. One flaky failure in `packages/renderer-canvas/test/perf.test.ts` (change-002 timing test, unrelated to 006) reproduced once under sandbox load and passed cleanly in isolation immediately after — confirmed flakiness, not a regression.

## Design Decisions — spot-checked

- ✅ D1 (full-request-object cache key), ✅ D2 (single cache root) — both confirmed in code.
- ⚠️ **D5 (model pinning, fail-closed)** — the pinning/verification machinery itself is solid, but **not actually consulted by the production `synthesize()` path**, contradicting D5's "network access confined to an explicit install command."
- ✅ D6 (fail-closed everywhere) — confirmed for cache corruption, digest mismatch, duration ceiling.

## Issues Found

1. **`tts.ts`'s real `synthesize()` never uses `models.ts`'s pinned/verified model** — calls `KokoroTTS.from_pretrained` directly, bypassing the install/verify gate entirely. This is the one substantive gap: FR6's fail-closed/no-implicit-network guarantee doesn't actually hold for the synthesis path as shipped.
2. `PINNED_MODEL.digest` is a placeholder, not a real digest — expected/acceptable per its own TODO, harmless (fails closed).
3. AC10's literal CLI invocation has no CLI yet (change 007) — acceptable, out of this change's declared scope.

## Summary

**Passed clean:** AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8, AC11 (9/11)
**Partially met:** AC9, AC10 (2/11) — both trace to issue #1 above.
**Verdict:** PARTIAL — schema/cache/duration core is solid and well-tested. Model-pinning integration (FR6) is incomplete: built but not wired in. Remediation: wire `tts.ts` through `models.ts` before merge.
