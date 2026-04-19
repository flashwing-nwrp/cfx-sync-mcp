/**
 * Content signature scorer (Layer 1 of Phase 1.5 preservation).
 *
 * Scores a Lua file 0..1 by how "config-like" its *shape* is. Called by
 * scanConfigs.ts (Task 11) to catch author-chosen config paths that don't
 * match the standard path allowlist (e.g. `data/prices.lua`). Path patterns
 * are the primary signal; content signature is the advisory fallback.
 *
 * Heuristic, not a real parser. We tokenize by regex over line-stripped source.
 *
 * Positive signals (score up):
 *   - table-open lines (`Config = {`, `return {`, `local X = {`, `foo = {`)
 *   - key-value lines (`foo = 1,`, `name = 'lspd',`, `{ id = 1, name = 'x' },`)
 *   - overall brace depth (lots of `{` tokens → deeply nested tables)
 *
 * Negative signals (score down):
 *   - function definitions (`function foo(`, `= function(`, `local function`)
 *   - `require(...)` / `dofile(...)` calls
 *   - imperative keywords (`if`, `for`, `while`, `repeat`) — rare in pure config
 *
 * Noise filter (neither signal):
 *   - pure structural lines (`}`, `},`, `end`) are excluded from both
 *     numerator and denominator so pretty-printed configs aren't punished.
 *
 * Weights were prototype-tuned in Task 10. A reconcile-pass calibration
 * (Apr 2026) re-ran the 50-file labeled FLRP corpus through THIS scorer
 * and picked LAYER_1_THRESHOLD = 0.60 based on the production-realistic
 * confusion matrix (data/** path-excluded). See tests/fixtures/calibration/
 * for the corpus + results, and Appendix A-bis in the preservation design
 * spec for the threshold-choice narrative.
 */

import { readFile } from "node:fs/promises";

// ----- Tunable constants (calibrated against labeled FLRP corpus) ----------

/**
 * Score ≥ LAYER_1_THRESHOLD → treat as config-like when the path doesn't match
 * a standard config pattern.
 *
 * CALIBRATED: 0.60 (Apr 2026 reconcile pass). On the production-realistic
 * corpus (data/** path-excluded, 25 files: 13 config + 12 logic), this
 * scorer produces precision=1.000 at every threshold 0.5..0.8 (no logic
 * file scores above 0.06 — huge separation). Recall peaks at 0.846 for
 * thresholds ≤ 0.60, drops to 0.769 at 0.70 and 0.615 at 0.80. We pick
 * 0.60: maximizes F1 (0.917), keeps perfect precision, and favors
 * false-negatives over false-positives per the Layer-1 advisory contract.
 *
 * See `tests/fixtures/calibration/results.md` + spec Appendix A-bis.
 */
export const LAYER_1_THRESHOLD = 0.6;

const WEIGHTS = {
  tableLine: 1.0, // line opens a table literal
  kvLine: 0.85, // line is a `key = value,` pair (strong config signal)
  braceDepth: 0.30, // per `{` token (capped)
  braceCap: 0.50, // cap on brace-depth contribution
  fnPenalty: 1.4, // per function definition (normalized by content lines)
  requirePenalty: 0.2, // flat penalty per require/dofile (capped)
  requireCap: 0.35,
  imperativePenalty: 0.6, // per imperative keyword (normalized)
} as const;

// ----- Public API ----------------------------------------------------------

/**
 * Score Lua source text in [0, 1]. Higher = more config-like.
 * Pure: no fs access, no globals, deterministic.
 *
 * Caller guarantees the input is valid UTF-8 Lua source. `scoreFile`
 * handles the encrypted/non-readable cases by returning null before
 * delegating here.
 */
