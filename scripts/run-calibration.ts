#!/usr/bin/env node
// Prototype Layer-1 content-signature scorer + calibration runner.
//
// Purpose: calibrate the threshold that separates "likely-config" Lua files
// from logic / data / encrypted files. See spec §Layer 1 Detection rules.
//
// Throwaway: this script becomes `src/lib/preservation/contentSignature.ts`
// in Task 10. The scoring function + LAYER_1_THRESHOLD constant are the
// only bits that graduate. Sampling / confusion-matrix plumbing stays here.
//
// USAGE:
//   npx tsx scripts/run-calibration.ts
//
// Deterministic: seeded PRNG + stable readdir ordering. Same input tree,
// same labeled-files.json, same output.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constant that graduates to src/lib/preservation/contentSignature.ts
// ---------------------------------------------------------------------------
export const LAYER_1_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Scorer — simple regex/tokenizer that returns a 0..1 "likely config" score.
// Returns null for non-parseable input (binary / encrypted / empty).
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  score: number | null;
  totalLines: number;
  codeLines: number;
  tableAssignLines: number;
  functionLines: number;
  requireLines: number;
}

// Line classifiers — applied in order; each line gets at most one category.
const RE_BLANK = /^\s*$/;
const RE_LINE_COMMENT = /^\s*--/;
const RE_BLOCK_COMMENT_OPEN = /--\[\[/;
const RE_BLOCK_COMMENT_CLOSE = /\]\]/;

// Config-ish structural lines:
//   Config = { / Config.X = { / return { / local cfg = { / X = { inside table
//   { key = val, } / ['key'] = val, / [1] = val,
//   Foo.bar = 'baz' (dotted-key config assignment at file scope)
//   Foo[key] = 'baz' (bracket-key config assignment)
//   return Foo (config-idiomatic return-identifier tail; do NOT treat as logic)
// We also count quoted-key and bracketed-key lines inside tables.
const RE_TABLE_OPEN_ASSIGN = /^\s*(?:local\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*=\s*\{/;
const RE_RETURN_TABLE = /^\s*return\s*\{/;
const RE_RETURN_IDENT = /^\s*return\s+[A-Za-z_][A-Za-z0-9_.]*\s*$/;
const RE_KV_PAIR =
  // Allow LHS: identifier / identifier.path / identifier[key]; RHS cannot start with `==`.
  /^\s*(?:\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]+\])*)\s*=\s*[^=]/;
const RE_STRING_LIST_ITEM = /^\s*(?:['"`]|\{)/; // quoted string item or nested table start
const RE_NUMERIC_LIST_ITEM = /^\s*-?\d+(?:\.\d+)?\s*,?\s*$/;
const RE_CLOSING_BRACE = /^\s*[}\])]+[,;]?\s*$/;

