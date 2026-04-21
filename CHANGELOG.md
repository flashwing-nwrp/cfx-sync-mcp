# Changelog

All notable changes to cfx-sync-mcp are documented here.

Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/) — pre-1.0, minor bumps may include breaking schema changes (flagged below).

---

## [0.4.2] - 2026-04-20 — Typecheck fixes

### Fixed
- Test file typecheck errors from v3→v4 schema shim. Updated all test fixtures to use new `status` and `reviewedByUser` fields (no runtime behavior change). CI now passes with strict `tsc --noEmit`.

---

## [0.4.1] - 2026-04-20 — Dogfood fixes

### Fixed
- `scanResources` now recurses into nested `[bracket]/[bracket]/` directories (FiveM auto-load convention). Previously, resources organized under a subcategory (e.g. `[maps]/[apollo]/apollo_fishing_pier`) were invisible to discovery and override. Safety cap of 5 levels of bracket nesting.
- `cfx_list_unresolved` no longer surfaces `status: "new-install"` entries as `reason: "reactivated"` based on tier 3/4 fuzzy matches. Only tier 1+2 (confidence 1.0) re-detections trigger reactivation. Prevents the wizard from re-proposing the exact wrong targets the operator just dismissed.
- `cfx_approve_mapping` commits tier 3+4 entries provisionally with `reviewedByUser: false` (instead of dropping them) so they surface in `cfx_list_unresolved`'s suspicious bucket for review. Fixes a hole where pre-wizard auto-committed fuzzy entries had no path to the wizard review queue.

---

## [0.4.0] - 2026-04-19 — Mapping Wizard

### Breaking

- `cfx_approve_mapping` now commits only `confidence === 1.0` entries (tier 1+2 exact/slug-normalized matches). Tier 3+4 fuzzy matches and `newInstalls` surface via the new `cfx_list_unresolved` tool for interactive resolution. Operators upgrading from v0.3.x will see fewer auto-commits; re-run `cfx_discover` + `cfx_approve_mapping` on any tree, then chain through `cfx_list_unresolved` + `cfx_resolve_mapping_entry` for the remainder.

### Added

- `cfx_list_unresolved` — non-destructive query returning the wizard queue. Two output buckets: `unresolved` (new-install grants, reactivated new-installs whose resource now exists on disk, and name-collisions between same-name grants by different authors) and `suspicious` (active entries committed at tier 3+4 with `reviewedByUser: false`). Tier 3+4 fuzzy matches that fail auto-approve are NOT surfaced here — re-run `cfx_discover` to see them.
- `cfx_resolve_mapping_entry` — single-entry commit with actions `accept`, `pick`, `override` (fuzzy-confirmed), `skip`, `new-install`, `reactivate`. Remap over a reviewed entry requires `allowRemapOver: "<currentBasename>"` echo-back.
- Mapping schema v4 (additive): `status: "active" | "new-install" | "disabled"` + `reviewedByUser: boolean`. Legacy `disabled: true` migrates to `status: "disabled"`; v4 writes omit the `disabled` field. v4 is strictly forward-only.
- Author-prefix boost in candidate ranking (BroFX, Codesign, Apollo, quasarstore, ULC/Dawnstar, Prompt, Rcore, Molo, LondonStudios, AL-Developments).
- `state/resolution-log.jsonl` — append-only audit log of wizard decisions (Phase 2 KB submission source material).
- `Mapping.getActiveEntries()` helper — downstream consumers (deploy, rollback, scan_configs, scan_updates, preflight) switch to this filter to skip `new-install` + `disabled` entries cleanly.

### Fixed

- `cfx_deploy_asset` on an unresolved grant now rejects with a helpful operator-facing error pointing at `cfx_resolve_mapping_entry` (previously could crash on null target).

---

## v0.3.0 — 2026-04-19

Phase 1.6: update scanner. Merges portal signal with in-game server-log update notices, detects non-portal resources, and handles the fork case (local ahead of upstream) without hand-editing the mapping file.

### Breaking

- **Mapping schema v2 → v3.** Additive but one-way: new per-entry optional fields `ignoreUpstreamUpdates`, `ignoreUpstreamUpdatesReason`, `ignoreUpstreamUpdatesSetAt`. Older v0.2.x binaries reading a v3 mapping file throw `STATE_SCHEMA_TOO_NEW` with a hint to upgrade. No data loss — fields are absent on entries that don't use fork mode.

### Added

