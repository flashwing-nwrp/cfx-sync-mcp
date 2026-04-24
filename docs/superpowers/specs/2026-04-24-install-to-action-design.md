# Design: `install-to` action for `cfx_resolve_mapping_entry`

**Date:** 2026-04-24 (revised after adversarial review)
**Status:** approved, ready for plan
**Scope:** cfx-sync-mcp

## Problem

cfx-sync-mcp cannot deploy a grant that has no corresponding local directory on disk.

1. After `cfx_approve_mapping` runs, grants without a local match stay in `mappingFile.newInstalls` (an array of grantIds) but **are never written as `MappingEntry` rows** (see `approve_mapping.ts:22`).
2. `cfx_deploy_asset` refuses both "no entry" and `status: "new-install"` cases outright (see `deploy_asset.ts:115-122`).
3. The existing `new-install` action creates an entry with `target: ""`, and `reactivate` flips it to `active` while keeping `target: ""`.
4. The only existing action that *sets* a target — `override` — requires an existing folder to fuzzy-match against (`resolve_mapping_entry.ts:262-285`).

Result: deploying a fresh grant requires an out-of-band `mkdir <target>` plus a multi-step `reactivate` → `override` dance, and even that path has the latent nested-bracket recursion gap. There is no first-class "deploy this grant fresh" path.

## Solution

Add a new action `install-to` to `cfx_resolve_mapping_entry` that binds a grant (whether it has an existing `MappingEntry` or only sits in the `newInstalls` queue) to a prospective target path without requiring the target directory to exist. After the action succeeds, the standard `cfx_download_asset` + `cfx_deploy_asset` pair works unchanged: `cfx_deploy_asset` already handles both first-deploy (no existing target) and overlay-deploy (target present) via its `runFirstDeploy` and `runOverlayDeploy` branches.

## Input schema

Extend `ResolveMappingEntryInput`:

```typescript
{
  grantId: number;           // required
  action: "install-to";      // required (added to existing union)
  category: string;          // required, e.g. "[maps]" or "[maps]/[apollo]"
  slug?: string;             // optional override; defaults to slugify(grant.asset.name)
}
```

### Validation rules

