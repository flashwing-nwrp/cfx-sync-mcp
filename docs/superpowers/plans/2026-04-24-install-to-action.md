# `install-to` Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `install-to` action to `cfx_resolve_mapping_entry` so operators can bind a grant to a prospective target path without requiring the target directory to exist, closing the gap that prevents `cfx_deploy_asset` from working on fresh new-install grants.

**Architecture:** Single new action on the existing `cfx_resolve_mapping_entry` MCP tool. Implements a 4-case decision tree (entry-missing-but-in-newInstalls → create; entry-with-status-new-install → upgrade; entry-active → reject; entry-missing-and-not-in-newInstalls → reject). No filesystem mutation; deploy's existing first-deploy / overlay branches handle target creation.

**Tech Stack:** TypeScript, Zod schemas, Vitest unit tests, existing cfx-sync-mcp `Mapping` / `ResolutionLog` / `PortalApiClient` libs.

**Spec:** `docs/superpowers/specs/2026-04-24-install-to-action-design.md` (commit `af1513d`)

---

## Task 1: Schema + ResolutionLog scaffolding

**Files:**
- Modify: `src/mcp/schemas/index.ts`
- Modify: `src/lib/state/resolutionLog.ts`

This task is type-system-only — extends enums and adds fields so subsequent tasks can call the new shape. No behavior yet. Verified by `tsc` build.

- [ ] **Step 1: Extend `ResolveMappingEntryInput` action enum and add new fields**

Open `src/mcp/schemas/index.ts`. Find the `ResolveMappingEntryInput` declaration. Add `"install-to"` to the action enum, and add optional `category` and `slug` fields:

```typescript
export const ResolveMappingEntryInput = z.object({
  grantId: z.number(),
  action: z.enum([
    "accept",
    "pick",
    "override",
    "skip",
    "new-install",
    "reactivate",
    "install-to",
  ]),
  pickIndex: z.number().int().nonnegative().optional(),
  overrideInput: z.string().optional(),
  allowRemapOver: z.string().optional(),
  category: z.string().optional(),
  slug: z.string().optional(),
});
```

Note: keep all existing fields exactly as they were (`pickIndex`, `overrideInput`, `allowRemapOver`). Only the action enum gets a new entry, and `category`/`slug` are appended.

- [ ] **Step 2: Extend `ResolveMappingEntryOutput.error` enum**

In the same file, find `ResolveMappingEntryOutput.error` and add the six new codes:

```typescript
error: z.enum([
  "no-proposal-to-accept",
  "pick-index-out-of-range",
  "target-owned-by-other-grant",
  "grantId-not-owned",
  "remap-requires-confirmation",
  "reactivate-invalid-state",
  "unexpected-field",
  "state-locked",
  "install-to-requires-new-install",
  "grantId-not-in-mapping",
  "category-invalid",
  "category-not-found",
  "slug-invalid",
  "slug-derivation-failed",
]).optional(),
```

- [ ] **Step 3: Extend `ResolutionLogEntry`**

Open `src/lib/state/resolutionLog.ts`. Add `"install-to"` to the action union AND add an optional `category` field:

```typescript
export interface ResolutionLogEntry {
  ts: string;
  grantId: number;
  author: string | null;
  assetName: string;
  action:
    | "accept"
    | "pick"
    | "override"
    | "skip"
    | "new-install"
    | "reactivate"
    | "auto-approve"
    | "remap"
    | "install-to";
  tierBefore: number | null;
  confidenceBefore: number | null;
  chosenBasename: string | null;
  overrideInput: string | null;
  category?: string | null;
}
```

- [ ] **Step 4: Build to verify type-system changes compile**

Run: `npm run build`
Expected: PASS, no TypeScript errors. Output ends with successful tsc completion.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/schemas/index.ts src/lib/state/resolutionLog.ts
git commit -m "feat(install-to): scaffold schema + log types

