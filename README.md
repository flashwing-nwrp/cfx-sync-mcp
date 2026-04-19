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

Portal packs ship author-pristine. You probably edit them — config files, permission lists, webhooks, locales, sometimes overlay files from tools like `flrp_clienttriage`. Before Phase 1.5, every deploy clobbered those edits and you hand-merged from a backup.

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

## License

MIT
