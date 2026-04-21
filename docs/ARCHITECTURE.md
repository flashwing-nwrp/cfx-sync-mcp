# cfx-sync-mcp architecture

Contributor-facing deep-dive on the internals. For the user-facing tour see [`../README.md`](../README.md). For the Phase 1.5 preservation matrix see [`PRESERVATION.md`](PRESERVATION.md).

## High-level shape

Three layers, top to bottom:

1. **MCP tool layer** (`src/mcp/`) — thin orchestrators. Each tool is a single file under `src/mcp/tools/` that validates input via a zod schema, loads state + mapping, composes the relevant library modules, and returns a schema-validated output. No business logic lives here.
2. **Library modules** (`src/lib/`) — pure TypeScript. Most of these accept dependencies by injection and have no I/O, no `Date.now()`, no logger imports. Testable in isolation. This is where the scanner, preservation matrix, pattern registry, semver compare, URL allowlist, and state/mapping primitives live.
3. **Adapters** (`src/lib/portal/`, `src/lib/auth/`, parts of `src/lib/deploy/` and `src/lib/state/`) — where I/O, network, and OS calls live. Narrow surface; easy to mock at the library boundary.

This is the same "library-clean core, thin tool layer" shape Phase 1.5 established and Phase 1.6 carried forward.

## Module map

### `src/lib/auth/`
Cookie handling and portal login.

- `cookieJar.ts` — in-memory jar that tracks cookies by domain, strips anything not under `*.cfx.re` on serialization, used by both the portal client and the download client.
- `fileAuth.ts` — read/write `.cookies.json` to disk with `chmod 600` (POSIX) / restricted ACL (Windows). Never logs cookie content.
- `playwrightAuth.ts` — headed-browser login flow. Captures cookies after the operator completes the Cfx.re email/OAuth flow. Currently uses ephemeral context; persistent-profile hook reserved at `.playwright-profile/` for a future phase.

### `src/lib/portal/`
HTTP boundary to Cfx.re.

- `client.ts` (`PortalApiClient`) — exposes `listGrants`, `getAssetVersions`, and the download stream primitive. Wraps `GetOnlyClient` — a thin undici wrapper that only exposes `.get()`. Non-GET method literals in `src/lib/portal/**` fail the grep-guard CI check.
- `rateLimit.ts` (`RateLimitGate`) — 1h soft cache on portal polls. Returns `STALE` if the last poll is under TTL and the caller didn't pass `force: true`.

### `src/lib/state/`
Persistent operator state.

- `state.ts` (`State`) — per-grant deploy record in `state.json`. Tracks `updatedAt`, `versionId`, pristine hashes, `lastPolledAt` per caller. Schema version v1 → v2 (Phase 1.5) migrates by adding pristine fields; v3 stubs are reserved.
- `mapping.ts` (`Mapping`) — operator-approved grant→target-directory mapping in `cfx-sync-map.json`. v1 → v2 added `preservePaths` hints (Phase 1.5). v2 → v3 added the `ignoreUpstreamUpdates` fork-mode triad (Phase 1.6).
- `lock.ts` (`StateLock`) — file-based exclusive lock via `fs.open(path, 'wx')`. Every destructive tool acquires before any mutation; releases in `finally`.

Schema migrations are **one-way**. Older binaries reading a newer state/mapping throw `StateSchemaTooNewError` (`STATE_SCHEMA_TOO_NEW` code) with a hint to upgrade.

### `src/lib/discovery/`
Propose a mapping from local resources + portal grants. Used by `cfx_discover`. Emits a proposal that the operator reviews + commits via `cfx_approve_mapping`.

### Mapping wizard (v0.4.0)

- `src/lib/discovery/authorPrefixes.ts` — static `Record<author, prefix[]>` consulted by the boost helper. Extension point: add a new vendor here; no other code changes required.
- `src/lib/discovery/prefixBoost.ts` — stable re-ranker; returns candidates annotated with `authorPrefixBoosted: boolean`.
- `src/lib/state/resolutionLog.ts` — append-only `state/resolution-log.jsonl`; best-effort writes (log failures never block mapping commits).
- `src/mcp/tools/list_unresolved.ts` — non-destructive query: fuzzy + new-install + reactivated + name-collision + suspicious buckets.
- `src/mcp/tools/resolve_mapping_entry.ts` — single-entry commit (accept/pick/override/skip/new-install/reactivate). Remap over a reviewed entry requires `allowRemapOver: "<basename>"` echo-back.
- `src/mcp/tools/approve_mapping.ts` — narrowed in v0.4.0 to `confidence===1.0` only.
- `src/lib/state/mapping.ts` — schema v4 adds `status` + `reviewedByUser`. Consumers iterating `entry.target` must use `getActiveEntries()`.