- **`cfx_scan_updates` tool** (non-destructive) — merges Cfx portal signal + in-game log notices into a 4-bucket output: `available` (behind, deployable), `suppressed` (local-ahead / local-equal / ignore-flag), `unknownSource` (non-semver versions), `unmapped` (log signal for resources with no mapping). Inputs: optional `{slug?, grantId?, logLines?, forcePortal?}`. Mutually exclusive `{slug, grantId}`.
- **`cfx_set_fork_mode` tool** (destructive) — flips the `ignoreUpstreamUpdates` triad on a mapping entry so operators don't hand-edit `cfx-sync-map.json` for the common fork case (e.g. ULC local-ahead). Operates under `StateLock`, atomic save.
- **Tool count: 13 → 15.**
- **Pattern registry** (`src/lib/updates/patterns/`) — table-driven per-author log-notice parsers. Ships 4 patterns: Codesign (`cd_bridge`, `cd_doorlock`, `cd_dispatch`), ULC/Dawnstar, Prompt (boxed-table format), quasarstore (qs-* family). New vendors = one PR adding one pattern file + a fixture + a test.
- **Per-pattern URL allowlist** (`src/lib/updates/urlAllowlist.ts`) — exact-host-equality check with IDN (Punycode) / IPv4-literal / IPv6-literal rejection. Defense-in-depth against forged notices that embed attacker URLs to bait operators into visiting hostile sites.
- **Loose semver helper** (`src/lib/updates/semverCompare.ts`) — wrapper over `node-semver` with documented deviations: v-prefix stripping, pre-release tags treated as equivalent-to-release (beta operators should set `ignoreUpstreamUpdates`), 4-part versions return `incomparable`.
- **`node-semver` dependency** — zero transitive deps, battle-tested.

### Changed

- **Log line inputs are caller-provided.** The scanner does NOT call another MCP server for logs; callers pass `logLines: string[]` explicitly (typically from `mcp__fxs__server_log_tail` or a file read). This keeps cfx-sync-mcp standalone and open-source-friendly. Phase 1.7+ may add a self-contained log reader backend.
- **Structured logger `ALLOWED_FIELDS`** extended with scanner-specific keys: `scannedLogLines`, `logHasStartupBoundary`, `portalFromCache`, `bucket`, `pattern`, `forkMode`.

### Fixed

None — Task 13 is pure-additive release-prep.

### Migration

If running `cfx-sync-mcp` v0.3.0 against a mapping file that was last written by v0.2.x, the migration happens on first mutation (e.g. `cfx_approve_mapping`, `cfx_scan_configs`, `cfx_set_fork_mode`). The in-memory shape is v3; the on-disk file is upgraded on next save. v0.2.x binaries reading a v3 file throw `STATE_SCHEMA_TOO_NEW` — intentional upgrade-only boundary.

To flag a resource as a local fork (e.g. you maintain internal patches ahead of upstream):

```
cfx_set_fork_mode { slug: "ulc", enabled: true, reason: "local 1.9.0 tracks our internal patches; upstream v1.8.0 is tagged" }
```

Subsequent `cfx_scan_updates` routes the resource to `suppressed:ignore-upstream-updates`, regardless of which signal fires. Reverse with `{slug: "ulc", enabled: false}`.

### Known limitations

- **Pre-release tags** treated as equivalent to release (e.g. `1.0.0-beta` = `1.0.0`). Beta-channel operators should set the fork flag per-resource.
- **Non-portal resources** (GitHub/Tebex) have no `grantId`, so `unmapped` bucket rows cannot be deployed via `cfx_deploy_asset`. Detection only; deployment is Phase 1.7+ territory.
- **Log window sensitivity.** Scanner sees only the lines you pass in. `logHasStartupBoundary` output flag tells you whether the input spans a recent boot cycle (best signal) or only tail fragments.

---

## v0.2.0 — 2026-04-18

Phase 1.5: customization preservation. Portal packs no longer clobber operator edits on redeploy.

### Breaking

- **State schema v2 → v3.** Additive but one-way: new per-grant fields `pristineVersionId`, `pristineCapturedAt`, `pristineHashes`. v0.1.0 binaries reading a v3 state throw `STATE_SCHEMA_TOO_NEW` with a hint to upgrade; never downgrade state in-place.
- **Mapping schema v1 → v2.** Adds optional per-entry `preservePaths` + `preservePathsSource` fields, written by `cfx_scan_configs`. Readable by older code that ignores unknown fields, but an upgraded binary running against a v1 mapping migrates it forward on first write.
- **Backup layout changed.** Backups now live at `<backupDir>/<iso>/{resource/, manifest.json}` (previously `<backupDir>/<iso>/<resource contents>/`). Pre-1.5 legacy backups still roll back via a fallback code path, but new backups are no longer readable by v0.1.0.
- **`-rollback` rolling-backup exclusion.** Backup directories whose names end in `-rollback` are now excluded from the rotation set used by `cfx_rollback` candidate queries. Programmatic consumers that listed backups themselves will see a changed set.

### Added

- **`cfx_scan_configs` tool** — Layer 1 config-path scanner. Walks mapped grants, flags files that look like configuration (path patterns + `.lua` content signature ≥ 0.60), writes `preservePaths` hints into `cfx-sync-map.json`. Advisory only — does not override Layer 2 decisions. `data/**` is deliberately excluded from path rules.
- **`cfx_reset_pristine` tool** — operator escape hatch. Drops the pristine baseline + state pristine fields + in-flight marker so the next deploy treats the grant as first-deploy. Also GCs orphan pristine dirs for grants no longer in state.
- **Error classes.** `PristineCorruptedError`, `CaseCollisionDetectedError`, `EncryptedTamperDetectedError`, `ConflictsUnresolvedError`, `DeployInterruptedError`, `StateSchemaTooNewError`, `PathTooLongError`. All extend `CfxError` with `code`, `message`, `hint`, and a recovery path documented in `docs/PRESERVATION.md`.
- **In-flight deploy marker** at `state/in-flight/<grantId>.json`. Written before any filesystem mutation; cleared only after `state.save()` commits. A surviving marker on the next deploy entry throws `DeployInterruptedError`.
- **Windows MAX_PATH preflight.** Deploy fails fast with `PathTooLongError` before any mutation if the resolved deploy path would exceed 260 chars without long-path support enabled. No half-writes.

