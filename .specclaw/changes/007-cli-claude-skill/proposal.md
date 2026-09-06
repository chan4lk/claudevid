# Proposal: CLI, Claude Director Loop & Claude Code Skill

**Created:** 2026-09-06
**Status:** 🟡 Draft

**Depends on:** all of 001–006. This is the surface that makes them reachable.

## Problem

Changes 001–006 produce a fast, well-tested rendering library that nobody — human or model —
can actually use. The requirement doc's central thesis is:

```
Claude generates JSON → your CLI validates it → your renderer renders it
```

Two of those three arrows do not exist yet, and the interesting failure is in the middle one.

**The generation loop is where this project succeeds or fails.** Claude will emit invalid specs.
Not occasionally — routinely, especially for long videos, because the doc's own arithmetic says a
30-minute video is 100–500 scenes and *"that is too much for one Claude response"*. So the real
problems are:

1. **No repair loop.** A single invalid field in scene 47 kills a generation that took four
   minutes. Without feeding change 001's diagnostics back to the model, the workflow is "try
   again and hope".
2. **No chunking strategy.** Asking for 360 scenes in one response produces truncated JSON. The
   doc says to chunk by chapter and does not specify how chunks are made consistent — scene ids
   must not collide, visual style must not drift between chapter 1 and chapter 7, and a chapter
   that references a component introduced in a prior chapter must know about it.
3. **No brand identity.** Generic dark-background slides with default fonts are what every
   AI-generated video looks like. A project-level brand kit — palette, fonts, logo, lower-thirds,
   intro/outro — is what makes output look like *one channel* instead of one prompt.
4. **The preview loop is too slow to iterate on.** If checking a motion tweak requires a full
   render, nobody tunes anything and the output stays at "good enough".
5. **Claude Code doesn't know the library exists.** The doc specifies a skill folder; without it,
   using this library from Claude Code means pasting the schema into context every session.

## Proposed Solution

Build `@claudevid/cli` plus the Claude integration package.

**1. Commands.**

| Command | Does |
|---|---|
| `claudevid init` | scaffold a project: config, brand kit, example specs, `.claudevid/` cache dir |
| `claudevid validate <spec>` | change 001 diagnostics with JSON pointers, exit 1 on failure |
| `claudevid preview <spec>` | 720p fast render, `--watch` re-render on change, `--sheet` contact-sheet from change 003 |
| `claudevid render <spec>` | full pipeline: audio → timeline → parallel render → encode → mux |
| `claudevid generate "<prompt>"` | Claude → spec → validate → repair → (optionally) render |
| `claudevid batch <dir>` | queue of prompts or specs → N videos, per-job artifacts and logs |
| `claudevid bench` | change 005's benchmark harness |
| `claudevid models install` | fetch TTS/alignment models from change 006 |

Flags per the doc: `--width --height --fps --encoder --quality --format --vertical --out`,
plus `--concurrency`, `--no-cache`, `--profile`, `--scenes`, `--chapter`.

**2. The structured-output repair loop — the part that matters.**
The JSON Schema generated in change 001 is passed to the Anthropic API as a structured-output /
tool schema, so the model is constrained at generation time rather than corrected afterwards.
On validation failure, the diagnostics (JSON pointer + message + suggested repair) are fed back
for a **bounded** number of attempts, then the command fails loudly with the last diagnostics
printed.

The library never silently "fixes" a spec. A quietly repaired spec is a video that renders
successfully and says something the author did not intend — the worst failure mode available
here, because it ships.

**3. Chapter-based generation for long form.**
`outline → chapters → per-chapter scene specs → merged spec`, with:
- scene-id namespacing per chapter, and a collision check on merge
- a **style contract** (brand kit + preset vocabulary + established terminology) carried into
  every chapter request, so chapter 7 looks like chapter 1
- a running summary of what prior chapters covered, so the model does not re-explain
- per-chapter validation, so a failure costs one chapter and not the whole generation