### `src/lib/preservation/` (Phase 1.5)
The 10-row decision matrix that preserves operator edits across deploys. See [`PRESERVATION.md`](PRESERVATION.md) for the full table. Key ideas:

- **Pristine baseline.** First successful deploy snapshots the vendor pack to `state/pristine/<grantId>/`. Subsequent deploys diff live-vs-pristine-vs-newpack.
- **Conflict surfaced in dry-run.** Files where both the operator and upstream changed different lines can be merged; same-line conflicts require `conflictResolutions` on the next non-dry-run call.
- **Pristine-history.** When a deploy succeeds, the prior pristine snapshot moves to `state/pristine-history/<grantId>/<versionId>/` so `cfx_rollback` can anchor to the matching baseline.

### `src/lib/deploy/`
Download, unzip, stage, swap, backup.

- `downloader.ts` — streams the pack zip from Cfx CDN to `cache/`. Strips portal cookies before following redirects off-host (invariant #3 in `SECURITY.md`).
- `unzipper.ts` — extract into staging. Refuses symlinks and path-traversal entries, surfacing them in `packValidationFailures[]` on the deploy plan.
- `preflight.ts` — Windows MAX_PATH guard. Fails with `PathTooLongError` before any mutation if the resolved deploy path would exceed 260 chars.
- `inFlight.ts` — writes `state/in-flight/<grantId>.json` before any filesystem mutation; clears after `state.save()` commits. A surviving marker on the next deploy entry throws `DeployInterruptedError`.
- Atomic swap — old live tree rotates to `state/backups/<iso>/`, staging directory renames into place.

### `src/lib/updates/` (Phase 1.6)
Update scanner. **All modules here are pure** — no Date, no logger, no I/O.

- `types.ts` — `NoticePattern`, `LogNoticeMatch`, `BlockState`, `ResourceSignal`, `ScanUpdatesResult`, and the four bucket row shapes.
- `semverCompare.ts` — thin wrapper over `node-semver` with documented loose-mode deviations (v-prefix stripped, pre-release tags treated as equivalent to release, 4-part versions → `incomparable`).
- `urlAllowlist.ts` — exact-host-equality check with IDN (Punycode) / IPv4-literal / IPv6-literal rejection. Used per-pattern.
- `blockStateMachine.ts` — per-token `walkBlock<T>` helper. `IDLE → IN_BLOCK → COMPLETE`, 20-line timeout. Every pattern's `blockMatch` is one `walkBlock` call.
- `patterns/` — one file per vendor. `codesign.ts`, `prompt.ts`, `ulc.ts`, `quasarstore.ts`, plus `index.ts` as the stable-ordered registry.
- `logScraper.ts` (`parseNotices`) — outer loop over line indices, inner loop over patterns. Dedup by `(canonicalSlug, current, announced)` triple. Startup-boundary detection independent of pattern matching.
- `scanner.ts` (`scanUpdates`) — two-pass merge. Pass 1 walks mapping entries and joins portal+log signals. Pass 2 walks unmatched log notices into the `unmapped` bucket. Dependencies (checkUpdatesFn, parseNoticesFn, state, mapping, patterns) are injected.

### `src/mcp/`
Tool layer.

- `server.ts` — Streamable HTTP transport setup.
- `dispatch.ts` — tool-name → handler map. Adding a tool requires appending to both `TOOLS` in `tools/index.ts` and `HANDLERS` in `dispatch.ts`; a registry test cross-checks they stay in sync.
- `schemas/index.ts` — zod input/output schemas. One pair per tool.
- `tools/*.ts` — one file per MCP tool (15 total as of v0.3.0).

## Key invariants

- **Read-only toward the portal.** No code path calls non-GET methods against `*.cfx.re`. Grep-guard + `GetOnlyClient` enforce this. No tools for transfer, gift, revoke, share, upload, publish, subscribe.
- **Zero outbound MCP calls.** cfx-sync-mcp never invokes another MCP server; it's standalone. Callers who want log signal pass `logLines: string[]` on `cfx_scan_updates`.
- **StateLock before every mutation.** `cfx_approve_mapping`, `cfx_scan_configs`, `cfx_reset_pristine`, `cfx_set_fork_mode`, `cfx_deploy_asset`, `cfx_rollback`, `cfx_sync_all` all acquire before touching state or mapping.
- **Atomic writes via tmp+rename.** Every state/mapping save writes to `<file>.tmp.<rand>` then renames over the target.
- **In-flight marker covers rotate + save.** A torn deploy leaves a marker; next deploy throws `DeployInterruptedError` with a rollback hint.
- **Pure library modules.** `src/lib/updates/**` and `src/lib/preservation/**` have no Date, no logger, no fs imports. All side-effects happen in `src/mcp/tools/*` or `src/lib/state/*` or `src/lib/deploy/*`.
- **Schema migrations additive + one-way.** New fields are optional; older binaries reading newer files throw `STATE_SCHEMA_TOO_NEW`.
- **Pattern files are data.** Adding a vendor is one new file + one fixture + one test + a barrel append. No engine changes.
- **Cookies never leave `*.cfx.re`.** `DownloadClient` strips cookies before off-host redirects.
- **URL allowlist is exact host equality.** No subdomain trust, no prefix bleed. Per-pattern trustedDomains list, verified with 11 adversarial test cases.

## Data on disk

```
<state-dir>/
  state.json                         Per-grant deploy state (version, pristine pointer, lastPolledAt)
  cfx-sync-map.json                  Operator-approved grant→target-dir mapping
  pristine/<grantId>/                Frozen vendor pack — Phase 1.5 baseline
  pristine-history/<grantId>/<v>/    Rollback-anchor snapshots
  backups/<iso>/                     Live-tree snapshots before deploys
    manifest.json                      Records pristine pointer for matched rollback
    resource/                          The pre-swap live tree
  in-flight/<grantId>.json           Crash-recovery marker
  .state.lock                        StateLock file

<cache-dir>/                         Downloaded pack zips (ephemeral)
<staging-dir>/<grantId>/             Unzipped pack mid-deploy
.cookies.json                        Cfx portal cookies (chmod 600, gitignored)
.playwright-profile/                 Reserved — persistent browser profile (future Phase)
```

All paths are configurable via env vars (`CFX_STATE_DIR`, `CFX_CACHE_DIR`, `CFX_STAGING_DIR`, `CFX_COOKIE_FILE`, `CFX_PLAYWRIGHT_PROFILE_DIR`). Defaults land under the repo root for dev and `~/.config/cfx-sync-mcp/` for production.

## Adding a new vendor pattern

This is the most common contribution and by design is a single-file change.

1. **Capture a real fixture.** Run the target vendor's resource on a live FiveM server, get ≥2 real log snippets that contain the update notice. Put them at `tests/fixtures/log-snippets/<vendor>-<variant>.log`. Scrub credentials / player IDs / Discord webhooks before committing.
2. **Create the pattern file.** `src/lib/updates/patterns/<vendor>.ts` implementing `NoticePattern` from `../types.js`. Compose `walkBlock` from `../blockStateMachine.js`. Call `checkUrl` from `../urlAllowlist.js` per-capture. Don't import `semverCompare` — version strings flow out as raw strings; the scanner handles compare.
3. **Write the test.** `tests/unit/updates/patterns/<vendor>.test.ts`. Include the positive fixture cases plus a cross-orthogonality assertion: iterate every sibling pattern's fixtures through your `blockMatch` and assert null.
4. **Register in the barrel.** Append to `PATTERNS` in `src/lib/updates/patterns/index.ts` in alphabetical order.
5. **Freeze `trustedDomains` from fixture observation.** Don't add a domain you haven't seen a real vendor notice emit.
6. **Run `npm run ci`.** All 600+ tests should still pass. No engine changes required.

## Phase 1.6 scanner dataflow

Operator invokes `cfx_scan_updates { slug?, grantId?, logLines?, forcePortal? }`. The tool:

1. Loads `State` and `Mapping` from disk.
2. Evaluates `RateLimitGate`. If `STALE` and `!forcePortal`, short-circuits the portal fetch.
3. Otherwise loads cookies, calls `PortalApiClient.listGrants()`, and builds a `CheckUpdatesResult` (joining portal grant metadata with local state).
4. On auth/network/rate-limit failure, the adapter returns `{updated: [], stale: true, portalFromCache: true}` so log scanning can still proceed (graceful degradation — follow-up shipped after live dogfood).
5. Calls pure `scanUpdates({...})` with the result, `parseNotices`, `PATTERNS`, and the injected `state`/`mapping`.
6. Scanner runs Pass 1 over mapping entries, Pass 2 over unmatched log notices, produces the 4-bucket output.
7. Zod validates the output against `ScanUpdatesOutput` schema before returning.

No outbound MCP calls. Log lines are always caller-provided.

## What lives outside this repo

Design specs and implementation plans for the current work live in a parent tree under `docs/superpowers/specs/` and `docs/superpowers/plans/`. The standalone distribution of cfx-sync-mcp does not include them; when this repo goes fully public we will either port them into `docs/specs/` here or link to a separate spec tree.

For now, contributors without access to that parent tree can rely on:
- README (user-facing tour)
- This ARCHITECTURE.md (internals)
- PRESERVATION.md (10-row matrix)
- CHANGELOG.md (release log + rationale)
- Inline JSDoc (every module has a decision-flow header)

That's enough to navigate the code, add a pattern, fix a bug, or review a PR.