Extends ResolveMappingEntryInput action enum with 'install-to' and
adds optional category/slug fields. Adds 6 new error codes to the
output enum. Extends ResolutionLogEntry action union and adds an
optional category field for the install-to log row.

Type-system changes only; no behavior yet."
```

---

## Task 2: validateFieldsForAction expansion + cross-field test

**Files:**
- Modify: `src/mcp/tools/resolve_mapping_entry.ts:56-62`
- Create: `tests/unit/mcp/resolve_mapping_entry.install-to.test.ts`

- [ ] **Step 1: Create the new test file with setup scaffold**

Create `tests/unit/mcp/resolve_mapping_entry.install-to.test.ts`:

```typescript
/**
 * cfx_resolve_mapping_entry — install-to action tests.
 *
 * Covers the 4-case decision tree (entry-create / entry-upgrade / two reject
 * cases), category + slug validation, ownership conflict, and cross-field
 * field-matrix enforcement. See spec at
 * docs/superpowers/specs/2026-04-24-install-to-action-design.md.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Mapping } from "../../../src/lib/state/mapping.js";
import { PortalApiClient } from "../../../src/lib/portal/client.js";

describe("cfx_resolve_mapping_entry — install-to action", () => {
  let stateDir: string;
  let resourcesDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "rme-it-state-"));
    resourcesDir = await fs.mkdtemp(path.join(os.tmpdir(), "rme-it-res-"));

    process.env.CFX_STATE_DIR = stateDir;
    process.env.CFX_SERVER_RESOURCES = resourcesDir;
    process.env.CFX_CACHE_DIR = path.join(stateDir, "cache");
    process.env.CFX_STAGING_DIR = path.join(stateDir, "staging");
    process.env.CFX_BACKUP_DIR = path.join(stateDir, "backups");
    process.env.CFX_COOKIE_FILE = path.join(stateDir, ".cookies.json");
    await fs.writeFile(process.env.CFX_COOKIE_FILE, "{}");

    // Default portal stub — grant 100 is "BroFX Mansion 10" by BroFX.
    vi.spyOn(PortalApiClient.prototype, "listGrants").mockResolvedValue({
      grants: [{ grant_id: 100, asset: { name: "BroFX Mansion 10", author: "BroFX" } }] as any,
      page: 1,
      page_count: 1,
      item_count: 1,
    } as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(resourcesDir, { recursive: true, force: true });
  });

  /** Seed an empty mapping with grantId 100 in newInstalls (no MappingEntry row). */
  async function seedNewInstallQueue(): Promise<void> {
    const m = new Mapping(stateDir);
    m.approveFromProposed({});
    m.getFile().newInstalls = [100];
    await m.save();
  }

  /** Create the [maps] category dir on disk so category-not-found doesn't trigger. */
  async function ensureMapsCategory(): Promise<void> {
    await fs.mkdir(path.join(resourcesDir, "[maps]"), { recursive: true });
  }

  // Test 12 — fields on wrong action
  it("rejects category on non-install-to action", async () => {
    await seedNewInstallQueue();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100,
      action: "skip",
      category: "[maps]",
    } as any);
    expect(out.committed).toBe(false);
    expect((out as any).error).toBe("unexpected-field");
  });

  it("rejects slug on non-install-to action", async () => {
    await seedNewInstallQueue();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100,
      action: "accept",
      slug: "x",
    } as any);
    expect(out.committed).toBe(false);
    expect((out as any).error).toBe("unexpected-field");
  });

  it("rejects pickIndex on install-to action", async () => {
    await seedNewInstallQueue();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100,
      action: "install-to",
      category: "[maps]",
      pickIndex: 0,
    } as any);
    expect(out.committed).toBe(false);
    expect((out as any).error).toBe("unexpected-field");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/mcp/resolve_mapping_entry.install-to.test.ts`
Expected: FAIL on at least the first two ("rejects category/slug on non-install-to"). The third test may incidentally pass or fail depending on the existing handler's behavior on the unknown action — not what we're checking.

- [ ] **Step 3: Extend `validateFieldsForAction`**

Open `src/mcp/tools/resolve_mapping_entry.ts`. Find the function at lines ~56-62. Replace its body to add the install-to cross-field rules:

```typescript
function validateFieldsForAction(input: z.infer<typeof ResolveMappingEntryInput>): string | null {
  const { action, pickIndex, overrideInput, allowRemapOver, category, slug } = input;
  if (action !== "pick" && pickIndex !== undefined) return "pickIndex";
  if (action !== "override" && overrideInput !== undefined) return "overrideInput";
  if (!(action === "pick" || action === "override") && allowRemapOver !== undefined) return "allowRemapOver";
  if (action !== "install-to" && category !== undefined) return "category";
  if (action !== "install-to" && slug !== undefined) return "slug";
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/mcp/resolve_mapping_entry.install-to.test.ts`
Expected: All three tests in the file PASS (the install-to action handler doesn't exist yet, but `validateFieldsForAction` short-circuits before reaching it).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/resolve_mapping_entry.ts tests/unit/mcp/resolve_mapping_entry.install-to.test.ts
git commit -m "feat(install-to): cross-field validation matrix

Extends validateFieldsForAction so category/slug are only valid on
install-to, and install-to rejects pickIndex/overrideInput/allowRemapOver.
Three cross-field tests cover both directions."
```

---

## Task 3: Category & slug validation

**Files:**
- Modify: `src/mcp/tools/resolve_mapping_entry.ts` (add helpers + install-to skeleton)
- Modify: `tests/unit/mcp/resolve_mapping_entry.install-to.test.ts` (add Tests 7-10)

- [ ] **Step 1: Add the four validation tests to the test file**

Append inside the `describe(...)` block in `tests/unit/mcp/resolve_mapping_entry.install-to.test.ts`:

```typescript
  // Test 7 — category format
  it("rejects category with missing brackets", async () => {
    await seedNewInstallQueue();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "maps",
    });
    expect((out as any).error).toBe("category-invalid");
  });

  it("rejects category with traversal segments", async () => {
    await seedNewInstallQueue();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]/..",
    });
    expect((out as any).error).toBe("category-invalid");
  });

  it("rejects absolute category path", async () => {
    await seedNewInstallQueue();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "/etc",
    });
    expect((out as any).error).toBe("category-invalid");
  });

  // Test 8 — category not on disk
  it("rejects category that does not exist on disk", async () => {
    await seedNewInstallQueue();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[nonexistent]",
    });
    expect((out as any).error).toBe("category-not-found");
  });

  // Test 9 — slug regex
  it("rejects slug with path separator", async () => {
    await seedNewInstallQueue();
    await ensureMapsCategory();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]", slug: "a/b",
    });
    expect((out as any).error).toBe("slug-invalid");
  });

  it("rejects slug with leading underscore", async () => {
    await seedNewInstallQueue();
    await ensureMapsCategory();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]", slug: "_bad",
    });
    expect((out as any).error).toBe("slug-invalid");
  });

  it("rejects slug exceeding 60 chars", async () => {
    await seedNewInstallQueue();
    await ensureMapsCategory();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]", slug: "a".repeat(61),
    });
    expect((out as any).error).toBe("slug-invalid");
  });

  // Test 10 — slug derivation failed
  it("rejects when auto-derived slug is empty", async () => {
    await seedNewInstallQueue();
    await ensureMapsCategory();
    // Override the default portal mock — grant whose name slugifies to "".
    vi.spyOn(PortalApiClient.prototype, "listGrants").mockResolvedValue({
      grants: [{ grant_id: 100, asset: { name: "!!!", author: "BroFX" } }] as any,
      page: 1, page_count: 1, item_count: 1,
    } as any);
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]",
    });
    expect((out as any).error).toBe("slug-derivation-failed");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/mcp/resolve_mapping_entry.install-to.test.ts`
Expected: 8 tests FAIL with errors like `out.error` being `undefined` (because the install-to handler does not yet exist — the function falls through to the default `unexpected-field` return at the end).

- [ ] **Step 3: Add slugify helper and category validator**

Open `src/mcp/tools/resolve_mapping_entry.ts`. Add at module scope, near the existing `levenshtein` / `similarity` helpers (above `cfx_resolve_mapping_entry`):

```typescript
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
}

const SLUG_REGEX = /^[a-z0-9][a-z0-9_]{0,59}$/;
const CATEGORY_SEGMENT_REGEX = /^\[[^\]]+\]$/;

function validateCategory(category: string): "category-invalid" | "ok" {
  if (!category || category.length === 0) return "category-invalid";
  if (category.includes("..")) return "category-invalid";
  if (category.startsWith("/") || category.startsWith("\\")) return "category-invalid";
  // Windows drive-letter paranoia (e.g., "C:\\foo")
  if (/^[a-zA-Z]:[\\/]/.test(category)) return "category-invalid";
  const segments = category.split("/");
  for (const seg of segments) {
    if (!CATEGORY_SEGMENT_REGEX.test(seg)) return "category-invalid";
  }
  return "ok";
}
```

- [ ] **Step 4: Add minimal install-to handler skeleton (validation only, no commit yet)**

In the same file, add a new branch BEFORE the final `return fail("unexpected-field");` at the end of the function:

```typescript
    // -----------------------------------------------------------------------
    // install-to — bind a new-install grant to a prospective target path.
    // -----------------------------------------------------------------------
    if (input.action === "install-to") {
      // Validation order: category format → slug format → category exists on disk
      // → fetch grant → slug-derive → ownership guard → state-machine → commit.
      if (input.category === undefined) return fail("unexpected-field");
      if (validateCategory(input.category) !== "ok") return fail("category-invalid");
      if (input.slug !== undefined && !SLUG_REGEX.test(input.slug)) return fail("slug-invalid");

      const categoryAbs = path.resolve(cfg.serverResources, input.category);
      const rootAbs = path.resolve(cfg.serverResources);
      // Containment check (paranoia on top of the format guard)
      if (!(categoryAbs === rootAbs || categoryAbs.startsWith(rootAbs + path.sep))) {
        return fail("category-invalid");
      }
      try {
        const stat = await (await import("node:fs/promises")).stat(categoryAbs);
        if (!stat.isDirectory()) return fail("category-not-found");
      } catch {
        return fail("category-not-found");
      }

      if (!grant) return fail("grantId-not-owned");

      const finalSlug = input.slug ?? slugify(grant.asset.name);
      if (!finalSlug) return fail("slug-derivation-failed");

      // Remaining: state-machine + commit. Implemented in later tasks.
      return fail("install-to-requires-new-install");
    }
```

Also add the `import` for `fs/promises` at the top of the file if it isn't already imported (the file already has `fs` from `node:fs`; the dynamic import inside the handler avoids reordering existing imports).

- [ ] **Step 5: Run tests to verify the validation tests pass**

Run: `npm run test:unit -- tests/unit/mcp/resolve_mapping_entry.install-to.test.ts`
Expected:
- Tests 7 sub-cases (3 invalid category formats), 8 (category-not-found), 9 sub-cases (3 invalid slugs), 10 (slug-derivation-failed) → PASS.
- Cross-field tests from Task 2 still PASS.
- Tests 1-6, 11 (not yet written) absent.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/resolve_mapping_entry.ts tests/unit/mcp/resolve_mapping_entry.install-to.test.ts
git commit -m "feat(install-to): category + slug validation

Adds slugify helper (matches download_asset.ts), SLUG_REGEX, and
validateCategory helper. Install-to handler validates inputs but
returns install-to-requires-new-install for now (state machine in
the next task)."
```

---

## Task 4: Case A — entry creation (happy paths)

**Files:**
- Modify: `src/mcp/tools/resolve_mapping_entry.ts`
- Modify: `tests/unit/mcp/resolve_mapping_entry.install-to.test.ts`

- [ ] **Step 1: Add Tests 1, 2, 3 to the test file**

Append inside the `describe(...)` block:

```typescript
  // Test 1 — case A, auto-derived slug
  it("creates entry with auto-derived slug for grantId in newInstalls", async () => {
    await seedNewInstallQueue();
    await ensureMapsCategory();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]",
    });
    expect(out.committed).toBe(true);
    expect(out.entry).not.toBeNull();
    expect(out.entry!.slug).toBe("brofx_mansion_10");
    expect(out.entry!.target).toBe(path.join(resourcesDir, "[maps]", "brofx_mansion_10"));
    expect(out.entry!.status).toBe("active");
    expect(out.entry!.reviewedByUser).toBe(true);
    expect(out.entry!.discoveredConfidence).toBe(1);

    // newInstalls drained
    const m = new Mapping(stateDir);
    await m.load();
    expect(m.getFile().newInstalls).not.toContain(100);

    // resolution log row exists
    const log = await fs.readFile(path.join(stateDir, "resolution-log.jsonl"), "utf8");
    const rows = log.trim().split("\n").map((l) => JSON.parse(l));
    const installRow = rows.find((r) => r.action === "install-to");
    expect(installRow).toBeDefined();
    expect(installRow.grantId).toBe(100);
    expect(installRow.category).toBe("[maps]");
    expect(installRow.chosenBasename).toBe("brofx_mansion_10");
  });

  // Test 2 — case A, operator slug override
  it("uses operator-supplied slug when provided", async () => {
    await seedNewInstallQueue();
    await ensureMapsCategory();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]", slug: "custom_name",
    });
    expect(out.committed).toBe(true);
    expect(out.entry!.slug).toBe("custom_name");
    expect(out.entry!.target).toBe(path.join(resourcesDir, "[maps]", "custom_name"));
  });

  // Test 3 — case A, nested category
  it("supports nested bracket categories", async () => {
    await seedNewInstallQueue();
    await fs.mkdir(path.join(resourcesDir, "[maps]", "[apollo]"), { recursive: true });
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]/[apollo]",
    });
    expect(out.committed).toBe(true);
    expect(out.entry!.target).toBe(path.join(resourcesDir, "[maps]", "[apollo]", "brofx_mansion_10"));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/mcp/resolve_mapping_entry.install-to.test.ts`
Expected: Tests 1, 2, 3 FAIL with `out.committed: false` (handler returns `install-to-requires-new-install` because state-machine isn't yet implemented).

- [ ] **Step 3: Implement Case A — entry creation**

Open `src/mcp/tools/resolve_mapping_entry.ts`. Replace the placeholder line `return fail("install-to-requires-new-install");` at the end of the `install-to` branch (added in Task 3) with the full state machine:

```typescript
      // -- State machine ---------------------------------------------------
      const finalTarget = path.join(cfg.serverResources, input.category, finalSlug);

      // Ownership guard — reject if another active entry already points here.
      for (const [otherK, otherV] of Object.entries(mapping.entries())) {
        if (Number(otherK) !== input.grantId
            && otherV.status === "active"
            && otherV.target === finalTarget) {
          return fail("target-owned-by-other-grant", { ownedBy: Number(otherK) });
        }
      }

      const inNewInstalls = (mappingFile.newInstalls ?? []).includes(input.grantId);

      if (!currentEntry && !inNewInstalls) {
        return fail("grantId-not-in-mapping");
      }
      if (currentEntry && currentEntry.status !== "new-install") {
        return fail("install-to-requires-new-install");
      }

      const entry: MappingEntry = {
        slug: finalSlug,
        target: finalTarget,
        assetName: grant.asset.name,
        discoveredTier: 0,
        discoveredConfidence: 1,
        preservePaths: null,
        preservePathsSource: null,
        ignoreUpstreamUpdates: currentEntry?.ignoreUpstreamUpdates,
        ignoreUpstreamUpdatesReason: currentEntry?.ignoreUpstreamUpdatesReason,
        ignoreUpstreamUpdatesSetAt: currentEntry?.ignoreUpstreamUpdatesSetAt,
        status: "active",
        reviewedByUser: true,
      };
      mapping.setEntry(input.grantId, entry);
      mappingFile.newInstalls = (mappingFile.newInstalls ?? []).filter((g) => g !== input.grantId);
      await mapping.save();
      await log.append({
        ts: new Date().toISOString(),
        grantId: input.grantId,
        author: grant.asset.author ?? null,
        assetName: grant.asset.name,
        action: "install-to",
        tierBefore: currentEntry?.discoveredTier ?? null,
        confidenceBefore: currentEntry?.discoveredConfidence ?? null,
        chosenBasename: finalSlug,
        overrideInput: null,
        category: input.category,
      });
      return { committed: true, entry, remainingUnresolvedCount: -1 };