export function scoreContent(luaSource: string): number {
  // Strip a possible BOM then normalize line endings for counting.
  const src = luaSource.replace(/^\uFEFF/, "");
  const rawLines = src.split(/\r?\n/);

  // We only count "content" lines — non-blank, not pure comments.
  // Block comments (`--[[ ... ]]`) are rare and we accept a little noise.
  let contentLines = 0;
  let tableLines = 0;
  let kvLines = 0;
  let fnCount = 0;
  let requireLikeCount = 0;
  let imperativeCount = 0;
  let openBraceCount = 0;

  for (const rawLine of rawLines) {
    const line = stripLineComment(rawLine).trim();
    if (line.length === 0) continue;

    // Pure structural lines (just `}`, `},`, `end`) are scaffolding and carry
    // no signal either way. Exclude from both numerators and denominator —
    // otherwise pretty-printed config looks much less "config-like" than
    // densely-written config.
    if (RE_STRUCTURAL_ONLY.test(line)) continue;

    contentLines++;

    // Function definitions first — the `= function(` form would otherwise
    // match RE_TABLE_OPEN / RE_KV_LINE and pollute positive signals.
    const isFn = RE_FUNCTION_DEF.test(line);
    if (isFn) {
      fnCount++;
    } else if (RE_TABLE_OPEN.test(line)) {
      tableLines++;
    } else if (RE_KV_LINE.test(line)) {
      kvLines++;
    }

    // Count all `{` tokens on the line (nested table depth signal).
    openBraceCount += (line.match(/\{/g) ?? []).length;

    // require('x'), dofile('x'), loadfile('x')
    if (RE_REQUIRE_LIKE.test(line)) requireLikeCount++;

    // Leading imperative keywords (not 'end', which also appears in tables).
    if (RE_IMPERATIVE.test(line)) imperativeCount++;
  }

  if (contentLines === 0) return 0;

  // Positive contributions.
  const tableness = (WEIGHTS.tableLine * tableLines) / contentLines;
  const kvness = (WEIGHTS.kvLine * kvLines) / contentLines;
  const depthSignal = Math.min(
    WEIGHTS.braceCap,
    WEIGHTS.braceDepth * (openBraceCount / contentLines),
  );

  // Negative contributions (normalized by content lines so short files
  // with one function aren't slammed the same as a 200-line logic file).
  const fnWeight = (WEIGHTS.fnPenalty * fnCount) / contentLines;
  const requireWeight = Math.min(
    WEIGHTS.requireCap,
    WEIGHTS.requirePenalty * requireLikeCount,
  );
  const imperativeWeight =
    (WEIGHTS.imperativePenalty * imperativeCount) / contentLines;

  const raw =
    tableness +
    kvness +
    depthSignal -
    fnWeight -
    requireWeight -
    imperativeWeight;

  return clamp01(raw);
}

/**
 * Score a file by path. Returns null for non-Lua files (`.fxap` encrypted
 * bytecode), missing files, or any read error — caller interprets null as
 * "don't score, don't preserve via content-sig."
 */
export async function scoreFile(path: string): Promise<number | null> {
  if (!path.toLowerCase().endsWith(".lua")) {
    return null;
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  return scoreContent(text);
}

// ----- Internals -----------------------------------------------------------

/** Strip a `--` line comment, being careful not to chop inside a string.
 *  This is a cheap approximation — we don't try to handle every edge case
 *  (escaped quotes, long brackets). Good enough for a shape heuristic.
 */
function stripLineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const prev = i > 0 ? line[i - 1] : "";
    if (ch === "'" && prev !== "\\" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && prev !== "\\" && !inSingle) inDouble = !inDouble;
    else if (
      ch === "-" &&
      i + 1 < line.length &&
      line[i + 1] === "-" &&
      !inSingle &&
      !inDouble
    ) {
      return line.slice(0, i);
    }
  }
  return line;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ----- Regexes (compiled once) --------------------------------------------

/** Line opens a table literal. Covers the most common FiveM config shapes. */
const RE_TABLE_OPEN =
  /^(?:return\s*\{|(?:local\s+)?[A-Za-z_][\w.]*\s*=\s*\{|\[[^\]]+\]\s*=\s*\{|\{)/;

/**
 * Line is a `key = value` pair typical of pretty-printed table entries.
 * Matches: `foo = 1,`, `name = 'lspd',`, `[1] = 'x',`, `foo = true`, and
 * inline-table rows like `{ name = 'lspd', label = 'LSPD' },`.
 * Does NOT match `require(...)` or statements with function calls in the RHS —
 * we keep the value side deliberately simple (strings, numbers, booleans, tables).
 */
const RE_KV_LINE =
  /^(?:\{\s*)?(?:\[[^\]]+\]|[A-Za-z_][\w]*)\s*=\s*(?:[-+]?[\d.]+|true|false|nil|'[^']*'|"[^"]*"|\{.*\}?)\s*,?\s*\}?\s*,?$/;

/**
 * Line is pure structural scaffolding carrying no signal either way:
 * `}`, `},`, `})`, `end`, `end)`. Excluded from both numerator and denominator
 * so that pretty-printed configs aren't punished vs one-line configs.
 */
const RE_STRUCTURAL_ONLY = /^(?:\}[\s,)]*|end[\s,)]*)$/;

/** Function definition: `function foo(`, `local function foo(`, `= function(`. */
const RE_FUNCTION_DEF =
  /(^|\s|=|,)function\s*(?:[A-Za-z_][\w.:]*\s*)?\(|local\s+function\s+[A-Za-z_]/;

/** require('x'), dofile('x'), loadfile('x'). */
const RE_REQUIRE_LIKE = /\b(?:require|dofile|loadfile)\s*[('"]/;

/** Leading imperative keyword — a strong "this is logic" signal. */
const RE_IMPERATIVE = /^(?:if|for|while|repeat|do|elseif)\b/;
