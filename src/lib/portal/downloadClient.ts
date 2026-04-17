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
    // Chain MUST originate on portal-api.cfx.re.
    if (!PORTAL_HOSTS.has(url.hostname)) {
      throw new InvalidTargetError(
        `Download chain must originate on portal-api.cfx.re; got ${url.hostname}`
      );
    }

    const headers = this.buildFollowHeaders(url);
    if (rangeStart != null && rangeStart > 0) {
      headers["Range"] = `bytes=${rangeStart}-`;
    }

    let res: Dispatcher.ResponseData;
    try {
      res = await undiciRequest(url, {
        method: "GET",
        headers,
        // Follow portal-api -> CDN redirects automatically, but we rely on
        // undici's redirect handling to respect host changes. For the
        // strip-on-redirect invariant we re-issue the request manually on
        // 3xx to our own boundary logic.
        maxRedirections: 0,
        headersTimeout: 30_000,
        bodyTimeout: 0, // no hard body timeout for large files
      });
    } catch (e) {
      throw new NetworkError(
        `Download request failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    // Handle 3xx manually so we can re-build headers (strip cookies off-cfx)
    if (res.statusCode >= 300 && res.statusCode < 400) {
      const location = res.headers["location"];
      if (typeof location !== "string") {
        throw new NetworkError(`Redirect response had no Location header`);
      }
      const nextUrl = new URL(location, url);
      // One additional hop (follow to CDN). Limit chain depth.
      const hopHeaders = this.buildFollowHeaders(nextUrl);
      if (rangeStart != null && rangeStart > 0) {
        hopHeaders["Range"] = `bytes=${rangeStart}-`;
      }
      try {
        res = await undiciRequest(nextUrl, {
          method: "GET",
          headers: hopHeaders,
          maxRedirections: 2, // cap further hops inside CDN
          headersTimeout: 30_000,
          bodyTimeout: 0,
        });
      } catch (e) {
        throw new NetworkError(
          `Download redirect failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }
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
