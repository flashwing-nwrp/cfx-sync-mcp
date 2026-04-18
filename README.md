# cfx-sync-mcp

> **This tool only downloads. It cannot transfer, gift, modify, or mutate your grants in any way. We enforce this in code.**

Open-source MCP server that keeps a FiveM/RedM server's paid Cfx.re portal assets in sync with your granted-assets list.

## What it does

- Lists your Cfx portal grants (cookie-authenticated, read-only)
- Detects updates
- Downloads the new pack zips
- Atomically swaps them into your server tree with timestamped backups
- Exposes the above as MCP tools for Claude Code

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

## License

MIT
