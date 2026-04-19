# Contributing

## Running tests

```bash
npm ci
npm run ci   # typecheck + lint + grep-guard + tests + audit
```

## Fixture refresh

When a portal API response shape changes and integration tests fail:

```bash
npx playwright install chromium   # if not already
npm run refresh-fixtures
```

Log into the portal in the launched browser, browse to Granted Assets, exercise whichever endpoint changed, then press Enter in the terminal. The script captures all `portal*.cfx.re` traffic, sanitizes per the list in `tests/fixtures/portal/README.md`, and writes a timestamped JSON. Commit the new JSON with a CHANGELOG entry.

## Invariants that MUST NOT regress

- **GET-only.** The `GetOnlyClient` wrapper is the only HTTP surface used by `src/lib/portal/`. Never import `undici` directly inside portal code.
- **No mutation tools.** The 15 tools in `src/mcp/tools/index.ts` are the entire surface. Do not add tools for transfer/gift/revoke/share/purchase/subscribe/upload/publish.
- **Cookies never logged.** Use the structured logger with named fields; never stringify request/response objects.

CI enforces the first two via `tests/ci/getOnlyClient-ast.test.ts` and `scripts/grep-guard.ts`. The third is by convention — reviewers will flag.

## Schema migrations

Two on-disk schemas are versioned: `state.json` (currently v3) and `cfx-sync-map.json` (currently v3). Both ship with a load-time guard — `STATE_SCHEMA_TOO_NEW` — that refuses to run when on-disk `version > currentCodeVersion`. The guard makes upgrades one-way by construction and prevents an older binary from silently dropping fields it doesn't know about (which would corrupt state for the newer binary's next run).

**Rules for schema changes:**

- **Additive only.** Never remove a field. Never rename a field in place — add the new one, deprecate the old with a clear migration path.
- **Bump the version on every structural change.** Both the on-disk literal and the code-side max version constant, in the same commit.
- **Readable-backwards, writeable-forwards-only.** A vN binary must load vN-1 state without mangling the new vN fields it doesn't understand. A vN-1 binary encountering vN state must throw `STATE_SCHEMA_TOO_NEW` — not downgrade in place.
- **Document the migration in CHANGELOG.md** alongside the version bump. Note which fields are new, their defaults, and whether the upgrade is automatic (it almost always is — first load rewrites the file with the new version).

**Reference migrations:**

- **state.json v2 → v3** (Phase 1.5) — added `pristineVersionId`, `pristineCapturedAt`, `pristineHashes` per-grant. Backwards-readable: v2 state loads with those fields defaulted to `null`; first save rewrites as v3.
- **cfx-sync-map.json v1 → v2** (Phase 1.5) — added `preservePaths` and `preservePathsSource` per-entry. Same pattern.
- **cfx-sync-map.json v2 → v3** (Phase 1.6) — added `ignoreUpstreamUpdates`, `ignoreUpstreamUpdatesReason`, `ignoreUpstreamUpdatesSetAt` per-entry for fork-mode. Optional fields, absent on entries that don't use fork mode. Migration happens on first write after upgrade.

Both were additive with null defaults, so upgrade is silent. A v0.1.0 binary hitting post-1.5 state (or a v0.2.x binary hitting post-1.6 mapping) throws the typed error with a hint to upgrade the binary.

## Pinning

- All dep versions pinned exactly (`.npmrc` has `save-exact=true`).
- `undici`, `@modelcontextprotocol/sdk`, `playwright`, `vitest` bumps should be reviewed for CVE relevance.

## License

By contributing, you agree your contributions are licensed under MIT.
