# cfx-sync-mcp

> **This tool only downloads. It cannot transfer, gift, modify, or mutate your grants in any way. We enforce this in code.**

Open-source MCP server that keeps a FiveM/RedM server's paid Cfx.re portal assets in sync with your granted-assets list.

## What it does

- Lists your Cfx portal grants (cookie-authenticated, read-only)
- Detects updates
- Downloads the new pack zips
- Atomically swaps them into your server tree with timestamped backups
- **Preserves your local customizations across deploys** (Phase 1.5)
- Exposes the above as MCP tools for Claude Code

## Customization preservation

Portal packs ship author-pristine. You probably edit them — config files, permission lists, webhooks, locales, sometimes overlay files from your own sibling tooling. Before Phase 1.5, every deploy clobbered those edits and you hand-merged from a backup.

Phase 1.5 keeps them automatically. On the first successful deploy, cfx-sync-mcp snapshots the vendor's pack as a **pristine baseline**. On every deploy after that, it hashes pristine vs live vs new-pack and emits a 10-row decision per file: unchanged paths upgrade cleanly, your edits are preserved, conflicts surface in dry-run with four resolution options (`take-live`, `take-pack`, `merge-diff3` stub, `staged-for-merge`). Renames, case collisions, and encrypted-file tampering are all detected. Rollback restores live AND the matching pristine so the next deploy diffs against the correct baseline.

Feature flag: `CFX_SYNC_PRESERVE=0` reverts to the v0.1.0 plain-swap behavior and skips pristine capture entirely. On by default.

**Full docs:** [`docs/PRESERVATION.md`](docs/PRESERVATION.md) — the 10-row matrix, conflict UX, pristine lifecycle, `CFX_SYNC_PRESERVE` + the new `cfx_scan_configs` / `cfx_reset_pristine` tools, crash recovery, known limitations.

## What it will never do

- Transfer, gift, or revoke grants
- Upload or publish assets
- Modify `.fxap` escrowed files
- Auto-edit `server.cfg`

These are hard invariants enforced in CI (see `SECURITY.md`).

## Safety caveats

This tool depends on `portal-api.cfx.re`, which is **undocumented and not officially supported** by Cfx.re. When it changes, this tool fails fast — never producing partial or corrupt deploys. Expect 2-6 breakage events per year. Fix cadence is best-effort community PRs. If you need guaranteed uptime against Cfx.re API changes, this tool isn't the right fit.

## Install

```bash
npm install
npm run build

# Optional: enable Playwright browser login (~150MB Chromium download)
npx playwright install chromium
```

## Configure

Copy `.env.example` → `.env` and edit:

```
CFX_SERVER_RESOURCES=/path/to/your/fxserver/resources
CFX_AUTH_MODE=file   # or "playwright"
```

## Wire into Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "cfx-sync": {
      "command": "node",
      "args": ["/abs/path/to/cfx-sync-mcp/dist/index.js"]
    }
  }
}
```

**Use absolute paths in the `env` block** — the MCP child process's `cwd` may not match your project directory.

## Quick start

In Claude Code, ask:

- "Log me into Cfx" → runs `cfx_login`
- "Discover my Cfx assets" → runs `cfx_discover`
- "Check what's outdated" → runs `cfx_check_updates`
- "Sync everything, but skip qs-housing" → runs `cfx_sync_all { skip: [<grantId>] }`
- "Scan mapped grants for likely config paths" → runs `cfx_scan_configs`
- "Reset the pristine baseline for grant X" → runs `cfx_reset_pristine { grantId: <id> }`

See [`docs/PRESERVATION.md`](docs/PRESERVATION.md) for the full preservation-tool reference.

## Update scanning

As of v0.3.0, cfx-sync-mcp includes a unified update scanner that merges two signals:

1. **Portal signal** (existing) — `cfx_check_updates` polls the Cfx.re portal for changed grants
2. **Log signal** (new) — scans in-game server log output for vendor "Update Available" notices

Some authors (Codesign, ULC/Dawnstar, Prompt, quasarstore) announce updates in the FiveM server log when the resource boots. Others only expose the signal via the portal. The scanner combines both.

### Output buckets

```json
{
  "available": [/* resources behind upstream, deployable via cfx_deploy_asset */],
  "suppressed": [/* local-ahead / local-equal / operator-ignored */],
  "unknownSource": [/* version strings we can't semver-compare */],
  "unmapped": [/* log signal, no mapping entry — detection only, no deploy path */]
}
```

### Example — scan with log input

```
cfx_scan_updates {
  logLines: [/* lines from mcp__fxs__server_log_tail or file read */]
}
```

Pass `forcePortal: true` to bypass the 1h portal cache; omit `logLines` for a portal-only scan.

### Fork mode (local ahead of upstream)

Some operators run forked versions of resources (e.g. local patches on top of a public release). Without a flag, the scanner would flag upstream as "available" even though local is newer. Use `cfx_set_fork_mode`:

```
cfx_set_fork_mode {
  slug: "ulc",
  enabled: true,
  reason: "local 1.9.0 tracks internal fork; upstream v1.8.0 unchanged"
}
```

Future scans route this resource to `suppressed: ignore-upstream-updates`. Reverse with `enabled: false`.

### Sourcing log lines

Phase 1.6 keeps cfx-sync-mcp standalone — the scanner does NOT call another MCP server. Callers source log lines themselves:

- **FLRP / fxs-mcp:** `mcp__fxs__server_log_tail { lines: 2000 }`
- **Direct file read:** `fs.readFileSync("fxserver.log", "utf8").split("\n").slice(-2000)`
- **txAdmin API:** whatever endpoint your server exposes

Phase 1.7+ may add a self-contained log reader if operator demand warrants it.

### Limitations

- **Pre-release semver:** `1.0.0-beta` is treated as equivalent to `1.0.0`. Beta-channel operators should set the fork flag.
- **Unmapped rows** have no `grantId` and cannot be deployed via `cfx_deploy_asset`. Promotion to a mapping entry requires `cfx_approve_mapping` with a verified portal grant.
- **Log window sensitivity:** the scanner only sees what you pass in. `logHasStartupBoundary: true` in the output means your input spans a recent boot (best signal); false means only tail fragments (notices may have scrolled off).
- **Known patterns only:** Codesign, ULC/Dawnstar, Prompt, quasarstore. Adding a new vendor is a single-file PR (`src/lib/updates/patterns/<vendor>.ts` + fixture + test).

## License

MIT
