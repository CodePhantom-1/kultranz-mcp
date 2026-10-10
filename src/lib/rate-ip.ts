/**
 * Rate-limit IP normalization. IPv6 addresses are truncated to their /64
 * (interface identifier stripped) so a rotating client cannot mint fresh
 * meter buckets from the same allocation. IPv4 and anything unparseable
 * (e.g. the literal "unknown" fallback) pass through unchanged.
 */
export function normalizeRateIp(ip: string): string {
  if (!ip.includes(":")) return ip; // IPv4 or opaque fallback
  const addr = ip.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const parts = addr.split("::");
  if (parts.length > 2) return ip; // malformed - leave as-is
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  const groups =
    parts.length === 2
      ? [...head, ...Array(Math.max(missing, 0)).fill("0"), ...tail]
      : head;
  if (groups.length !== 8) return ip; // not a full address - leave as-is
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return ip; // malformed - leave as-is
  return groups.slice(0, 4).join(":");
}