// Function-body signals:
const RE_FUNCTION_KEYWORD = /\bfunction\b/;
// Note: `return <identifier>` is handled by RE_RETURN_IDENT above (config-idiomatic).
// This regex catches `if`, `for`, `while`, `repeat`, `elseif`, `else`, `end`, `do`, `then`,
// and plain `return` (bare or with expression) — but RE_RETURN_IDENT short-circuits first.
const RE_CONTROL_FLOW = /\b(?:if|for|while|repeat|elseif|else\b|end\b|do\b|then\b|return\b)\b/;
// Call expressions that indicate logic (but `return {` above is already eaten).
const RE_FUNCTION_CALL =
  /[A-Za-z_][A-Za-z0-9_.]*\s*\(/;

// require / dofile / import signals:
const RE_REQUIRE = /\b(?:require|dofile|loadfile|load)\s*\(/;

function classifyLine(line: string): "blank" | "comment" | "table" | "function" | "require" | "other" {
  if (RE_BLANK.test(line)) return "blank";
  if (RE_LINE_COMMENT.test(line)) return "comment";

  // Require / dofile → logic-file signal (short-circuit before table-match).
  if (RE_REQUIRE.test(line)) return "require";

  // Function keyword anywhere on the line → logic-file signal. Even inside a
  // table, an inline `fn = function() ... end` is a function definition.
  if (RE_FUNCTION_KEYWORD.test(line)) return "function";

  // Table assignments / return table / kv pairs / config-idiomatic return <ident>.
  if (
    RE_TABLE_OPEN_ASSIGN.test(line) ||
    RE_RETURN_TABLE.test(line) ||
    RE_RETURN_IDENT.test(line) ||
    RE_KV_PAIR.test(line) ||
    RE_STRING_LIST_ITEM.test(line) ||
    RE_NUMERIC_LIST_ITEM.test(line) ||
    RE_CLOSING_BRACE.test(line)
  ) {
    return "table";
  }

  // Control flow without function keyword still suggests logic.
  if (RE_CONTROL_FLOW.test(line) || RE_FUNCTION_CALL.test(line)) {
    return "function";
  }

  return "other";
}

export function scoreLuaContent(content: string): ScoreBreakdown {
  // Null score for empty / whitespace-only.
  if (!content || content.trim().length === 0) {
    return { score: null, totalLines: 0, codeLines: 0, tableAssignLines: 0, functionLines: 0, requireLines: 0 };
  }

  const rawLines = content.split(/\r?\n/);
  let inBlockComment = false;
  let blank = 0;
  let comment = 0;
  let table = 0;
  let func = 0;
  let req = 0;
  let other = 0;

  for (const line of rawLines) {
    // Strip block comments (naive — multi-line --[[ ... ]]).
    if (inBlockComment) {
      comment++;
      if (RE_BLOCK_COMMENT_CLOSE.test(line)) inBlockComment = false;
      continue;
    }
    if (RE_BLOCK_COMMENT_OPEN.test(line) && !RE_BLOCK_COMMENT_CLOSE.test(line)) {
      inBlockComment = true;
      comment++;
      continue;
    }

    switch (classifyLine(line)) {
      case "blank": blank++; break;
      case "comment": comment++; break;
      case "table": table++; break;
      case "function": func++; break;
      case "require": req++; break;
      case "other": other++; break;
    }
  }

  const totalLines = rawLines.length;
  const codeLines = table + func + req + other;

  if (codeLines === 0) {
    return { score: null, totalLines, codeLines: 0, tableAssignLines: table, functionLines: func, requireLines: req };
  }

  // Score components:
  //   tableRatio   = table / codeLines        → push toward config
  //   functionPenalty = (func / codeLines)    → push toward logic
  //   requirePenalty  = min(1, req * 0.25)    → any require pulls ~0.25 off
  //
  // Weighted combination chosen so that:
  //   - Pure return-table file (100% table, 0% func, 0% req) → ~1.0
  //   - 50/50 split → ~0.5 (ambiguous, below 0.6 threshold)
  //   - Heavy logic (80% func) → ~0.15
  //   - Config with one require at top → docked ~0.10 but still configish
  const tableRatio = table / codeLines;
  const functionPenalty = func / codeLines;
  const requirePenalty = Math.min(1, req * 0.25);

  const raw = tableRatio - 0.9 * functionPenalty - 0.4 * requirePenalty;
  // Clamp to [0, 1].
  const score = Math.max(0, Math.min(1, raw));

  return {
    score,
    totalLines,
    codeLines,
    tableAssignLines: table,
    functionLines: func,
    requireLines: req,
  };
}

// ---------------------------------------------------------------------------
// Encrypted / non-Lua guard — decides whether to score or return null.
// ---------------------------------------------------------------------------

function isEncryptedOrBinary(filePath: string, sample: Buffer): boolean {
  if (filePath.endsWith(".fxap")) return true;
  if (filePath.toLowerCase().includes(`${path.sep}encrypted${path.sep}`)) return true;
  // NUL-byte → binary.
  for (let i = 0; i < Math.min(sample.length, 1024); i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Calibration runner — labeled-files.json + confusion-matrix per threshold.
// ---------------------------------------------------------------------------

interface LabeledFile {
  path: string;              // repo-root-relative, uses forward slashes
  "is-config": boolean;
  "is-logic": boolean;
  "is-data": boolean;
  "is-encrypted": boolean;
  notes?: string;
}

interface ScoredFile extends LabeledFile {
  score: number | null;
  breakdown: ScoreBreakdown;
}

interface ConfusionMatrix {
  threshold: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

function confusion(scored: ScoredFile[], threshold: number): ConfusionMatrix {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const f of scored) {
    if (f.score === null) continue; // encrypted / unparseable; exclude per spec
    const positive = f.score >= threshold;
    if (f["is-config"]) {
      if (positive) tp++; else fn++;
    } else {
      if (positive) fp++; else tn++;
    }
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { threshold, tp, fp, tn, fn, precision, recall, f1 };
}

// Production-realistic matrix: in prod, path rules exclude `data/**` before the
// content-signature runs. This excludes is-data files (data-path stratum) so the
// matrix reflects the residue the scorer will actually see: config vs logic.
function confusionExcludingData(scored: ScoredFile[], threshold: number): ConfusionMatrix {
  const residue = scored.filter((f) => !f["is-data"]);
  return confusion(residue, threshold);
}

// ---------------------------------------------------------------------------
// Entry point — reads labeled-files.json, scores each, writes results.md.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const FLRP_ROOT = path.resolve(REPO_ROOT, "..");
const CAL_DIR = path.join(REPO_ROOT, "tests/fixtures/calibration");
const LABELS_PATH = path.join(CAL_DIR, "labeled-files.json");
const RESULTS_PATH = path.join(CAL_DIR, "results.md");

function readLabeled(): LabeledFile[] {
  if (!fs.existsSync(LABELS_PATH)) {
    throw new Error(`Missing ${LABELS_PATH} — create the fixture first.`);
  }
  const raw = fs.readFileSync(LABELS_PATH, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("labeled-files.json must be an array");
  return parsed as LabeledFile[];
}

function scoreAll(labeled: LabeledFile[]): ScoredFile[] {
  const out: ScoredFile[] = [];
  for (const f of labeled) {
    const abs = path.join(FLRP_ROOT, f.path);
    if (!fs.existsSync(abs)) {
      out.push({
        ...f,
        score: null,
        breakdown: { score: null, totalLines: 0, codeLines: 0, tableAssignLines: 0, functionLines: 0, requireLines: 0 },
      });
      continue;
    }
    const sample = fs.readFileSync(abs);
    if (isEncryptedOrBinary(abs, sample)) {
      out.push({
        ...f,
        score: null,
        breakdown: { score: null, totalLines: 0, codeLines: 0, tableAssignLines: 0, functionLines: 0, requireLines: 0 },
      });
      continue;
    }
    const content = sample.toString("utf8");
    const breakdown = scoreLuaContent(content);
    out.push({ ...f, score: breakdown.score, breakdown });
  }
  return out;
}

function writeResults(scored: ScoredFile[], matrices: ConfusionMatrix[]): void {
  const lines: string[] = [];
  lines.push("# Calibration Results — Layer 1 Content-Signature Scorer\n");
  lines.push("Generated by `scripts/run-calibration.ts` against `tests/fixtures/calibration/labeled-files.json`.");
  lines.push("Regenerate with `npx tsx scripts/run-calibration.ts`.\n");

  const scorable = scored.filter((f) => f.score !== null);
  const nulls = scored.filter((f) => f.score === null);
  lines.push(`## Corpus\n`);
  lines.push(`- Labeled files: ${scored.length}`);
  lines.push(`- Scorable (Lua, non-encrypted): ${scorable.length}`);
  lines.push(`- Null-scored (encrypted / binary / missing): ${nulls.length}`);
  const configs = scored.filter((f) => f["is-config"]).length;
  const logic = scored.filter((f) => f["is-logic"]).length;
  const data = scored.filter((f) => f["is-data"]).length;
  const enc = scored.filter((f) => f["is-encrypted"]).length;
  lines.push(`- Stratum counts (labels): config=${configs}, logic=${logic}, data=${data}, encrypted=${enc}\n`);

  lines.push(`## Confusion matrix per threshold — full corpus\n`);
  lines.push(`Null-scored files (encrypted / empty) are excluded from metrics — they cannot be classified by this heuristic and are guarded before scoring. Everything else is in.\n`);
  lines.push(`| Threshold | TP | FP | TN | FN | Precision | Recall | F1 |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const m of matrices) {
    lines.push(
      `| ${m.threshold.toFixed(2)} | ${m.tp} | ${m.fp} | ${m.tn} | ${m.fn} | ${m.precision.toFixed(3)} | ${m.recall.toFixed(3)} | ${m.f1.toFixed(3)} |`,
    );
  }
  lines.push("");

  const matricesResidue = [0.5, 0.6, 0.7, 0.8].map((t) => confusionExcludingData(scored, t));
  lines.push(`## Confusion matrix per threshold — production-realistic (data/** path-excluded)\n`);
  lines.push(`In production the content-signature rule only fires on files NOT caught by path rules (§Layer 1). \`data/**\` is explicitly off the path list AND excluded here, so this matrix reflects what the scorer actually sees: config-candidate Lua vs logic Lua. This is the matrix the threshold is chosen against.\n`);
  lines.push(`| Threshold | TP | FP | TN | FN | Precision | Recall | F1 |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const m of matricesResidue) {
    lines.push(
      `| ${m.threshold.toFixed(2)} | ${m.tp} | ${m.fp} | ${m.tn} | ${m.fn} | ${m.precision.toFixed(3)} | ${m.recall.toFixed(3)} | ${m.f1.toFixed(3)} |`,
    );
  }
  lines.push("");

  lines.push(`## Per-file scores\n`);
  lines.push(`| Path | Label | Score | Table | Func | Req | CodeLines |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const f of scored) {
    const label = f["is-config"]
      ? "config"
      : f["is-encrypted"]
        ? "encrypted"
        : f["is-data"]
          ? "data"
          : f["is-logic"]
            ? "logic"
            : "other";
    const s = f.score === null ? "null" : f.score.toFixed(3);
    lines.push(
      `| \`${f.path}\` | ${label} | ${s} | ${f.breakdown.tableAssignLines} | ${f.breakdown.functionLines} | ${f.breakdown.requireLines} | ${f.breakdown.codeLines} |`,
    );
  }
  lines.push("");

  lines.push(`## Chosen threshold\n`);
  lines.push(`See Appendix A in the spec (\`docs/superpowers/specs/2026-04-18-cfx-sync-preservation-design.md\`) for the narrative justification. \`LAYER_1_THRESHOLD = ${LAYER_1_THRESHOLD}\` exported from \`scripts/run-calibration.ts\` (graduates to \`src/lib/preservation/contentSignature.ts\` in Task 10).\n`);

  fs.writeFileSync(RESULTS_PATH, lines.join("\n"), "utf8");
  process.stderr.write(`[cfx-sync][calibration] wrote ${RESULTS_PATH}\n`);
}

function main(): void {
  const labeled = readLabeled();
  const scored = scoreAll(labeled);
  const thresholds = [0.5, 0.6, 0.7, 0.8];
  const matrices = thresholds.map((t) => confusion(scored, t));
  writeResults(scored, matrices);

  // Console summary for quick inspection.
  process.stderr.write(`\nThreshold | TP | FP | TN | FN | Precision | Recall | F1\n`);
  for (const m of matrices) {
    process.stderr.write(
      `${m.threshold.toFixed(2)}      | ${m.tp}  | ${m.fp}  | ${m.tn}  | ${m.fn}  | ${m.precision.toFixed(3)}    | ${m.recall.toFixed(3)}  | ${m.f1.toFixed(3)}\n`,
    );
  }
  process.stderr.write(`\nLAYER_1_THRESHOLD = ${LAYER_1_THRESHOLD}\n`);
}

// Invoke only when run directly, not on import.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