```

- [ ] **Step 4: Run tests to verify Tests 1-3 pass**

Run: `npm run test:unit -- tests/unit/mcp/resolve_mapping_entry.install-to.test.ts`
Expected:
- Tests 1, 2, 3 PASS.
- Tests from earlier tasks still PASS.
- Tests 4, 5, 6, 11 not yet written.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/resolve_mapping_entry.ts tests/unit/mcp/resolve_mapping_entry.install-to.test.ts
git commit -m "feat(install-to): case A entry creation

Implements the install-to state machine for the common case: grantId
in newInstalls with no existing MappingEntry. Creates an active entry
with the computed target, drains newInstalls, and logs to
resolution-log.jsonl with the new category field."
```

---

## Task 5: Case B — entry upgrade (status:new-install → active)

**Files:**
- Modify: `tests/unit/mcp/resolve_mapping_entry.install-to.test.ts` (add Test 4)

The implementation from Task 4 already handles Case B because it falls through both `!currentEntry && !inNewInstalls` (false — currentEntry exists) and `currentEntry && currentEntry.status !== "new-install"` (false — status IS new-install) and proceeds to the entry-write code. This task confirms via test.

- [ ] **Step 1: Add Test 4 to the test file**

Append inside the `describe(...)` block:

```typescript
  // Test 4 — case B, entry exists with status:new-install
  it("upgrades existing new-install entry to active and preserves ignoreUpstreamUpdates", async () => {
    const m = new Mapping(stateDir);
    m.approveFromProposed({});
    m.setEntry(100, {
      slug: "previously_set",
      target: "",
      assetName: "BroFX Mansion 10",
      discoveredTier: 0,
      discoveredConfidence: 0,
      status: "new-install",
      reviewedByUser: true,
      ignoreUpstreamUpdates: true,
      ignoreUpstreamUpdatesReason: "preexisting",
      ignoreUpstreamUpdatesSetAt: "2026-04-01T00:00:00Z",
    });
    await m.save();
    await ensureMapsCategory();

    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]",
    });
    expect(out.committed).toBe(true);
    expect(out.entry!.status).toBe("active");
    expect(out.entry!.target).toBe(path.join(resourcesDir, "[maps]", "brofx_mansion_10"));
    // ignoreUpstreamUpdates fields preserved
    expect(out.entry!.ignoreUpstreamUpdates).toBe(true);
    expect(out.entry!.ignoreUpstreamUpdatesReason).toBe("preexisting");
    expect(out.entry!.ignoreUpstreamUpdatesSetAt).toBe("2026-04-01T00:00:00Z");
  });
```

