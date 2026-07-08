/**
 * Domain matching logic.
 * Matches Tencent Cloud cert domains to Qiniu CDN domains.
 * Supports both manual config and automatic matching.
 */

import type { DomainMapping } from "./config.js";
import type { QiniuDomain } from "./qiniu.js";

/**
 * Build a list of domain patterns covered by a certificate.
 */
function buildCoveredPatterns(
  certDomain: string,
  isWildcard: boolean,
  subjectAltNames: string[]
): string[] {
  const patterns: string[] = [];

  if (isWildcard || certDomain.startsWith("*.")) {
    const base = certDomain.replace(/^\*\./, "");
    patterns.push(`.${base}`); // matches subdomain.example.com
    patterns.push(base); // matches example.com
  } else {
    patterns.push(certDomain);
  }

  for (const san of subjectAltNames) {
    if (!patterns.includes(san)) {
      patterns.push(san);
    }
  }

  return patterns;
}

/**
 * Check if a domain matches any of the patterns.
 */
function domainMatchesPatterns(domain: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (domain === pattern) return true;
    if (pattern.startsWith(".") && domain.endsWith(pattern)) return true;
  }
  return false;
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

  for (const [certDomain, { isWildcard, sans }] of certDomainsMap) {
    const manual = manualLookup.get(certDomain);
    const matched = matchCertToDomains(
      certDomain,
      isWildcard,
      sans,
      qiniuDomains,
      manual
    );
    if (matched.length > 0) {
      result.set(certDomain, matched);
    }
  }

  return result;
}
