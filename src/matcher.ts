/**
 * Domain matching logic.
 * Matches Tencent Cloud cert domains to Qiniu CDN domains.
 * Supports both manual config and automatic matching.
 */

import type { DomainMapping } from "./config.js";
import type { QiniuDomain } from "./qiniu.js";

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Build a list of domain patterns covered by a certificate.
 */
function buildCoveredPatterns(
  certDomain: string,
  isWildcard: boolean,
  subjectAltNames: string[]
): string[] {
  const patterns: string[] = [];
  const normalized = normalizeHost(certDomain);

  // Trust the `*.` prefix: Tencent reports wildcard certificates with a
  // `*.example.com` domain, and IsWildcard alone does not say which name is
  // covered.
  if (normalized.startsWith("*.") || (isWildcard && normalized.includes("*."))) {
    const base = normalized.replace(/^\*\./, "");
    patterns.push(`*.${base}`); // matches exactly one label: a.example.com
  }
  patterns.push(normalized);

  for (const san of subjectAltNames) {
    const normalizedSan = normalizeHost(san);
    if (normalizedSan && !patterns.includes(normalizedSan)) {
      patterns.push(normalizedSan);
    }
  }

  return patterns;
}

/**
 * Check if a domain matches any of the patterns.
 * A `*.example.com` pattern covers `a.example.com` but not `a.b.example.com`
 * and not the apex `example.com`, mirroring TLS hostname matching.
 */
export function domainMatchesPatterns(domain: string, patterns: string[]): boolean {
  const host = normalizeHost(domain);
  for (const pattern of patterns) {
    if (host === pattern) return true;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      if (!host.endsWith(suffix)) continue;
      const label = host.slice(0, -suffix.length);
      if (label.length > 0 && !label.includes(".")) return true;
    }
  }
  return false;
}

/**
 * True when a certificate (its CN plus SANs) covers `domain`.
 */
export function certCoversDomain(
  certDomain: string,
  certIsWildcard: boolean,
  certSubjectAltNames: string[],
  domain: string
): boolean {
  return domainMatchesPatterns(
    domain,
    buildCoveredPatterns(certDomain, certIsWildcard, certSubjectAltNames)
  );
}

/**
 * Match a single cert to Qiniu CDN domains.
 */
export function matchCertToDomains(
  certDomain: string,
  certIsWildcard: boolean,
  certSubjectAltNames: string[],
  qiniuDomains: QiniuDomain[],
  manualMapping?: DomainMapping
): string[] {
  // Manual mapping with explicit cdnDomains takes priority
  if (manualMapping?.cdnDomains.length) {
    return [...manualMapping.cdnDomains].sort();
  }

  // Build exclude set
  const excludeSet = new Set(manualMapping?.excludeCdnDomains || []);

  // If auto_match is disabled, return empty
  if (manualMapping && !manualMapping.autoMatch) {
    return [];
  }

  const patterns = buildCoveredPatterns(
    certDomain,
    certIsWildcard,
    certSubjectAltNames
  );

  const matched: string[] = [];
  for (const qdomain of qiniuDomains) {
    if (excludeSet.has(qdomain.name)) continue;
    if (domainMatchesPatterns(qdomain.name, patterns)) {
      matched.push(qdomain.name);
    }
  }

  return matched.sort();
}

/**
 * Build complete certificate-to-CDN-domains mapping.
 *
 * A Qiniu domain is bound to at most one certificate: an exact cert-domain
 * match wins over a wildcard match, and the rest are left for the next cert.
 * Without this, two certs covering the same domain would overwrite each
 * other's binding on every run.
 */
export function buildAllMatches(
  certDomainsMap: Map<string, { isWildcard: boolean; sans: string[] }>,
  qiniuDomains: QiniuDomain[],
  manualMappings: DomainMapping[]
): Map<string, string[]> {
  const manualLookup = new Map<string, DomainMapping>();
  for (const m of manualMappings) {
    manualLookup.set(m.certDomain, m);
  }

  const result = new Map<string, string[]>();
  const claimed = new Map<string, string>(); // cdnDomain -> certDomain

  // Exact cert domains first so they beat wildcard certificates.
  const certDomains = [...certDomainsMap.keys()].sort((a, b) => {
    const aWild = certDomainsMap.get(a)!.isWildcard || a.startsWith("*.");
    const bWild = certDomainsMap.get(b)!.isWildcard || b.startsWith("*.");
    if (aWild !== bWild) return aWild ? 1 : -1;
    return a.localeCompare(b);
  });

  for (const certDomain of certDomains) {
    const { isWildcard, sans } = certDomainsMap.get(certDomain)!;
    const manual = manualLookup.get(certDomain);
    const matched = matchCertToDomains(
      certDomain,
      isWildcard,
      sans,
      qiniuDomains,
      manual
    ).filter((cdnDomain) => {
      const owner = claimed.get(cdnDomain);
      if (owner === undefined) return true;
      console.warn(
        `Qiniu domain ${cdnDomain} matches both ${owner} and ${certDomain}; keeping ${owner}`
      );
      return false;
    });

    for (const cdnDomain of matched) claimed.set(cdnDomain, certDomain);
    if (matched.length > 0) {
      result.set(certDomain, matched);
    }
  }

  return result;
}
