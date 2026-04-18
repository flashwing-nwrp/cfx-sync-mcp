# Calibration Methodology — Layer 1 Content-Signature Scorer

This directory pins the `LAYER_1_THRESHOLD` used by the Layer 1 content-signature scan in cfx-sync-mcp Phase 1.5 (customization preservation). The threshold is derived from 50 real FLRP files, not picked by intuition.

## Goal

The spec §Layer 1 Detection rules defines a 0..1 "likely-config" score per Lua file. The goal of calibration is to answer: **where should the threshold sit so the hint system has few false-positive hints (high precision) without dropping real configs (decent recall)?**

Layer 1 is advisory — it only surfaces hints in the conflict UX and future KB seeding. False negatives are tolerable (operators can add paths manually); false positives are worse (noise erodes trust). The calibration therefore targets **precision over recall**, subject to recall staying reasonable.

## Sampling

Stratified random sampling across four strata:

| Stratum | Target | Selection rule (path-based, applied to full FLRP `server/resources/` tree) |
|---|---|---|
| `config-path` | 13 | Basename in {config.lua, cfg.lua, shared.lua, permissions.lua, settings.lua} OR path contains a config/configs/cfg/settings/locales dir |
| `logic-path` | 13 | Path contains `server/` or `client/` directory (but NOT a config/locales subdir inside it) |
| `data-path` | 12 | Path contains `data/` directory |
| `encrypted-path` | 12 | `.fxap` file OR path contains `encrypted/` directory |

Seed for the PRNG is `20260418` (mulberry32) with deterministic alphabetical directory traversal. Given the same FLRP tree, `scripts/tmp-sample.mjs` (throwaway) produces the same 50 paths. Pool sizes at the time of sampling:

- config-path pool: 496 files
- logic-path pool: 2112 files
- data-path pool: 58 files
- encrypted-path pool: 183 files

50 picks is the target per the pre-work acceptance criteria. The 13/13/12/12 split is the near-even stratification (50 doesn't divide 4 evenly).

**Note:** "stratum" labels the bucket a file was SAMPLED from. The honest ground-truth labels (`is-config`, `is-logic`, `is-data`, `is-encrypted`) are assigned per-file after reading the content, and may disagree with the stratum. Two files in the `data-path` and `logic-path` strata turned out to be FXAP-encrypted despite their `.lua` extensions (`rcore_clothing/client/module/data/arms.lua` and `jg-mechanic/client/cl-tuning.lua`) — both relabeled `is-encrypted: true`.

## Labeling

Each file read and classified by primary intent. Rules:

- **is-config**: file's primary purpose is configuration values (operator knobs, locales, webhooks). Idiomatic shapes: `Config = { ... }`, `return { ... }`, `Locales['xx'] = { ... }`, `ClientFooConfig.bar = 'baz'`.
- **is-logic**: file's primary purpose is executable behavior (functions, threads, event handlers, glue, export wiring).
- **is-data**: file's primary purpose is a static catalog of values that authors ship and operators rarely customize (emote lists, weapon stats, mission definitions). Per spec §Layer 1, `data/**` is explicitly NOT on the path pattern list — Cfx packs legitimately update these between versions, so Layer 1 should not flag them.
- **is-encrypted**: `.fxap` file, any file starting with the `FXAP` magic bytes, or under `encrypted/` directory.

Exactly one primary label per file. Ambiguous cases (file builds a data table with a `for` loop — e.g., `flrp_ballistics/data/magazine_items.lua`) are labeled by the dominant output, not the code that produces it.

## Prototype scorer

`scripts/run-calibration.ts` implements the scorer. It is intentionally simple — regex/tokenizer per line, not a full Lua parser. Each non-blank non-comment line is classified as one of:

| Class | Weight | Signal |
|---|---|---|
| `table` | +1.0 (numerator) | `Foo = {`, `return {`, `return Foo`, `key = value`, quoted-string list item, closing brace |
| `function` | -0.9 * ratio | `function` keyword anywhere, or control-flow (`if`, `for`, `while`, etc.) / function-call patterns |
| `require` | -0.4 * min(1, n*0.25) | `require(...)`, `dofile(...)`, `loadfile(...)`, `load(...)` |
| `other` | 0 | Unclassified code line |
| `comment`, `blank` | excluded | Not counted in codeLines denominator |

Formula: `score = clamp(tableRatio - 0.9 * functionPenalty - 0.4 * requirePenalty, 0, 1)` where `tableRatio = tableLines / codeLines` and `functionPenalty = functionLines / codeLines`.

The weights were chosen so that:

- Pure `return { ... }` file with no logic → ~1.0
- 50/50 table/logic split → ~0.5 (ambiguous, below the 0.6 threshold)
- Heavy logic (80%+ function) → near 0
- Config that happens to `require` a sibling → docked ~0.1 per require (capped at 0.4)

**Encrypted / binary guard:** before scoring, the scorer checks for `.fxap` extension, an `encrypted/` path component, and the first 1KB for NUL bytes. Any match returns `score = null` (excluded from the confusion matrix; the row 10 `ENCRYPTED_TAMPER_DETECTED` logic in the diff engine handles these separately).

**Empty-file guard:** files with 0 code lines also return `null`.

## Running the calibration

```bash
cd cfx-sync-mcp
npx tsx scripts/run-calibration.ts
```

Writes `tests/fixtures/calibration/results.md`. Deterministic — same inputs produce the same numbers. The runner also prints the confusion matrices to stderr for quick inspection.

## Graduation to production

- `LAYER_1_THRESHOLD` (exported constant, currently `0.6`) moves verbatim into `src/lib/preservation/contentSignature.ts` in Task 10.
- The scorer functions (`classifyLine`, `scoreLuaContent`, `isEncryptedOrBinary`) also migrate, with the scoring branch becoming a proper unit-tested function (it is unit-tested by `run-calibration.ts` today only through the 50-file fixture).
- `labeled-files.json` remains in `tests/fixtures/calibration/` as a regression fixture so future scorer tweaks can re-run and verify the matrix doesn't regress.
- `scripts/run-calibration.ts` stays as the regression harness. CI does NOT run it (depends on the full FLRP tree one level up); operators run it manually when the scorer changes.

## What this methodology explicitly does NOT address

- **Generalization to other FLRP-style servers.** The sample is from one (large) FiveM server. A pack-author's own repo has different distributions. Calibrating across multiple operators is Phase 2 / future-KB territory.
- **Auto-labeling ambiguity.** Each label is one human's read. A second reviewer could disagree on the 2-3 edge cases (e.g., data files with small builder loops). This is acceptable for a hint-quality heuristic.
- **Score stability across scorer revisions.** If the scorer changes, the threshold might shift. Task 10's unit tests should pin the scorer's behavior on a minimal set of synthetic examples in addition to the fixture.
