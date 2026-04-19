# Log snippet fixtures — capture methodology

Real-captured server-log excerpts from live FLRP (Full Life Roleplay) server, used as gold-truth inputs for the Phase 1.6 update-scanner pattern registry. Captured 2026-04-18 during a dogfood session after running cd_bridge + cd_doorlock updates via cfx-sync-mcp v0.2.0.

## Source

- `E:/Full Life Roleplay 2.0/txData/default/logs/fxserver.log` (9654 lines, 914 KB at capture time)
- Boot cycle starting at line 2000 of the source log (qbx_core → cd_bridge → … → prompt resources → flrp_police)

## Sanitization

Scanned for Discord webhook URLs, Steam IDs, licenses, API tokens, raw IPv4 endpoints. **None found in the captured ranges.** Internal synthetic IDs (vehicle impound codes like `RFSL7116`, server identity UUIDs like `1eac778b-…`) are non-identifying operational data and retained. If future captures include webhooks or player identifiers, scrub them with `s/discord\.com\/api\/webhooks\/[^ ]+/<REDACTED>/g` + equivalents before committing.

## Patterns observed in FLRP log (7 distinct authors)

Plan spec listed 4 initial authors (Codesign, LondonStudios, ULC/Dawnstar, AL-Developments). Real log shows **LondonStudios and AL-Developments do not emit in-game update notices** (portal-only), so their pattern files will be stubs (or deferred) — replaced in the initial pattern registry by **Prompt** and **quasarstore**, both of which are widely used on FLRP and do emit notices. Coverage goals unchanged; the 4 concrete patterns are now:

1. **Codesign** — cd_bridge / cd_doorlock / cd_dispatch
2. **ULC / Dawnstar** — ULC single-slug, includes critical fork case (local 1.9.0 > announced v1.8.0)
3. **Prompt** — prompt_sandy_* (boxed-table format with ⚠️ emoji)
4. **quasarstore** — qs-inventory / qs-housing / qs-vehiclekeys / qs-motorhome

Bonus authors also present (captured as single-file fixtures for possible future pattern work): **lation_ui** (IamLation), **jim** (Jimathy666), **dps** (DSRP emergency vehicle menu — up-to-date-only variant). Each has a distinct log format.

## Fixture files

| File | Source lines | Purpose |
|---|---|---|
| `codesign-cd_bridge.log` | 3848-3858 | Codesign block with `Notes:` + `Download:` + `Changelog:` |
| `codesign-cd_doorlock.log` | 3870-3879 | Second Codesign variant (different slug, same shape) |
| `codesign-cd_dispatch.log` | 3879-3888 | Third Codesign variant — notable: `Download:` points at `keymaster.fivem.net` (not `portal.cfx.re`) |
| `ulc-fork-case.log` | 3385-3401 | ULC two-part notice — `My Version: [X]` + `Latest Version: [Y]` + ASCII art banner + `OUTDATED. A NEW VERSION (Y) IS AVAILABLE` + `YOUR VERSION: X` + `GET LATEST VERSION HERE: <url>`. Local (1.9.0) > announced (v1.8.0) — canonical fork false-positive case |
| `quasarstore-qs-inventory.log` | 3402-3403 | `[qs-<slug>] New version available for <slug>!` + `You have version X, upgrade to version Y!` |
| `quasarstore-qs-housing.log` | 3406-3407 | Same shape, different slug |
| `quasarstore-qs-vehiclekeys-uptodate.log` | 3404 | Up-to-date variant — single line, no version pair |
| `prompt-sandy_illegal_garage.log` | 3411-3418 | Boxed-table format with `UPDATE AVAILABLE for [slug]: A → B` + multi-line `CHANGELOGS:` section |
| `prompt-sandy_mechanic.log` | 3419-3426 | Second Prompt variant — slug inferred from context (not bracketed in the header) |
| `jim-parking-uptodate.log` | 3409-3410 | jim format — `Version Check: Running: X Latest: Y` + up-to-date marker |
| `lation_ui-notice.log` | 3583 | Single-line format — `Your Version: X \| Latest Version: Y` |
| `flrp-boot-2000.log` | 2000-4000 | 2000-line cold-boot snapshot — contains `Started resource` boundary markers + multiple concurrent notices + interleaved output. Used by Task 12 integration test. |

## Regeneration

To refresh fixtures:

1. Rotate / truncate the source `fxserver.log` (or pick a fresh boot window)
2. Cold-restart the FLRP server and wait for all resources to start (~60s)
3. Let the version-check cycles fire (some authors poll async after resource start — wait ~30s extra)
4. `wc -l` the log, find a boot-boundary line (`Started resource qbx_core` marks the framework load)
5. `sed -n '<start>,<end>p'` for each pattern you want to refresh, write to the fixture path listed above
6. Re-run sanitization grep before commit

## Not in scope here

- Task 12 integration test uses `flrp-boot-2000.log` end-to-end
- Pattern tasks (4-7) each consume ≥ 2 fixtures from this dir
- Cross-pattern orthogonality tests (defined in plan Task 5 acceptance) load ALL fixtures and assert each pattern only matches its own author's files
