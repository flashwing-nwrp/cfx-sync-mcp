#!/usr/bin/env node
// Capture portal HAR, sanitize per explicit field list, write to tests/fixtures/portal/.
// CONTRIBUTING.md references this for post-API-change fixture refreshes.
//
// USAGE: `npm run refresh-fixtures` then log into portal in the launched browser,
// exercise the endpoints you want to capture, then press Enter in the terminal.
//
// SCRUBBING: Explicit field list in docs and enforced below. See tests/fixtures/portal/README.md.

import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const OUT_DIR = path.resolve("tests/fixtures/portal");

const SENSITIVE_HEADER_NAMES = [
  /^cookie$/i, /^set-cookie$/i, /^authorization$/i, /^x-csrf/i,
  /^x-cfx-/i, /session/i, /token/i, /csrf/i,
];
const SENSITIVE_BODY_FIELDS = [
  "email", "id", "avatar_url",
];
const SENSITIVE_QUERY = [/^token$/i, /^signature$/i, /^x-amz-signature$/i];

function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_NAMES.some((re) => re.test(k))) {
      out[k] = "[REDACTED]";
    } else out[k] = v;
  }
  return out;
}

function scrubUrl(u: string): string {
  const url = new URL(u);
  for (const [k] of url.searchParams.entries()) {
    if (SENSITIVE_QUERY.some((re) => re.test(k))) url.searchParams.set(k, "[REDACTED]");
  }
  return url.toString();
}

function scrubBody(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(scrubBody);
  if (body && typeof body === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (SENSITIVE_BODY_FIELDS.includes(k)) out[k] = "[REDACTED]";
      else if (k === "grant_transfers") continue; // strip entirely (D24)
      else out[k] = scrubBody(v);
    }
    return out;
  }
  return body;
}

interface CapturedRecord {
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: false, channel: "chrome" });
  const context = await browser.newContext();
  const page = await context.newPage();
  const records: CapturedRecord[] = [];

  page.on("response", async (res) => {
    const url = res.url();
    if (!/portal-api\.cfx\.re|portal\.cfx\.re/.test(url)) return;
    const req = res.request();
    let body: unknown = null;
    try {
      const txt = await res.text();
      try { body = JSON.parse(txt); } catch { body = txt; }
    } catch { /* drained response */ }
    records.push({
      method: req.method(),
      url: scrubUrl(url),
      requestHeaders: scrubHeaders(req.headers()),
      status: res.status(),
      responseHeaders: scrubHeaders(res.headers()),
      responseBody: scrubBody(body),
    });
  });

  console.log("Opening portal.cfx.re — log in then press Enter here when done.");
  await page.goto("https://portal.cfx.re/assets/granted-assets");
  process.stdin.resume();
  await new Promise<void>((r) => process.stdin.once("data", () => r()));

  await browser.close();
  const out = path.join(OUT_DIR, `capture-${Date.now()}.json`);
  await fs.writeFile(out, JSON.stringify(records, null, 2));
  console.log(`Wrote sanitized fixture: ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