- [ ] **Step 2: Run test to verify it passes (no implementation change needed)**

Run: `npm run test:unit -- tests/unit/mcp/resolve_mapping_entry.install-to.test.ts`
Expected: Test 4 PASSES on first run because the handler from Task 4 already covers Case B.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/mcp/resolve_mapping_entry.install-to.test.ts
git commit -m "test(install-to): case B entry upgrade preserves ignoreUpstreamUpdates"
```

---

## Task 6: Reject paths — wrong status, no entry not in newInstalls

**Files:**
- Modify: `tests/unit/mcp/resolve_mapping_entry.install-to.test.ts` (add Tests 5, 6)

Both error paths are already implemented in Task 4's state machine. Tests confirm.

- [ ] **Step 1: Add Tests 5 and 6**

Append inside the `describe(...)` block:

```typescript
  // Test 5 — reject when entry is already active
  it("rejects install-to when entry status is 'active'", async () => {
    const m = new Mapping(stateDir);
    const existingTarget = path.join(resourcesDir, "[maps]", "already_here");
    await fs.mkdir(existingTarget, { recursive: true });
    m.approveFromProposed({
      "100": {
        slug: "already_here",
        target: existingTarget,
        assetName: "BroFX Mansion 10",
        discoveredTier: 1,
        discoveredConfidence: 1,
        status: "active",
        reviewedByUser: true,
      },
    });
    await m.save();
    await ensureMapsCategory();

    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]",
    });
    expect(out.committed).toBe(false);
    expect((out as any).error).toBe("install-to-requires-new-install");
  });

  // Test 6 — reject when no entry and grantId not in newInstalls
  it("rejects install-to when grantId is neither mapped nor in newInstalls", async () => {
    const m = new Mapping(stateDir);
    m.approveFromProposed({});
    // No newInstalls, no entries — but the portal stub still returns grant 100.
    await m.save();
    await ensureMapsCategory();

    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]",
    });
    expect(out.committed).toBe(false);
    expect((out as any).error).toBe("grantId-not-in-mapping");
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/mcp/resolve_mapping_entry.install-to.test.ts`
Expected: Tests 5, 6 PASS without code changes (handler logic from Task 4 covers both).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/mcp/resolve_mapping_entry.install-to.test.ts
git commit -m "test(install-to): reject wrong-status and not-in-mapping paths"
```

