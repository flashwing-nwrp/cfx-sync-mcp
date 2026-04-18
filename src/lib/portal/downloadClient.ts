import { request as undiciRequest, type Dispatcher } from "undici";
import { type Readable } from "node:stream";
import { CookieJar } from "../auth/cookieJar.js";
import {
  InvalidTargetError,
  NetworkError,
  StallTimeoutError,
} from "../errors.js";

const PORTAL_HOSTS = new Set(["portal.cfx.re", "portal-api.cfx.re"]);

function isCfxHost(hostname: string): boolean {
  return PORTAL_HOSTS.has(hostname) || hostname.endsWith(".cfx.re");
}

export interface DownloadClientOpts {
  apiBase: string;
  cookieJar: CookieJar;
  stallTimeoutMs?: number;
}

export interface DownloadStream {
  statusCode: number;
  contentLength: number | null;
  body: Readable;
}

export class DownloadClient {
  private apiBase: URL;
  private jar: CookieJar;
  private stallTimeoutMs: number;

  constructor(opts: DownloadClientOpts) {
    this.apiBase = new URL(opts.apiBase);
    this.jar = opts.cookieJar;
    this.stallTimeoutMs = opts.stallTimeoutMs ?? 60_000;
  }

  // Cookies are attached ONLY when the target host is within *.cfx.re.
  // On redirect to a CDN (arbitrary host), cookies are NOT forwarded.
  // This is enforced here; unit test asserts the behavior.
  buildFollowHeaders(nextUrl: URL): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
      "Accept": "application/octet-stream, application/zip, */*",
    };
    if (isCfxHost(nextUrl.hostname)) {
      const cookieHeader = this.jar.headerFor(nextUrl.toString());
      if (cookieHeader) headers["Cookie"] = cookieHeader;
    }
    return headers;
  }

  async streamDownload(
    url: URL,
    rangeStart?: number
  ): Promise<DownloadStream> {
    if (!PORTAL_HOSTS.has(url.hostname)) {
      throw new InvalidTargetError(
        `Download chain must originate on portal-api.cfx.re; got ${url.hostname}`
      );
    }

    const MAX_HOPS = 3;
    let currentUrl = url;
    let res: Dispatcher.ResponseData | null = null;

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const headers = this.buildFollowHeaders(currentUrl);
      if (rangeStart != null && rangeStart > 0) {
        headers["Range"] = `bytes=${rangeStart}-`;
      }

      try {
        res = await undiciRequest(currentUrl, {
          method: "GET",
          headers,
          maxRedirections: 0,   // NEVER auto-follow — Cookie could leak
          headersTimeout: 30_000,
          bodyTimeout: 0,
        });
      } catch (e) {
        throw new NetworkError(
          `Download request failed at hop ${hop} (${currentUrl.hostname}): ${
            e instanceof Error ? e.message : String(e)
          }`
        );
      }

      // Not a redirect — we're done
      if (res.statusCode < 300 || res.statusCode >= 400) break;

      // Redirect: drain body, read Location, prepare next hop
      await res.body.text();
      const location = res.headers["location"];
      if (typeof location !== "string") {
        throw new NetworkError(
          `Redirect at hop ${hop} (${currentUrl.hostname}) had no Location header`
        );
      }
      currentUrl = new URL(location, currentUrl);
    }

    if (!res) {
      throw new NetworkError("No response after redirect chain");
    }

    // If we exhausted MAX_HOPS and still got a 3xx, reject
    if (res.statusCode >= 300 && res.statusCode < 400) {
      throw new NetworkError(
        `Redirect chain exceeded ${MAX_HOPS} hops; refusing to follow further`
      );
    }

    const contentLength =
      typeof res.headers["content-length"] === "string"
        ? parseInt(res.headers["content-length"] as string, 10)
        : null;

    return {
      statusCode: res.statusCode,
      contentLength: Number.isFinite(contentLength as number) ? (contentLength as number) : null,
      body: res.body as unknown as Readable,
    };
  }

  // Fetch from a presigned CDN URL (not portal). Cookies are NOT attached —
  // presigned URLs carry their own signature in the query string. Accepts any
  // HTTPS URL (including S3 / scw). Redirects up to MAX_HOPS are still followed
  // with the same no-cookies rule, since each hop is on the CDN side.
  async streamPresignedDownload(url: URL): Promise<DownloadStream> {
    if (url.protocol !== "https:") {
      throw new InvalidTargetError(
        `Presigned download URL must be https; got ${url.protocol}`
      );
    }

    const MAX_HOPS = 3;
    let currentUrl = url;
    let res: Dispatcher.ResponseData | null = null;

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      // Strictly no cookies on presigned downloads.
      const headers: Record<string, string> = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
        "Accept": "application/octet-stream, application/zip, */*",
      };

      try {
        res = await undiciRequest(currentUrl, {
          method: "GET",
          headers,
          maxRedirections: 0,
          headersTimeout: 30_000,
          bodyTimeout: 0,
        });
      } catch (e) {
        throw new NetworkError(
          `Presigned download failed at hop ${hop} (${currentUrl.hostname}): ${
            e instanceof Error ? e.message : String(e)
          }`
        );
      }

      if (res.statusCode < 300 || res.statusCode >= 400) break;

      await res.body.text();
      const location = res.headers["location"];
      if (typeof location !== "string") {
        throw new NetworkError(
          `Presigned redirect at hop ${hop} had no Location header`
        );
      }
      currentUrl = new URL(location, currentUrl);
      if (currentUrl.protocol !== "https:") {
        throw new InvalidTargetError(
          `Presigned redirect target must be https; got ${currentUrl.protocol}`
        );
      }
    }

    if (!res) throw new NetworkError("No response after presigned redirect chain");
    if (res.statusCode >= 300 && res.statusCode < 400) {
      throw new NetworkError(
        `Presigned redirect chain exceeded ${MAX_HOPS} hops`
      );
    }

    const contentLength =
      typeof res.headers["content-length"] === "string"
        ? parseInt(res.headers["content-length"] as string, 10)
        : null;
    return {
      statusCode: res.statusCode,
      contentLength: Number.isFinite(contentLength as number) ? (contentLength as number) : null,
      body: res.body as unknown as Readable,
    };
  }

  // Stream-to-disk helper with stall detection used by downloader.ts
  async streamToFile(
    stream: DownloadStream,
    writeStream: NodeJS.WritableStream & NodeJS.EventEmitter,
    onProgress?: (bytes: number) => void
  ): Promise<void> {
    let total = 0;
    let lastTick = Date.now();

    const stall = setInterval(() => {
      if (Date.now() - lastTick > this.stallTimeoutMs) {
        stream.body.destroy(new StallTimeoutError(this.stallTimeoutMs));
      }
    }, Math.min(this.stallTimeoutMs / 2, 10_000)).unref();

    try {
      await new Promise<void>((resolve, reject) => {
        stream.body.on("data", (chunk: Buffer) => {
          total += chunk.length;
          lastTick = Date.now();
          if (onProgress) onProgress(total);
        });
        stream.body.on("end", () => resolve());
        stream.body.on("error", reject);
        stream.body.pipe(writeStream);
        writeStream.on("error", reject);
      });
    } finally {
      clearInterval(stall);
    }
  }
}
