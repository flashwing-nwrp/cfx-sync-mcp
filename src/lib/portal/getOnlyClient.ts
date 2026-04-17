import { request, type Dispatcher } from "undici";

export interface GetOpts {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  maxRedirections?: number;
  bodyTimeout?: number;
  headersTimeout?: number;
}

// Public surface intentionally minimal: only .get().
// The underlying undici dispatcher is not exposed. No mutation methods exist
// on this class. CI test `getOnlyClient-ast.test.ts` asserts that no
// non-GET method literal appears in src/lib/portal/**.
export class GetOnlyClient {
  async get(url: URL | string, opts: GetOpts = {}): Promise<Dispatcher.ResponseData> {
    return request(url, {
      method: "GET",
      headers: opts.headers,
      signal: opts.signal,
      maxRedirections: opts.maxRedirections ?? 0,
      bodyTimeout: opts.bodyTimeout,
      headersTimeout: opts.headersTimeout,
    });
  }
}