---

## Task 7: Ownership conflict guard

**Files:**
- Modify: `tests/unit/mcp/resolve_mapping_entry.install-to.test.ts` (add Test 11)

Ownership guard already implemented in Task 4. Test confirms.

- [ ] **Step 1: Add Test 11**

Append inside the `describe(...)` block:

```typescript
  // Test 11 — reject when target is already owned by another active grant
  it("rejects install-to when computed target is owned by another active grant", async () => {
    const otherTarget = path.join(resourcesDir, "[maps]", "brofx_mansion_10");
    await fs.mkdir(otherTarget, { recursive: true });

    const m = new Mapping(stateDir);
    m.approveFromProposed({
      // grant 999 already owns the target install-to would compute for grant 100
      "999": {
        slug: "brofx_mansion_10",
        target: otherTarget,
        assetName: "Some Other Asset",
        discoveredTier: 1,
        discoveredConfidence: 1,
        status: "active",
        reviewedByUser: true,
      },
    });
    m.getFile().newInstalls = [100];
    await m.save();

    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]",
    });
    expect(out.committed).toBe(false);
    expect((out as any).error).toBe("target-owned-by-other-grant");
    expect((out as any).ownedBy).toBe(999);
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/mcp/resolve_mapping_entry.install-to.test.ts`
Expected: Test 11 PASSES.

