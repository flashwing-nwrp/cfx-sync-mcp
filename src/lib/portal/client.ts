import { GetOnlyClient } from "./getOnlyClient.js";
import { MeSchema, GrantsResponseSchema } from "./schemas.js";
import type { Me, GrantsResponse } from "./types.js";
import { CookieJar } from "../auth/cookieJar.js";
import {
  AuthExpiredError,
  InvalidTargetError,
  ForbiddenEndpointError,
  NetworkError,
} from "../errors.js";

const ALLOWED_HOSTS = new Set(["portal.cfx.re", "portal-api.cfx.re"]);

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  Referer: "https://portal.cfx.re/assets/granted-assets",
  Origin: "https://portal.cfx.re",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface PortalClientOpts {
  apiBase: string;
  cookieJar: CookieJar;
}

export interface ListGrantsOpts {
  search?: string;
  sort?: "asset.updated_at" | "asset.name" | "received_at";
  direction?: "asc" | "desc";
}

export class PortalApiClient {
  private client = new GetOnlyClient();
  private apiBase: URL;
  private jar: CookieJar;

  constructor(opts: PortalClientOpts) {
    this.apiBase = new URL(opts.apiBase);
    this.jar = opts.cookieJar;
  }

  private validateUrl(url: URL): void {
    if (!ALLOWED_HOSTS.has(url.hostname)) {
      throw new InvalidTargetError(
        `Portal request targeted non-allowlisted host: ${url.hostname}`
      );
    }
  }

  private async request(url: URL): Promise<{ status: number; body: unknown }> {
    this.validateUrl(url);

    const cookieHeader = this.jar.headerFor(url.toString());
    const headers: Record<string, string> = { ...BROWSER_HEADERS };
    if (cookieHeader) headers["Cookie"] = cookieHeader;

    let res;
    try {
      res = await this.client.get(url, { headers, headersTimeout: 15_000 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new NetworkError(`Portal request failed: ${msg}`);
    }

    const status = res.statusCode;
    if (status === 401) throw new AuthExpiredError();

    // Drain body even on errors so keep-alive works.
    const text = await res.body.text();
    let body: unknown = text;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      /* non-JSON — leave as string */
    }
    if (status < 200 || status >= 300) {
      throw new NetworkError(`Portal request ${url.pathname} returned ${status}`);
    }
    return { status, body };
  }

  async getMe(): Promise<Me> {
    const url = new URL("/v1/me", this.apiBase);
    const { body } = await this.request(url);
    return MeSchema.parse(body);
  }

  async listGrants(opts: ListGrantsOpts): Promise<GrantsResponse> {
    // D18: Fully paginate. No short-circuit.
    const allGrants: GrantsResponse["grants"] = [];
    let page = 1;
    let pageCount = 1;
    let itemCount = 0;

    while (page <= pageCount) {
      const url = new URL("/v1/me/asset-grants", this.apiBase);
      url.searchParams.set("page", String(page));
      if (opts.search) url.searchParams.set("search", opts.search);
      url.searchParams.set("sort", opts.sort ?? "asset.updated_at");
      url.searchParams.set("direction", opts.direction ?? "desc");

      const { body } = await this.request(url);
      const parsed = GrantsResponseSchema.parse(body);
      allGrants.push(...parsed.grants);
      pageCount = parsed.page_count;
      itemCount = parsed.item_count;
      page++;
    }
    return { grants: allGrants, page: 1, page_count: pageCount, item_count: itemCount };
  }
}

// Internal helper only used by other parts of lib/portal/
export function assertPortalHost(url: URL): void {
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new ForbiddenEndpointError(`Off-allowlist URL: ${url.toString()}`);
  }
}
