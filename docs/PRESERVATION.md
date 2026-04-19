# Customization Preservation

Phase 1.5 adds automatic preservation of operator customizations across portal deploys. This doc covers how it works, the decisions the diff engine makes for each file, the tools that drive it, and the recovery paths when something goes sideways.

If you want the short version: deploy keeps your edits, pristine snapshots let it tell your edits apart from the vendor's, and `CFX_SYNC_PRESERVE=0` turns the whole thing off.

---

## Why this exists

Cfx portal packs ship **author-pristine** — a clean drop of the resource as the vendor published it. In practice, operators routinely customize the resources they download:

- Config files (jobs, prices, webhooks, permissions, locales)
- Editable-allowlist files the vendor explicitly permits (`cd_carhud/client/functions.lua`, `rm_minigames/editable_client.lua`)
- Injected overlays like `flrp_clienttriage`'s `_triage_hook.lua`

Before Phase 1.5, every deploy clobbered those edits and left you hand-merging from a backup. Phase 1.5 keeps them automatically, using two layers.

---

## The two layers

There are two independent systems. **Layer 2 is authoritative.** Layer 1 is advisory — it produces hints that show up in the deploy preview and will seed the future community KB, but it never overrides a Layer 2 decision.

### Layer 1 — config-path scan (advisory)

A heuristic scanner that walks a resource directory and flags files that look like configuration:

- **Path patterns** (case-insensitive) — `config.lua`, `cfg.lua`, `shared.lua`, `permissions.lua`, `settings.lua` at the root; anything under `config/**`, `configs/**`, `cfg/**`, `settings/**`, `locales/**`.
- **Content signature** — `.lua` files that didn't match a path rule are scored on how much they look like `Config = { ... }` / `return { ... }`. Threshold: `0.60` (calibrated against a 50-file labelled corpus; perfect precision at this threshold for non-`data/**` paths).

**`data/**` is deliberately excluded** from path rules. Pack authors legitimately rewrite lookup tables (vehicle stats, weapon data, mission definitions) between versions, and a false positive there would silently hide legitimate upstream updates. The content-signature rule can still flag individual `data/` files that look config-shaped.

Output: an array of repo-relative paths written into `cfx-sync-map.json` per-grant, surfaced during deploy as `preservePathsHints` for UI/logging. **It does not decide what gets preserved.**

Run it with `cfx_scan_configs` (see below).

### Layer 2 — pristine-snapshot 3-way diff (authoritative)

On the first successful deploy of a grant, cfx-sync-mcp snapshots the freshly-extracted pack to `state/pristine/<grantId>/`. That snapshot is the **last-known-upstream** baseline.

On the next deploy, the engine hashes three trees:

- **pristine** — what the vendor shipped last time
- **live** — what's on disk now (pristine + whatever you've edited)
- **newPack** — what the vendor is shipping this time

Comparing hashes per-file yields an exhaustive 10-row decision matrix. Each file gets exactly one decision.

---

## The 10-row decision matrix

This is operator-facing. Everything is computed purely from sha256 hashes — there's no guessing, no fuzzy matching.

