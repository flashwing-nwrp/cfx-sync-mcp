export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number; // unix seconds; -1 or missing = session
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}

export class CookieJar {
  private cookies: CookieEntry[] = [];

  replaceAll(cookies: CookieEntry[]): void {
    this.cookies = cookies;
  }

  clear(): void {
    this.cookies = [];
  }

  count(): number {
    return this.cookies.length;
  }

  longestExpiry(): number | null {
    let max: number | null = null;
    for (const c of this.cookies) {
      if (typeof c.expires === "number" && c.expires > 0) {
        max = max === null ? c.expires : Math.max(max, c.expires);
      }
    }
    return max;
  }

  headerFor(urlStr: string): string {
    const url = new URL(urlStr);
    const host = url.hostname;
    const applicable = this.cookies.filter((c) => {
      const d = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
      return host === d || host.endsWith("." + d);
    });
    return applicable.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  snapshot(): CookieEntry[] {
    return this.cookies.map((c) => ({ ...c }));
  }
}
