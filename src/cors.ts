/**
 * CORS policy for the Netra OCR API.
 *
 * The browser app in another origin (for example pdf2word on localhost:3000) can only read
 * responses when its origin is listed in NETRA_CORS_ORIGINS. The default is an empty list:
 * no cross-origin access. A wildcard is refused, because any website could then read OCR
 * results from a server on the user's machine.
 *
 * Pure functions with no framework imports, so they can be unit-tested
 * (tests/cors.test.mjs).
 */

/** Parses NETRA_CORS_ORIGINS ("https://a.example, http://localhost:3000") into origins. */
export function parseOriginList(value: string | undefined): string[] {
  if (!value || !value.trim()) return [];
  const origins: string[] = [];
  for (const raw of value.split(",")) {
    const item = raw.trim();
    if (!item) continue;
    if (item === "*") {
      throw new Error("NETRA_CORS_ORIGINS must list explicit origins; '*' is not allowed");
    }
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw new Error(`NETRA_CORS_ORIGINS contains an invalid origin: "${item}"`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`NETRA_CORS_ORIGINS entries must be http or https origins: "${item}"`);
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`NETRA_CORS_ORIGINS entries must be bare origins (no path): "${item}"`);
    }
    origins.push(url.origin);
  }
  return [...new Set(origins)];
}

/**
 * Returns the origin to echo in Access-Control-Allow-Origin, or null when the request
 * origin is missing or not allowed. The comparison uses the normalised origin (scheme,
 * host and port), so a trailing slash or upper-case host still matches.
 */
export function resolveCorsOrigin(
  requestOrigin: string | undefined,
  allowed: readonly string[]
): string | null {
  if (!requestOrigin) return null;
  let normalized: string;
  try {
    normalized = new URL(requestOrigin).origin;
  } catch {
    return null;
  }
  return allowed.includes(normalized) ? normalized : null;
}