### Changed

- **`cfx_deploy_asset`** — now runs Layer 2 3-way diff by default when pristine exists. New input field: `conflictResolutions?: Record<path, ResolutionChoice>` (required on non-dry-run if the plan has conflicts; unresolved → `ConflictsUnresolvedError`). New output fields: `plan` (full `DeployPlan` with rows/blockers/conflicts/packValidationFailures), `preservePathsHints`, `packValidationFailures`, `preservationMode` (`"legacy" | "first-deploy" | "layer-2"`), `pristineCaptured`. Dry-run returns the full plan without mutating anything. Blockers (case-collision, encrypted-tamper) refuse before mutation.
- **`cfx_rollback`** — rotates pristine back to the snapshot matching the restored backup, via `pristineVersionIdAtBackupTime` in the backup manifest. The next deploy diffs against the correct baseline. New output field: `pristineRotatedTo` (`null` for pre-1.5 backups; state's pristine fields are cleared so the next deploy re-captures as first-deploy).
- **Backup manifest** now records `pristineVersionIdAtBackupTime`, `pristineHashesAtBackupTime`, `pristineCapturedAtAtBackupTime`, and `pristineSnapshotPath`. Enables rollback to restore live + matching pristine atomically.
- **`StateLock.acquire()`** now uses `fs.open(path, 'wx')` for atomic create-only. Previously, two concurrent in-process acquires could both pass the `fs.exists` check before either wrote the lockfile.
- **Unzipper** now surfaces refused symlinks and path-traversal entries in `packValidationFailures[]` on the deploy plan. Logged, not silently dropped.

### Fixed

- **Gap #1 — `DeployInterruptedError`** now fires when a prior deploy left an in-flight marker on disk. Previously, the retry silently fell through to a fresh deploy, risking inconsistent state.
- **Gap #2 — In-flight marker window.** The marker now covers the `rotatePristine` + `state.save()` window. Previously it was cleared too early, so a failure during pristine rotation would leave state claiming success while pristine was torn — next deploy hit a conflict storm.
- **Gap #3 — `PathTooLongError` + preflight.** Overlong Windows paths previously surfaced as raw `ENAMETOOLONG` mid-extract. Now caught before any write with a structured error and a hint pointing at `LongPathsEnabled`.
- **Gap #4 — `StateLock` TOCTOU race.** Two concurrent in-process lock acquires could both win via stat-then-write. Fixed by switching to `O_EXCL`-equivalent `fs.open('wx')`.

### Known limitations

- **`merge-diff3`** resolution ships as a `NotImplementedYet` stub. Use `staged-for-merge` as the escape hatch — it writes `.live` and `.pack` sidecars into `state/conflicts/<grantId>/` for external merging, then re-run deploy.
- **`VERSION_METADATA_MISMATCH`** — the non-blocking warning for packs whose `fxmanifest.lua` version doesn't match the portal-reported version is specced but not wired. Tracked for Phase 1.6.
- **Pristine promotion.** A file injected by an external tool (e.g. `flrp_clienttriage`'s `_triage_hook.lua`) becomes pristine-known after the deploy that preserved it. If the pack still doesn't include that file on the next deploy, it resolves to row 2 and is removed. Workarounds: re-inject after each deploy (what `flrp_clienttriage` does), or wait for the overlay-reinjection follow-up. See `docs/PRESERVATION.md` § Pristine promotion semantics.
- **First deploy after upgrading to 1.5** — no pre-existing pristine to diff against, so any customizations already on disk get captured into pristine *after* the swap. The first upgrade itself is a plain swap. Subsequent deploys are fully protected.
- **Config-schema validation** is out of scope for 1.5. `take-live` on a file where the pack added a new required field may only surface at runtime. Deferred to a future `cfx_validate_config` tool.

---

## v0.1.0 — 2026-04-17

Initial release. Phase 1 crawl — cookie-authenticated read-only sync of Cfx portal granted assets to a local FiveM/RedM tree.

### Added

- 11 MCP tools: `cfx_login`, `cfx_logout`, `cfx_list_grants`, `cfx_discover`, `cfx_check_updates`, `cfx_download_asset`, `cfx_approve_mapping`, `cfx_deploy_asset`, `cfx_rollback`, `cfx_status`, `cfx_sync_all`.
- Portal-API adapter (`portal-api.cfx.re`) with cookie auth (file or Playwright).
- Atomic deploy with timestamped backups; plain-swap model.
- Mapping file (`cfx-sync-map.json`) for grant → local-path routing.
- CI guardrails: hardcoded invariants (no upload, no `.fxap` modification, no `server.cfg` edits).