- [ ] **Step 3: Run the full install-to test file**

Run: `npm run test:unit -- tests/unit/mcp/resolve_mapping_entry.install-to.test.ts`
Expected: All 12 tests PASS (3 cross-field + 7 reject-validation + 3 happy + 1 case-B + 2 reject-state + 1 ownership = 17 assertions across the 12 named test cases per the spec).

- [ ] **Step 4: Run the full unit suite to catch regressions**

Run: `npm run test:unit`
Expected: All existing unit tests PASS. No regressions.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/mcp/resolve_mapping_entry.install-to.test.ts
git commit -m "test(install-to): ownership conflict rejected"
```

---

## Task 8: CHANGELOG, lint, full verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add CHANGELOG entry**

Open `CHANGELOG.md`. Add a new entry at the top under the unreleased / next-version section. Match the existing changelog format (check the file head):

```markdown
### Added

- `cfx_resolve_mapping_entry` `install-to` action: bind a grant to a prospective target path without requiring the target directory to exist. Closes the gap that prevented `cfx_deploy_asset` from working on fresh new-install grants. Operator workflow: `cfx_resolve_mapping_entry { grantId, action: "install-to", category: "[maps]", slug? }` → `cfx_download_asset` → `cfx_deploy_asset`.
```

If the file uses a different conventional layout (e.g., section per release), follow the existing pattern.

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: PASS, zero errors. If errors surface, fix them inline before committing.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: ALL tests PASS (unit + integration). The integration suite is unaffected by this change but verify no regressions.

- [ ] **Step 4: Run the build**

Run: `npm run build`
Expected: PASS, zero TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(install-to): changelog entry"
```

