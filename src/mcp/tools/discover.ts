import type { z } from "zod";
import type {
  DiscoverInput,
  DiscoverOutput,
} from "../schemas/index.js";
import { loadConfig } from "../../lib/config.js";
import { CookieJar } from "../../lib/auth/cookieJar.js";
import { loadCookiesFromFile } from "../../lib/auth/fileAuth.js";
import { PortalApiClient } from "../../lib/portal/client.js";
import { detectLayout } from "../../lib/discovery/detectLayout.js";
import { scanResources } from "../../lib/discovery/scanResources.js";
import { matchGrants } from "../../lib/discovery/matchGrants.js";
import { proposeMapping } from "../../lib/discovery/proposeMapping.js";

export async function cfx_discover(
  input: z.infer<typeof DiscoverInput>
): Promise<z.infer<typeof DiscoverOutput>> {
  const cfg = loadConfig();
  const layout = input.layout ?? detectLayout(cfg.serverResources);
  const resources = scanResources(cfg.serverResources, layout);

  const jar = new CookieJar();
  await loadCookiesFromFile(cfg.cookieFile, jar);
  const client = new PortalApiClient({
    apiBase: cfg.apiBase,
    cookieJar: jar,
  });
  const { grants } = await client.listGrants({});

  const matched = matchGrants(grants, resources);
  const proposed = proposeMapping(matched, grants);
  return proposed;
}