**4. Brand kit / project config.**
`claudevid.config.ts` — palette, font families, logo, lower-third template, intro/outro scene
templates, default profile, TTS voice. Injected into both the renderer defaults and the director
prompt, so Claude composes *within* the brand rather than inventing colours.

**5. Claude director prompt, generated not hand-written.**
`packages/claude/prompts/video-director.md` is assembled at build time from the live preset
catalogue (change 003), the code-layer capabilities (change 004), and the brand kit. A
hand-maintained prompt drifts from the library within two releases and starts asking for
capabilities that no longer exist — this is the same failure mode as a hand-written JSON Schema,
and it gets the same fix.

**6. Claude Code skill.**
`.claude/skills/video-generator/` exactly as the doc specifies — `SKILL.md`, `schemas/`
(generated and committed, since the skill must read it without a build step), `examples/`
(simple-title, code-demo, tutorial, vertical-short), `scripts/validate.ts`, `scripts/render.ts`.
This is what makes the library good to use *from Claude Code*, which is the doc's stated
distribution channel.

## Scope

### In Scope

- `packages/cli/src/` — command implementations, arg parsing, progress rendering, exit codes
- `packages/cli/src/config.ts` — `claudevid.config.ts` loading, brand kit resolution
- `packages/claude/src/generate.ts` — Anthropic client, structured output, bounded repair loop
- `packages/claude/src/chapters.ts` — outline → chapters → merge, id namespacing, style contract
- `packages/claude/prompts/` — director prompt assembly from live catalogues
- `packages/claude/schemas/video-spec.schema.json` — generated + committed
- `packages/claude/examples/` — worked example specs
- `.claude/skills/video-generator/` — SKILL.md, scripts, schemas, examples
- `templates/` — `init` scaffolding
- Tests: repair-loop convergence on seeded-invalid specs, chapter merge id collisions, exit codes,
  a smoke test that `init → generate → render` produces a playable file

### Out of Scope

- Web UI, timeline editor, or hosted service
- MCP server exposing the renderer as tools (plausible follow-on)
- Remotion project export for complex scenes (the doc floats it; not v1)
- Direct upload to YouTube/TikTok/etc.
- Multi-model support (OpenAI/Gemini directors) — Claude-first is the product thesis

## Impact

- **Files affected:** ~24 new
- **Complexity:** medium-large
- **Risk:** medium — mostly integration risk. It is the first change where all six others run
  together, so it is where cross-change assumptions (frame timing, audio durations, chunk
  boundaries, cache locations) get tested for real.

## Open Questions

- **API credentials.** Require `ANTHROPIC_API_KEY`, or detect and reuse an existing Claude Code
  session when invoked from inside one? The latter is much nicer for the doc's primary audience
  but couples the CLI to a host environment.
- **Default model.** Which Claude model id is the default director, and how do we keep that
  current without a release for every model launch? A config default plus `--model` override.
- **Repair attempt budget.** How many? Three is conventional; long-video chapter generation may
  want more since a chapter is expensive to lose. What is the failure output — the last
  diagnostics, or every attempt's diagnostics?
- **Committed vs generated schema.** The Claude Code skill needs the JSON Schema on disk with no
  build step, so it must be committed. What stops it going stale — a CI check that regenerates
  and diffs?
- **Brand kit format.** TypeScript config (typed, but requires a loader) vs JSON (dumb, but
  trivially readable by the model and by the skill). Possibly JSON with a TS type.
- **Does `generate` render by default?** Generating and then rendering a 30-minute video from one
  command is a very expensive accident. **Recommendation: `generate` writes the spec and stops**;
  `--render` opts in.
- **Batch failure policy.** In `claudevid batch`, does one failed job abort the queue or get
  recorded and skipped? Skipping is right for overnight jobs; aborting is right for CI.

---

**To proceed:** Review this proposal and approve to begin planning.
