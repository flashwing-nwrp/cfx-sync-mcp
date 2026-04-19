# Changelog

All notable changes to cfx-sync-mcp are documented here.

Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/) — pre-1.0, minor bumps may include breaking schema changes (flagged below).

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
