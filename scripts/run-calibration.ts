#!/usr/bin/env node
// Layer-1 content-signature calibration runner.
//
// Purpose: calibrate the threshold that separates "likely-config" Lua files
// from logic / data / encrypted files. See spec §Layer 1 Detection rules.
//
// RECONCILE PASS (Apr 2026): Task 0 originally prototyped its own inline
// scorer here and picked LAYER_1_THRESHOLD = 0.6 against that scorer. Task 10
// shipped a richer production scorer in flrp-resource-preservation (contentSignature module)
// whose weights differ meaningfully, so Task 0's number no longer applies.
//
// This script now imports the production scorer directly and re-runs the
// same labeled-files.json corpus so the threshold is calibrated against the
// scorer that actually ships. The harness (fixture load, pre-filter,
// confusion-matrix plumbing, per-file table) is preserved from Task 0.
//
// USAGE:
//   npx tsx scripts/run-calibration.ts
//
// Deterministic: same input tree, same labeled-files.json, same output.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreContent } from "flrp-resource-preservation";

// ---------------------------------------------------------------------------
// Encrypted / non-Lua guard — decides whether to score or return null.
// Preserved at the harness level (NOT inside scoreContent) because the
// production scorer is a pure function on Lua source text — it doesn't
// know about file paths or binary content. The calibration corpus labels
// .fxap / encrypted folders explicitly; those must be excluded from the
// matrix as "unscorable".
// ---------------------------------------------------------------------------

function isEncryptedOrBinary(filePath: string, sample: Buffer): boolean {
  if (filePath.endsWith(".fxap")) return true;
  if (filePath.toLowerCase().includes(`${path.sep}encrypted${path.sep}`)) return true;
  // Also guard against unix-style separators (labels use forward slashes).
  if (filePath.toLowerCase().includes("/encrypted/")) return true;
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
      out.push({ ...f, score: null });
      continue;
    }
    // Fast-path for known-encrypted labels — skip reading if possible.
    if (f["is-encrypted"]) {
      out.push({ ...f, score: null });
      continue;
    }
    const sample = fs.readFileSync(abs);
    if (isEncryptedOrBinary(abs, sample)) {
      out.push({ ...f, score: null });
      continue;
    }
    // Only score .lua-ish files; the production scorer takes Lua source text.
    if (!abs.toLowerCase().endsWith(".lua")) {
      out.push({ ...f, score: null });
      continue;
    }
    const content = sample.toString("utf8");
    const score = scoreContent(content);
    out.push({ ...f, score });
  }
  return out;
}

function writeResults(scored: ScoredFile[], matrices: ConfusionMatrix[]): void {
  const lines: string[] = [];
  lines.push("# Calibration Results — Layer 1 Content-Signature Scorer\n");
  lines.push("Generated by `scripts/run-calibration.ts` against `tests/fixtures/calibration/labeled-files.json`.");
  lines.push("Regenerate with `npx tsx scripts/run-calibration.ts`.\n");
  lines.push("**Scorer measured: Task 10 production scorer at `src/lib/preservation/contentSignature.ts` (commit `e86e172`).**");
  lines.push("This replaces Task 0's prototype scorer. See Appendix A-bis in the preservation design spec for the reconcile-pass narrative.\n");

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
  lines.push(`| Path | Label | Score |`);
  lines.push(`|---|---|---|`);
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
    lines.push(`| \`${f.path}\` | ${label} | ${s} |`);
  }
  lines.push("");

  lines.push(`## Chosen threshold\n`);
  lines.push(`See Appendix A-bis in the spec (\`docs/superpowers/specs/2026-04-18-cfx-sync-preservation-design.md\`) for the reconcile-pass narrative. The threshold constant lives at \`src/lib/preservation/contentSignature.ts\` → \`LAYER_1_THRESHOLD\`.\n`);
  lines.push(`Generated: ${new Date().toISOString().slice(0, 10)}`);

  fs.writeFileSync(RESULTS_PATH, lines.join("\n"), "utf8");
  process.stderr.write(`[cfx-sync][calibration] wrote ${RESULTS_PATH}\n`);
}

function main(): void {
  const labeled = readLabeled();
  const scored = scoreAll(labeled);
  const thresholds = [0.5, 0.6, 0.7, 0.8];
  const matrices = thresholds.map((t) => confusion(scored, t));
  const matricesResidue = thresholds.map((t) => confusionExcludingData(scored, t));
  writeResults(scored, matrices);

  // Console summary for quick inspection.
  process.stderr.write(`\n== Full corpus ==\n`);
  process.stderr.write(`Threshold | TP | FP | TN | FN | Precision | Recall | F1\n`);
  for (const m of matrices) {
    process.stderr.write(
      `${m.threshold.toFixed(2)}      | ${m.tp}  | ${m.fp}  | ${m.tn}  | ${m.fn}  | ${m.precision.toFixed(3)}    | ${m.recall.toFixed(3)}  | ${m.f1.toFixed(3)}\n`,
    );
  }
  process.stderr.write(`\n== Production-realistic (data/** excluded) ==\n`);
  process.stderr.write(`Threshold | TP | FP | TN | FN | Precision | Recall | F1\n`);
  for (const m of matricesResidue) {
    process.stderr.write(
      `${m.threshold.toFixed(2)}      | ${m.tp}  | ${m.fp}  | ${m.tn}  | ${m.fn}  | ${m.precision.toFixed(3)}    | ${m.recall.toFixed(3)}  | ${m.f1.toFixed(3)}\n`,
    );
  }
}

// Invoke only when run directly, not on import.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
