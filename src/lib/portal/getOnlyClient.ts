// Public surface intentionally minimal: only .get().
// The underlying undici dispatcher is not exposed. No mutation methods exist
// on this class.
//
// Enforcement layers (see tests/ci/getOnlyClient-ast.test.ts + scripts/grep-guard.ts):
// - AST check rejects object-literal assignments of `method: "POST|PUT|PATCH|DELETE"`
//   (in all key forms: identifier, string-literal, computed; string-literal
//   and no-substitution-template-literal values both recognized).
// - Grep guard rejects the same patterns line-by-line, plus call-style
//   mutation method invocations (post/put/patch/delete with open-paren).
//
// KNOWN BLIND SPOT: dynamic method strings like `"P" + "OST"`, variable-reference
// values `opts.method = verb`, or template-literal-with-interpolation `` `${verb}` ``
// will slip both layers. This is acceptable — such constructions stand out in
// code review and have no legitimate use case in our portal client.

import { request, type Dispatcher } from "undici";

export interface GetOpts {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  maxRedirections?: number;
  bodyTimeout?: number;
  headersTimeout?: number;
}

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