**`category`**
- Non-empty string
- Must not contain `..`
- Must not start with `/` or `\`
- Every `/`-separated segment must match `^\[[^\]]+\]$` (wrapped in brackets)
- After `path.resolve(cfg.serverResources, category)`, the resolved absolute path must equal-or-startWith `path.resolve(cfg.serverResources) + path.sep` (paranoia guard against `..`, alt-sep, and Windows drive-letter inputs)
- Resolved path must exist on disk and be a directory

**`slug`** (when provided)
- Must match `/^[a-z0-9][a-z0-9_]{0,59}$/` (matches the codebase's slugify output character set; `-` excluded since no other slugifier emits it)

**Cross-field**: `category` / `slug` must not be passed on any non-`install-to` action. Extend `validateFieldsForAction` per the matrix below.

### Field-validation matrix (full updated table)

| Action | `pickIndex` | `overrideInput` | `allowRemapOver` | `category` | `slug` |
|--------|:-----------:|:---------------:|:----------------:|:----------:|:------:|
| accept | ❌ | ❌ | ❌ | ❌ | ❌ |
| pick | ✓ req | ❌ | ✓ if reviewed | ❌ | ❌ |
| override | ❌ | ✓ req | ✓ if reviewed | ❌ | ❌ |
| skip | ❌ | ❌ | ❌ | ❌ | ❌ |
| new-install | ❌ | ❌ | ❌ | ❌ | ❌ |
| reactivate | ❌ | ❌ | ❌ | ❌ | ❌ |
| **install-to** | ❌ | ❌ | ❌ | ✓ req | optional |

Any disallowed field present → `unexpected-field`.

## Operation flow

Slugify helper (matches `download_asset.ts:16` exactly):
```typescript
const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
```

After successful input validation:

1. Fetch fresh grant from portal (existing pattern). If grant not in user's owned-grants list → `grantId-not-owned`.
2. Compute `finalSlug = input.slug ?? slugify(grant.asset.name)`. If empty → `slug-derivation-failed`.
3. Compute `finalTarget = path.join(cfg.serverResources, input.category, finalSlug)`.
4. Ownership guard: scan `mapping.entries()` for any other entry with `grant_id !== input.grantId`, `status === "active"`, and `target === finalTarget`. If found → `target-owned-by-other-grant` with `ownedBy: <otherGrantId>`. (StateLock at the top of the call serializes against concurrent install-to / override invocations, so the active-only scope is sufficient.)
5. Look up current state. The action handles four cases:

   | currentEntry | grantId in `newInstalls` | Action |
   |--------------|:-:|--------|
   | undefined | ✓ | **Create** new entry from grant data (case A) |
   | undefined | ❌ | Reject: `grantId-not-in-mapping` |
   | exists, `status: "new-install"` | (either) | **Upgrade** to active (case B) |
   | exists, `status: "active"` or other | (either) | Reject: `install-to-requires-new-install` |

6. **Case A** (entry creation, common case after `cfx_approve_mapping`): write
   ```typescript
   {
     slug: finalSlug,
     target: finalTarget,
     assetName: grant.asset.name,
     discoveredTier: 0,
     discoveredConfidence: 1,
     status: "active",
     reviewedByUser: true,
     preservePaths: null,
     preservePathsSource: null,
     // ignoreUpstreamUpdates fields default to undefined for new entries
   }
   ```

7. **Case B** (entry upgrade, when operator previously called `new-install`): write the same shape, but preserve any `ignoreUpstreamUpdates*` fields from `currentEntry` (consistent with `pick`/`override`).

8. Remove `grantId` from `mappingFile.newInstalls` (no-op for case B since `new-install` action already removed it; idempotent for case A).

9. `mapping.save()`.

10. Append to resolution log:
    ```typescript
    {
      ts: <ISO>,
      grantId,
      author: grant.asset.author,
      assetName: grant.asset.name,
      action: "install-to",
      tierBefore: currentEntry?.discoveredTier ?? null,
      confidenceBefore: currentEntry?.discoveredConfidence ?? null,
      chosenBasename: finalSlug,
      overrideInput: null,           // NOT reused; new dedicated category field below
      category: input.category,      // NEW field
    }
    ```

## Explicitly NOT done

- **No `mkdir`.** The action does not touch the filesystem. `cfg.serverResources/<category>` must exist (validated), but `finalTarget` itself may or may not — `cfx_deploy_asset` handles both via `runFirstDeploy` (when destination missing) and `runOverlayDeploy` (when present).
- **No directory-content policing.** If `finalTarget` exists with content, `install-to` still succeeds; deploy's existing backup + swap preserves prior content.
- **No category auto-creation.** Typo prevention.
- **No preservePaths preservation across the new-install → install-to upgrade.** `preservePaths` lifecycle is governed by `cfx_scan_configs` and is reset by all entry-rewriting actions (matching `pick` / `override` behavior). Out-of-scope for this feature.
- **No batch/multi-grant variant.** Build a thin wrapper later if needed; single-grant action is the primitive.

## Output shape

Same envelope as other committed actions:

```typescript
{ committed: true, entry: MappingEntry, remainingUnresolvedCount: -1 }
```

Error envelope:

```typescript
{ committed: false, entry: null, remainingUnresolvedCount: -1, error: <code>, ... }
```

## Error codes

Added to `ResolveMappingEntryOutput.error` enum at `schemas/index.ts:421-430`:

| Code | Trigger |
|------|---------|
| `install-to-requires-new-install` | `currentEntry` exists with `status !== "new-install"` |
| `grantId-not-in-mapping` | No `currentEntry` AND grantId not in `mappingFile.newInstalls` |
| `category-invalid` | Format check fails (missing brackets, `..`, absolute path, escapes serverResources) |
| `category-not-found` | Validated format but resolved dir doesn't exist |
| `slug-invalid` | Operator-supplied slug fails regex |
| `slug-derivation-failed` | Auto-derived slug is empty after slugify+slice |

Reused: `target-owned-by-other-grant` (existing), `unexpected-field` (existing, with extended matrix), `grantId-not-owned` (existing — fires on `mapping.isApproved() === false` per `resolve_mapping_entry.ts:76` AND when grant is not in the portal `listGrants` response per `:124`).

## Test plan

Twelve tests, TDD pattern matching Phase 1.7. All in `tests/unit/mcp/resolve_mapping_entry.install-to.test.ts` (path corrected from prior revision).

1. **Happy — case A, auto-derived slug.** `grantId in newInstalls`, no entry. Call `install-to {category: "[maps]"}`. Asserts: entry created with `target = <res>/[maps]/<slugified>`, `status: active`, `reviewedByUser: true`, `discoveredConfidence: 1`; grantId removed from `newInstalls`; resolution log has one row with `action: "install-to"`, `category: "[maps]"`, `chosenBasename: <slugified>`.
2. **Happy — case A, operator slug override.** Same as #1 but with `slug: "custom_name"`. Asserts operator's slug used verbatim.
3. **Happy — case A, nested category.** `category: "[maps]/[apollo]"`. Target is `<res>/[maps]/[apollo]/<slug>`.
4. **Happy — case B, entry exists with status:new-install.** Pre-seeded entry from prior `new-install` action. `install-to` upgrades to active with finalTarget. Asserts `ignoreUpstreamUpdates*` fields preserved from currentEntry (mock with non-default values to verify).
5. **Reject — wrong status.** Entry exists, `status: "active"` → `install-to-requires-new-install`, mapping unchanged.
6. **Reject — no entry, not in newInstalls.** Empty mapping, grantId not in newInstalls → `grantId-not-in-mapping`.
7. **Reject — category format.** Loop through invalid inputs: missing brackets, `..`, absolute path (`/etc/foo`), Windows drive (`C:\foo` on Windows), segment without brackets. All → `category-invalid`. Includes Windows-specific `path.win32`-style escapes.
8. **Reject — category not on disk.** Valid format but `[nonexistent]` → `category-not-found`.
9. **Reject — slug regex.** Slug with path sep, leading `_`, leading digit-only-but-too-long (61 chars), `-` (codebase doesn't emit; spec disallows on input) → `slug-invalid`.
10. **Reject — slug derivation failed.** Grant whose `asset.name` slugifies to empty (e.g., `"!!!"` or all-non-alnum) → `slug-derivation-failed`.
11. **Reject — ownership conflict.** Pre-seed another active mapping at `<res>/[maps]/foo`, then `install-to {category:"[maps]", slug:"foo"}` → `target-owned-by-other-grant` with `ownedBy: <otherGrantId>`.
12. **Reject — fields on wrong action.** Loop: `accept`/`skip`/`new-install`/`reactivate`/`pick`/`override` each with extra `category` → `unexpected-field`. (Confirms install-to's new fields don't leak into other actions.)

End-to-end install-to → download → deploy is **out of scope for automated tests** (no portal-mock fixtures exist; building them is a separate effort). Verification is via manual smoke test post-merge using a real grant.

## Files touched

- `src/mcp/schemas/index.ts`
  - Extend `ResolveMappingEntryInput` action enum to include `"install-to"`
  - Add `category: z.string().optional()` and `slug: z.string().optional()` fields
  - Extend `ResolveMappingEntryOutput.error` enum with the 6 new codes
- `src/mcp/tools/resolve_mapping_entry.ts`
  - Extend `validateFieldsForAction` per the field matrix
  - Add `install-to` branch implementing the 4-case decision tree
  - Add slugify helper or import from a shared location (whichever fits existing pattern; lib/discovery already has slug-like utilities)
  - Add category validation helper (path resolution + bracket-segment regex + existence check)
- `src/lib/state/resolutionLog.ts`
  - Extend `ResolutionLogEntry.action` union with `"install-to"`
  - Add `category?: string | null` field to `ResolutionLogEntry`
- `tests/unit/mcp/resolve_mapping_entry.install-to.test.ts` — 12 unit tests above
- `CHANGELOG.md` — new feature note

## Out of scope

- Batch install (installing N grants in one call). Single-grant primitive only.
- `decline` / never-install action (tracked separately in user memory).
- Fixing `override`'s nested-bracket recursion gap (separate follow-up).
- End-to-end portal-mocked integration test for the full download → deploy chain. Manual smoke verification post-merge.
- preservePaths preservation across the entry-rewriting transition. Matches existing `pick` / `override` semantics.