| # | Scenario | What happens |
|---|---|---|
| 1 | You didn't touch it. Pack didn't touch it. | No-op; file stays as-is. |
| 2 | You didn't touch it. Pack updated it. | **Clean upgrade** — pack wins. |
| 3 | You edited it. Pack didn't touch it. | **Your edits preserved.** |
| 4 | You edited it. Pack updated it. | **Conflict** — dry-run surfaces it; you pick a resolution. |
| 5 | File exists only in live (you added it, or it's a triage hook). | **Your file preserved.** |
| 6 | File was in pristine, now absent from both live and pack. | Dropped — vendor removed it, you didn't have it either. |
| 7 | Pack renamed a file. You didn't modify it. | **Rename adopted** — file moves to the new path. |
| 8 | Pack renamed a file. You edited the old path. | **Conflict** with 6 options (see below). |
| 9 | Case-collision on Windows/macOS (`Configs/` vs `configs/`). | **Blocker** — deploy refuses with `CASE_COLLISION_DETECTED`. |
| 10 | Encrypted file (`.fxap`, `encrypted/**`) has changed on disk since pristine was captured. | **Blocker** — `ENCRYPTED_TAMPER_DETECTED`. Disk corruption, interrupted prior deploy, or tampering. |

### What "unchanged" and "changed" mean

Both sides are sha256 over file bytes. The engine is 100% deterministic: if pristine and live share a sha, you didn't edit. If they don't, you did. There is no line-level inference here.

### Rename detection (rows 7 and 8)

Within a grant, the engine pairs every file in `newPack` against every file in `pristine` by sha256. If two non-identical paths share bytes, that's a rename. If multiple candidates match (duplicated content), the engine treats it conservatively as a non-rename and surfaces both paths in the normal matrix.

### Encrypted-file handling (row 10)

Cfx escrow files are large and mostly read-only. Under normal usage, `sha(live) == sha(pristine)` for them because you can't modify them through the game loader. If that equality breaks, something is wrong: corruption, an interrupted deploy, or tampering. All three are worth blocking for.

Row 10 fires only when live AND pristine both exist and disagree on an encrypted path. A **new** encrypted file from the pack is not tamper — that's row 2.

### Blockers (rows 9 and 10) are hard stops

Blockers refuse the deploy; they are not warnings. Bulk syncs (`cfx_sync_all`) skip warnings too easily. If you see one, the message includes an actionable recovery hint.

---

## Conflict resolution

When a deploy hits a row-4 or row-8 conflict, dry-run surfaces the conflicts and you re-run with `conflictResolutions`. The resolutions available per conflict row:

### Row 4 (same path, both sides changed)

| Option | Behavior |
|---|---|
| `take-live` | Keep your edited file; drop the pack's changes. |
| `take-pack` | Use the new-pack file; your edits are lost. |
| `merge-diff3` | Run a 3-way merge. **Not implemented in 1.5** — throws with a hint to use `staged-for-merge` instead. Specced so `staged-for-merge` doesn't become a permanent crutch. |
| `staged-for-merge` | Write `.live` and `.pack` sidecars to `state/conflicts/<grantId>/<path>.{live,pack}`, skip the file in this deploy. You merge externally and re-run. |

### Row 8 (pack renamed a file you'd edited)

All four above, plus two rename-specific options:

| Option | Behavior |
|---|---|
| `take-live-at-new-path` | Move your edited file to the vendor's new path. Rename + user edit carried forward together. |
| `take-live-at-old-path` | Keep your edited file at the old path. Vendor's file at the new path is treated as net-new. |

### How to pass resolutions

`cfx_deploy_asset` accepts an optional `conflictResolutions: Record<path, resolution>`:

```jsonc
{
  "grantId": 16297,
  "conflictResolutions": {
    "configs/config.lua": "take-live",
    "locales/en.lua": "staged-for-merge"
  }
}
```

Any unresolved conflict in a non-dry-run apply throws `CONFLICTS_UNRESOLVED` with the list of paths — the tool refuses to apply a half-resolved plan.

### Schema-compat caveat

`take-live` on a file where the pack added a new required config field may produce runtime errors — we don't attempt schema sanity checks in 1.5 (deferred to a future `cfx_validate_config` tool). The dry-run output includes `pristineSha`, `liveSha`, `packSha` per conflict; inspect manually when the signal matters.

---

## Pristine lifecycle

### Capture

**First deploy of a grant after upgrading to 1.5** has nothing to diff against, so it falls back to the legacy plain-swap (with a warning) and snapshots the freshly-deployed live directory as pristine. Any customizations you'd already made to that directory are **not protected on this deploy** — the snapshot is taken *after* the swap, so the snapshot includes them. Subsequent deploys are fully protected.

### Rotation

On a successful Layer 2 deploy:

1. The previous pristine is moved to `<pristineDir>/<grantId>.old.<iso>/` (trash).
2. A copy of the newly-deployed live dir is moved into `<pristineDir>/<grantId>/`.
3. The old version is archived into `<pristineHistoryDir>/<grantId>/<versionId>/` so `cfx_rollback` can restore the *matching* pristine along with the live backup.
4. The trash directory is removed.

Each step is atomic at the FS level. If the process dies mid-rotation, the next deploy self-heals via `rotatePristine`'s resume-or-rollback logic — there is always at least one complete snapshot on disk.

### Garbage collection

- **`cfx_rollback`** rotates pristine back to the version matching the restored backup, keeping state + live + pristine consistent.
- **`cfx_reset_pristine`** (with `all: true` or no args) sweeps orphan pristine dirs whose grantId is no longer tracked in state. Pristine-history is deliberately kept — older backups need it.
- **Pack-version bump** — see Rotation above.

### On-disk layout

```
state/
├── cfx-sync-map.json           # v2: adds optional preservePaths + preservePathsSource per entry
├── state.json                  # v3: adds pristineVersionId + pristineCapturedAt + pristineHashes per grant
├── backups/<slug>/<iso>/       # manifest includes pristineVersionIdAtBackupTime
├── pristine/<grantId>/         # current baseline (tree form)
├── pristine-history/<grantId>/<versionId>/   # snapshots for rollback
└── conflicts/<grantId>/<relPath>.{live,pack} # staged-for-merge sidecars
```

Overrides: `CFX_STATE_DIR`, `CFX_PRISTINE_DIR`, `CFX_CONFLICT_DIR`. See [Feature flag and env vars](#feature-flag-and-env-vars) below.

### Pristine promotion semantics

There is one sharp edge worth calling out explicitly.

After a successful deploy, the engine snapshots the **post-apply live directory** as the new pristine — not the raw new pack. That's intentional: if you had preserved-live files (row 3, row 5, or a take-live resolution), they live on disk after apply and get captured into pristine. This "pristine promotion" protects those files from being silently deleted on the next deploy if the pack hasn't re-introduced them.

**Consequence for overlay tools.** A file injected by an external tool (e.g. `flrp_clienttriage`'s `_triage_hook.lua`) is a row-5 orphan on deploy 2 — preserved correctly, then captured into pristine. On deploy 3, if the pack still doesn't include that file, the engine now sees pristine-and-live matching with no pack entry — which resolves to row 2 ("pack dropped an unchanged file, delete it from live"). The overlay gets removed.

This is defensible but undocumented if you didn't read this section. If you rely on injected overlay files surviving every deploy, either:

- Re-inject after each deploy (simple; what `flrp_clienttriage` does in FLRP via its existing re-injection hook), or
- Wait for the planned overlay auto-reinjection follow-up (spec'd in `project_cfx_sync_followups.md`, not in 1.5).

### Version metadata (spec row "VERSION_METADATA_MISMATCH")

The spec calls out a non-blocking warning for packs whose `fxmanifest.lua` version doesn't match the portal-reported version (a stale API response case). **This is not implemented in 1.5.** Deploy doesn't compare manifest against portal metadata. Tracked as a Phase 1.6 follow-up. In practice, the in-flight marker + pristine-version cross-check catch the cases that matter.

---

## Operator tools

Full tool list: [`src/mcp/tools/index.ts`](../src/mcp/tools/index.ts). The preservation-touching ones:

### `cfx_scan_configs` — Layer 1 scanner (new in 1.5)

Populates `preservePaths` in `cfx-sync-map.json` for one or all mapped grants. Idempotent. Writes nothing outside the mapping file.

Input:
```jsonc
{}                         // scan every non-disabled mapped grant
{ "grantId": 16297 }       // scan one grant
{ "all": true }            // explicit all-mode
```

Output:
```jsonc
{
  "scanned": [
    { "grantId": 16297, "slug": "cd_dispatch", "preservePaths": ["configs/config.lua", ...], "count": 4 }
  ],
  "totalPreservePaths": 12,
  "skipped": [ { "grantId": 9012, "reason": "disabled" } ]   // optional
}
```

Hints populated here show up as `preservePathsHints` in `cfx_deploy_asset` output. Purely informational.

### `cfx_deploy_asset` — modified in 1.5

Now produces a `DeployPlan` (Layer 2) when pristine exists. Dry-run is strongly recommended: it previews the plan without mutating anything.

New input field:
- `conflictResolutions?: Record<path, ResolutionChoice>` — required on non-dry-run when the plan has conflicts.

New output fields:
- `plan` — the full decision plan (`rows`, `blockers`, `conflicts`, `packValidationFailures`). `null` on legacy plain-swap deploys.
- `preservePathsHints` — Layer 1 hints from the mapping.
- `packValidationFailures` — pack-extraction failures surfaced by the unzipper (refused symlinks, path-traversal entries). **Logged, not silently dropped.**
- `preservationMode` — `"legacy" | "first-deploy" | "layer-2"`. Which code path ran.
- `pristineCaptured` — true iff this run captured or rotated pristine.

Blockers throw before any mutation; unresolved conflicts throw before any mutation.

### `cfx_rollback` — modified in 1.5

Restores live from a backup **and** rotates pristine back to the snapshot that was current when that backup was taken (via `pristineVersionIdAtBackupTime` in the backup manifest). The next deploy diffs against the correct baseline — no false-positive row-4 conflicts from a stale pristine.

New output field: `pristineRotatedTo` — the restored pristine versionId, or `null` when the backup predates 1.5 (pre-1.5 backups have no manifest; state's pristine fields are cleared so the next deploy re-captures as first-deploy).

### `cfx_reset_pristine` — new in 1.5

Operator escape hatch. Drops the current pristine baseline and clears state's pristine fields so the next deploy is treated as first-deploy.

Input:
```jsonc
{}                          // reset every tracked grant + GC orphan pristine dirs
{ "grantId": 16297 }        // reset one grant
{ "all": true }             // explicit all-mode
```

Output:
```jsonc
{
  "removed": [16297, 88341],
  "orphansGced": [54321]
}
```

Also clears the in-flight marker for every reset grant — use this to recover from a torn deploy when you want to re-baseline from current live. (`cfx_rollback` is the other recovery path; it restores the pre-crash live instead.)

Pristine-history is intentionally NOT swept — rollback-able snapshots outlive state entries by design.

---

## Feature flag and env vars

| Variable | Default | Purpose |
|---|---|---|
| `CFX_SYNC_PRESERVE` | `1` (on) | Master switch. Set to `0`, `false`, `off`, or `no` to revert to v0.1.0 plain-swap behavior AND skip pristine capture entirely. Pure-rollback path if you hit a preservation bug. |
| `CFX_STATE_DIR` | `./state` | Root for all state. |
| `CFX_PRISTINE_DIR` | `<stateDir>/pristine` | Current pristine baselines. |
| `CFX_PRISTINE_HISTORY_DIR` | `<stateDir>/pristine-history` | Rollback-targeted snapshots. |
| `CFX_CONFLICT_DIR` | `<stateDir>/conflicts` | Staged-for-merge sidecars. |

When `CFX_SYNC_PRESERVE=0`:
- Deploy skips hashing, diff, plan — straight plain swap.
- Pristine is NOT captured or rotated. If you had pristine from prior runs, it stays on disk untouched.
- `plan` in the tool output is `null`; `preservationMode` is `"legacy"`; `pristineCaptured` is `false`.

Flipping it back on: the next deploy is a fresh first-deploy for every grant (pristine re-captures from current live). Customizations from earlier CFX_SYNC_PRESERVE=0 deploys have been live all along — they're preserved going forward.

---

## Crash recovery

### The in-flight marker

Before any filesystem mutation in a deploy, the tool writes a marker file describing the in-progress deploy (grantId, staging path, predicted backup path, start time). The marker is cleared **only after** `state.save()` commits.

A surviving marker on the next deploy entry trips `DeployInterruptedError`. You have two recovery paths:

1. **`cfx_rollback --grantId N --toTimestamp <iso>`** — restore the pre-crash live + rotate pristine back. Marker is cleared. Re-run deploy.
2. **`cfx_reset_pristine --grantId N`** — accept current live, clear pristine fields, clear marker. Next deploy re-baselines as first-deploy.

Pick rollback if the crash left you with a torn live dir; reset if live is intact but state is stale.

The marker covers every mutation window — `applyPlan`, `deploy`, pristine rotate, state save. No window leaks past state.save without being observable on the next entry.

### Partial-write safety

- **Atomic swaps** — every pristine / state / mapping mutation goes through `tmp + rename`.
- **Backup before swap** — the prior live is renamed into the backup dir before staging overwrites it. If apply fails, the backup is untouched.
- **PATH_TOO_LONG preflight** — on Windows, a precheck fails fast with `PathTooLongError` **before** any mutation if the resolved deploy path would exceed 260 chars. Never half-writes.
- **Symlink refusal** — the unzipper refuses symlink entries. Refusals are logged into the deploy plan's `packValidationFailures[]` and surfaced in the tool output — never silently dropped.

---

## Error classes you might see

All errors extend `CfxError` with `code`, `message`, `hint`, and (when relevant) `retryable`. The ones specific to preservation:

| Code | Class | When | Recovery |
|---|---|---|---|
| `CONFLICTS_UNRESOLVED` | `ConflictsUnresolvedError` | Non-dry-run apply with at least one conflict row missing from `conflictResolutions`. | Re-run dry-run, add resolutions for the listed paths, retry. |
| `CASE_COLLISION_DETECTED` | `CaseCollisionDetectedError` | Row 9 blocker: two paths collide on case-insensitive filesystems. | Rename one side locally. Deploy refuses until both sides have distinct lowercased paths. |
| `ENCRYPTED_TAMPER_DETECTED` | `EncryptedTamperDetectedError` | Row 10 blocker: `.fxap` or `encrypted/**` file differs from pristine. | `cfx_reset_pristine <grantId>` to re-baseline, or `cfx_rollback` to restore from backup. Investigate disk integrity if it recurs. |
| `DEPLOY_INTERRUPTED` | `DeployInterruptedError` | In-flight marker present from a prior crashed deploy. | `cfx_rollback` (recovers pre-crash live) or `cfx_reset_pristine` (accepts current live + re-baselines). |
| `PRISTINE_CORRUPTED` | `PristineCorruptedError` | Pristine dir missing or hashes don't match state.json's `pristineHashes`. | `cfx_reset_pristine <grantId>` — next deploy treats as first-deploy. |
| `PATH_TOO_LONG` | `PathTooLongError` | Windows only. Resolved deploy path would exceed MAX_PATH (260) without long-path support. Thrown **before** any mutation. | Enable Windows long-path support (`LongPathsEnabled` registry key + app manifest), or shorten `CFX_STATE_DIR` / `CFX_SERVER_RESOURCES` roots. |
| `STATE_SCHEMA_TOO_NEW` | `StateSchemaTooNewError` | Binary loaded a state.json whose version is newer than it understands. | Upgrade the binary to at least the version named in the hint. Never downgrade state in-place. |

---

## Known limitations

- **`merge-diff3`** is specced but ships as a `NotImplementedYet` stub. Use `staged-for-merge` as the escape hatch — it writes `.live` and `.pack` sidecars into `state/conflicts/<grantId>/` for you to hand-merge, then re-run deploy.
- **`VERSION_METADATA_MISMATCH`** (spec scenario 3: pack manifest version ≠ portal-reported version) is **not implemented** in 1.5. Deploy doesn't compare manifest against portal metadata. Follow-up in Phase 1.6.
- **Pristine promotion of preserved files** (see [Pristine promotion semantics](#pristine-promotion-semantics)) can cause an overlay file injected on deploy N to be removed on deploy N+1 if the pack still doesn't include it. Workaround: re-inject after each deploy, or wait for the overlay-reinjection follow-up.
- **First deploy after upgrading to 1.5** — there's no pre-existing pristine to diff against, so any customizations already on disk are captured into pristine *after* the swap. Subsequent deploys are fully protected; the first upgrade itself is a plain swap with a Layer 1 warning.
- **Config-schema validation** is out of scope. `take-live` on a config where the pack added a new required field may surface at runtime only. Deferred to a future `cfx_validate_config` tool.

---

## See also

- [Spec v2 (design rationale, calibration report)](../../docs/superpowers/specs/2026-04-18-cfx-sync-preservation-design.md) — in the outer `flrp-resources` tree.
- [`src/lib/preservation/diffEngine.ts`](../src/lib/preservation/diffEngine.ts) — the pure 10-row function.
- [`src/lib/preservation/types.ts`](../src/lib/preservation/types.ts) — `DeployPlan`, `PlanRow`, `ResolutionChoice`.
- [`src/lib/errors.ts`](../src/lib/errors.ts) — every error class + recovery hint.
- [`src/mcp/tools/index.ts`](../src/mcp/tools/index.ts) — canonical tool list.
