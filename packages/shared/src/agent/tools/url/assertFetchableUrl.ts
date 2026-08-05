import { promises as dns } from "node:dns";
import { AppError } from "../../../errors";

/**
 * SSRF guard for the read_url tool (Phase 11).
 *
 * read_url fetches a user-supplied URL, so the destination is attacker-chosen.
 * The primary defense is architectural — the generic path hands the URL to
 * Tavily, whose servers do the fetch, and the GitHub path only ever builds
 * api.github.com URLs — but this validator is the pre-egress backstop: it runs
 * BEFORE either path so an obviously-internal target never even becomes a Tavily
 * call, and so the guard stays correct if a direct-fetch branch is ever added.
 *
 * It rejects, with a user-safe AppError and no network access:
 *   - non-HTTP(S) schemes (file://, gopher://, ftp:// …)
 *   - internal hostnames (localhost, *.local, *.internal)
 *   - IP literals in a private/loopback/link-local/reserved range, including the
 *     cloud metadata address 169.254.169.254 (which would leak instance IAM
 *     credentials — invariant #5)
 *   - hostnames that RESOLVE to such an address (best-effort DNS lookup, so a
 *     public name pointed at a private IP is caught too)
 */

/** Parse "a.b.c.d" to four octets, or null if it isn't a dotted-quad IPv4. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return octets as [number, number, number, number];
}

/** True for an IPv4 in a private, loopback, link-local, or reserved range. */
function isBlockedIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  return (
    a === 0 || // 0.0.0.0/8 "this host"
    a === 10 || // 10.0.0.0/8 private
    a === 127 || // 127.0.0.0/8 loopback
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local (incl. cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 carrier-grade NAT
  );
}

/**
 * True for a blocked IPv6 literal: loopback (::1), unspecified (::), unique-local
 * (fc00::/7), and link-local (fe80::/10). IPv4-mapped addresses (::ffff:a.b.c.d)
 * are unwrapped and checked as IPv4 so the mapping can't smuggle a private v4 in.
 */
function isBlockedIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true;
  const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    const v4Part = mapped[1];
    const v4 = v4Part ? parseIpv4(v4Part) : null;
    return v4 ? isBlockedIpv4(v4) : true;
  }
  return h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb");
}

/** True for any IP literal (v4 or v6) that sits in a blocked range. */
function isBlockedIp(host: string): boolean {
  const v4 = parseIpv4(host);
  if (v4) return isBlockedIpv4(v4);
  if (host.includes(":")) return isBlockedIpv6(host);
  return false;
}

const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost"];

function reject(message: string): never {
  throw new AppError("invalid_input", message);
}

/**
 * Validate a user-supplied URL for fetching. Throws a user-safe AppError if the
 * URL is malformed, uses a non-HTTP scheme, or targets an internal/private host.
 * Async because it best-effort resolves the hostname and re-checks every address
 * DNS returns, catching a public name that points at a private IP. A hostname
 * that fails to resolve is NOT blocked here (that's a fetch failure, not an SSRF
 * risk); the downstream fetch simply returns nothing.
 */
export async function assertFetchableUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    reject("That doesn't look like a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    reject("Only http and https URLs can be read.");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.length === 0) reject("That URL has no host.");
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    reject("That URL points at an internal host, which can't be read.");
  }
  if (isBlockedIp(host)) {
    reject("That URL points at a private or reserved address, which can't be read.");
  }

  // Best-effort: resolve the name and reject if ANY address is in a blocked
  // range. Silently ignore resolution failures — a name that doesn't resolve is
  // a dead link, not an SSRF vector.
  try {
    const records = await dns.lookup(host, { all: true });
    if (records.some((r) => isBlockedIp(r.address))) {
      reject("That URL resolves to a private or reserved address, which can't be read.");
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    // DNS failure: leave validation to the fetch, which will simply come back empty.
  }

  return url;
}
