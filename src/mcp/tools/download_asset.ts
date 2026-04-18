import type { z } from "zod";
import type { DownloadAssetInput, DownloadAssetOutput } from "../schemas/index.js";
import { loadConfig } from "../../lib/config.js";
import { CookieJar } from "../../lib/auth/cookieJar.js";
import { loadCookiesFromFile } from "../../lib/auth/fileAuth.js";
import { PortalApiClient } from "../../lib/portal/client.js";
import { DownloadClient } from "../../lib/portal/downloadClient.js";
import { cachePath, verifyCacheFile } from "../../lib/download/cache.js";
import { downloadPack } from "../../lib/download/downloader.js";
import { checkDiskSpace } from "../../lib/deploy/preflight.js";
import { StateLock } from "../../lib/state/lock.js";
import { State } from "../../lib/state/state.js";
import { NotFoundError, MultiPackUnsupportedError } from "../../lib/errors.js";

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
}

export async function cfx_download_asset(
  input: z.infer<typeof DownloadAssetInput>
): Promise<z.infer<typeof DownloadAssetOutput>> {
  const cfg = loadConfig();
  const lock = new StateLock(cfg.stateDir);
  await lock.acquire();
  try {
    const state = new State(cfg.stateDir);
    await state.load();

    const jar = new CookieJar();
    await loadCookiesFromFile(cfg.cookieFile, jar);
    const portal = new PortalApiClient({ apiBase: cfg.apiBase, cookieJar: jar });
    const { grants } = await portal.listGrants({});
    const grant = grants.find((g) => g.grant_id === input.grantId);
    if (!grant) throw new NotFoundError(`Unknown grantId: ${input.grantId}`);

    const version = grant.asset.versions[0];
    if (!version) throw new NotFoundError(`Grant ${input.grantId} has no versions`);

    const packIndex = input.packIndex ?? 0;
    if (version.packs.length > 1 && input.packIndex === undefined) {
      throw new MultiPackUnsupportedError(version.packs.length);
    }
    const pack = version.packs[packIndex];
    if (!pack) throw new NotFoundError(`packIndex ${packIndex} out of range`);

    const file = cachePath(cfg.cacheDir, grant.grant_id, version.id);

    // Cache-hit check
    if (!input.force) {
      const prior = state.get(grant.grant_id);
      if (prior && prior.cachedZipPath === file) {
        try {
          const { sha256, bytes } = await verifyCacheFile(file);
          if (sha256 === prior.sha256) {
            return { cachedZipPath: file, bytes, sha256, versionId: version.id, packId: pack.id };
          }
        } catch { /* proceed to download */ }
      }
    }

    // Disk preflight — assume 100MB default upper bound unless we know better
    await checkDiskSpace(cfg.cacheDir, 100 * 1024 * 1024);

    // Cfx uses a 2-hop flow: portal-api returns {success, url} JSON, then
    // the caller fetches the presigned CDN URL for the actual pack bytes.
    const presignedUrl = await portal.getDownloadUrl(grant.grant_id, version.id, pack.id);
    const downloadClient = new DownloadClient({ apiBase: cfg.apiBase, cookieJar: jar });
    const out = await downloadPack({
      client: downloadClient,
      url: new URL(presignedUrl),
      cacheFile: file,
    });

    // CRITICAL (plan-audit B1): persist the download into state so cfx_deploy_asset
    // can find it. Without this upsert, deploy throws NOT_FOUND even after a
    // successful download.
    const prior = state.get(grant.grant_id);
    state.upsert({
      grantId: grant.grant_id,
      assetId: grant.asset.id,
      slug: slugify(grant.asset.name),
      assetName: grant.asset.name,
      versionId: version.id,
      packId: pack.id,
      updatedAt: grant.updated_at,
      sha256: out.sha256,
      cachedZipPath: file,
      deployedPath: prior?.deployedPath ?? "",
      deployedAt: prior?.deployedAt ?? "",
      backups: prior?.backups ?? [],
    });
    await state.save();

    return { cachedZipPath: file, bytes: out.bytes, sha256: out.sha256, versionId: version.id, packId: pack.id };
  } finally {
    await lock.release();
  }
}
