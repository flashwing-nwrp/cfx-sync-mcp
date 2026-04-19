# Security Policy

## Supported versions

We ship security fixes for the latest minor release only. This tool is pre-1.0 and under active development; older minor versions are archived, not maintained.

## Reporting a vulnerability

If you believe you've found a security issue in cfx-sync-mcp, **please do not open a public GitHub issue**. Instead, report it privately:

- **Preferred:** [GitHub Security Advisories](https://github.com/flashwing-nwrp/cfx-sync-mcp/security/advisories/new) — creates a private channel with maintainers
- **Email:** flashwing@willow-wind.com

We will acknowledge your report within 72 hours and work with you on a disclosure timeline. For issues affecting operators in the wild (credential leakage, path traversal, pack-tamper detection bypass), we aim to ship a patch release within 7 days of confirmation.

## Threat model

- Adversary can read our code (it's open source) but cannot execute it in the operator's environment.
- Adversary cannot trick the operator into installing a malicious `cfx-sync-map.json`, cookie file, or config.
- Cfx.re's portal is considered trusted for response content, but the API contract is unstable.

## Non-negotiable invariants

1. **GET-only** — the portal HTTP client wraps undici in `GetOnlyClient` which exposes only `.get()`. AST + grep CI checks fail if any non-GET method literal appears in `src/lib/portal/**`.
2. **URL allowlist** — only three paths on `portal-api.cfx.re` are ever requested.
3. **Cookies never leave *.cfx.re** — the `DownloadClient` strips cookies before following redirects off-host.
4. **Zero mutation surface** — no tools for transfer, gift, revoke, share, purchase, subscribe, upload, publish.
5. **`grant_transfers` stripped at the boundary** — zod `.transform()` drops the field at response parse time.

## Cookie handling

- `.cookies.json` is gitignored
- `chmod 600` (POSIX) or `icacls` (Windows) on every write
- Never logged; never written into state / tool output / error messages
- Structured logger with field allowlist (no regex on arbitrary strings)
- Non-persistent browser context on Playwright login — no leak of operator's real Chrome cookies

## Disclosure

Security issues: email flashwing@willow-wind.com. Please do not open a public GitHub issue for security-sensitive reports.
