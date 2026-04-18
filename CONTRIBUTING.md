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
- **No mutation tools.** The 11 tools in `src/mcp/tools/index.ts` are the entire surface. Do not add tools for transfer/gift/revoke/share/purchase/subscribe/upload/publish.
- **Cookies never logged.** Use the structured logger with named fields; never stringify request/response objects.

CI enforces the first two via `tests/ci/getOnlyClient-ast.test.ts` and `scripts/grep-guard.ts`. The third is by convention — reviewers will flag.

## Pinning

- All dep versions pinned exactly (`.npmrc` has `save-exact=true`).
- `undici`, `@modelcontextprotocol/sdk`, `playwright`, `vitest` bumps should be reviewed for CVE relevance.

## License

By contributing, you agree your contributions are licensed under MIT.
