## What this PR does

<!-- One or two sentences -->

## Why

<!-- The motivation — what pain does this address or what new capability does it add? -->

## How

<!-- Brief design note. Link to any spec or plan doc if this is part of a larger effort. -->

## Testing

<!-- What did you test? Unit tests added / updated? Manual verification steps? -->

- [ ] `npm run ci` passes (typecheck + lint + grep-guard + tests)
- [ ] New or changed public APIs have JSDoc
- [ ] `CHANGELOG.md` updated under the appropriate section (Breaking / Added / Changed / Fixed / Migration)
- [ ] Schema changes (state, mapping, pack layout) are additive OR guarded by the existing `STATE_SCHEMA_TOO_NEW` one-way boundary
- [ ] No new runtime dependencies — or if added, justified in the PR body (transitive depth, maintenance status, license)

## Reviewer checklist

- [ ] Threat model: does this widen the trust boundary or introduce new parsing of untrusted input?
- [ ] Rollback: if shipped and reverted, does the state on disk still function with the older binary (or throw `STATE_SCHEMA_TOO_NEW`)?
- [ ] Docs: README / PRESERVATION / ARCHITECTURE updates for user-visible changes?