- [ ] **Step 6: Manual smoke verification (post-merge, optional pre-merge)**

This is verification, not a step requiring a commit. Tests do not cover the end-to-end install-to → download → deploy chain (no portal-mock fixtures exist). Verify manually with a real grant:

1. Identify a grant with `status: new-install` (e.g., `brofx_mansion_10` / grantId `992304` per memory).
2. Call `cfx_resolve_mapping_entry { grantId: 992304, action: "install-to", category: "[maps]" }`.
3. Verify response: `committed: true`, `entry.target` ends with `[maps]/brofx_mansion_10`, `entry.status: "active"`.
4. Verify `state/cfx-sync-map.json`: entry present with the new target; `newInstalls` no longer contains `992304`; `resolution-log.jsonl` has an `install-to` row.
5. Call `cfx_download_asset { grantId: 992304 }` (already cached from earlier session per state).
6. Call `cfx_deploy_asset { grantId: 992304, dryRun: true }` — should succeed past the new-install guard. Inspect plan.
7. If plan is clean: `cfx_deploy_asset { grantId: 992304 }`. Verify the target directory now contains the unzipped MLO files.
8. Repeat for the other 4 brofx mansions (12, 13, 14, 16).

If any step fails, capture the response, file an issue, do not merge.

---

## Self-Review

**Spec coverage:**
- [x] Schema additions (action enum, category/slug fields, error enum) → Task 1
- [x] ResolutionLog action + category → Task 1
- [x] validateFieldsForAction matrix → Task 2
- [x] Category validation (format + on-disk) → Task 3
- [x] Slug validation (regex + derivation) → Task 3
- [x] Case A entry creation → Task 4
- [x] Case B entry upgrade → Task 5
- [x] Reject wrong status + not-in-mapping → Task 6
- [x] Ownership guard → Task 7
- [x] Test plan: 12 unit tests → Tasks 2-7
- [x] CHANGELOG → Task 8
- [x] Manual smoke verification → Task 8

**Placeholder scan:** No TBDs, all code blocks complete, all commands explicit.

**Type consistency:** `slugify` defined Task 3, used Task 4 with same signature. `SLUG_REGEX` defined Task 3, used in same task. `validateCategory` returns `"category-invalid" | "ok"` consistently. `MappingEntry` shape in Task 4 matches the spec's Section 3 step 6.

**One known plan-level decision deferred:** Task 1 Step 1 keeps existing fields exactly as they are. If the existing schema source has subtle ordering or comments not visible from prior context reads, Task 1 implementer should preserve them. Surgical edit; no functional risk.
