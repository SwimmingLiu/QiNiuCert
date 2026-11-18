/**
 * Domain matching logic.
 * Decides which Tencent Cloud certificate should be bound to each Qiniu CDN
 * domain. Supports both manual config and automatic matching.
 */

import type { DomainMapping } from "./config.js";
import type { QiniuDomain } from "./qiniu.js";

/** A certificate that is currently active in Tencent Cloud. */
export interface CertCandidate {
  certificateId: string;
  domain: string;
  fingerprint: string;
  isWildcard: boolean;
  sans: string[];
  certEndTime: string;
  publicKey: string;
}

/** One certificate plus every Qiniu domain that should be bound with it. */
export interface BindingPlan {
  cert: CertCandidate;
  cdnDomains: string[];
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function wildcardMatches(pattern: string, host: string): boolean {
  if (!pattern.startsWith("*.")) return false;
  const suffix = pattern.slice(1); // ".example.com"
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, -suffix.length);
  return label.length > 0 && !label.includes(".");
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
    const normalized = normalizeHost(pattern);
    if (host === normalized) return true;
    if (wildcardMatches(normalized, host)) return true;
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
 * How specifically a certificate covers a host; lower is better.
 * `undefined` means the certificate does not cover the host at all.
 */
export function matchRank(cert: CertCandidate, host: string): number | undefined {
  const h = normalizeHost(host);
  const cn = normalizeHost(cert.domain);

  if (!cn.startsWith("*.") && cn === h) return 0; // exact CN
  if (cn.startsWith("*.") && wildcardMatches(cn, h)) return 1; // wildcard CN
  const sans = cert.sans.map(normalizeHost).filter(Boolean);
  if (sans.includes(h)) return 2; // exact SAN
  if (sans.some((san) => wildcardMatches(san, h))) return 3; // wildcard SAN
  return undefined;
}

/**
 * Pick the certificate that should serve `host`: the most specific match wins
 * (exact CN, wildcard CN, exact SAN, wildcard SAN), and among equally specific
 * certificates the one valid the longest.
 */
export function selectCertForDomain(
  host: string,
  certs: CertCandidate[]
): CertCandidate | undefined {
  let best: CertCandidate | undefined;
  let bestRank = Infinity;
  for (const cert of certs) {
    const rank = matchRank(cert, host);
    if (rank === undefined) continue;
    if (
      rank < bestRank ||
      (rank === bestRank &&
        (cert.certEndTime || "").localeCompare(best?.certEndTime || "") > 0)
    ) {
      best = cert;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Qiniu domains the configuration excludes from management.
 * Values are normalized so case and a trailing dot cannot defeat an exclusion.
 */
export function excludedDomains(manualMappings: DomainMapping[]): Set<string> {
  const excluded = new Set<string>();
  for (const mapping of manualMappings) {
    for (const domain of mapping.excludeCdnDomains) {
      excluded.add(normalizeHost(domain));
    }
  }
  return excluded;
}

/**
 * Build the certificate -> CDN domains plan for one sync run.
 *
 * - Explicit `cdn_domains` mappings win over automatic matching.
 * - `exclude_cdn_domains` removes a domain from management entirely.
 * - `auto_match: false` keeps a certificate out of automatic matching.
 * - A domain is bound to exactly one certificate, the most specific match.
 *
 * `sync`, `verify` and `check-expiry` all use this plan, so the certificate
 * `verify` expects is by construction the one `sync` would bind.
 */
export function buildBindingPlan(
  certs: CertCandidate[],
  qiniuDomains: QiniuDomain[],
  manualMappings: DomainMapping[]
): BindingPlan[] {
  const excluded = excludedDomains(manualMappings);

  // certificate domain (normalized) -> mapping
  const mappingByCertDomain = new Map<string, DomainMapping>();
  for (const mapping of manualMappings) {
    const key = normalizeHost(mapping.certDomain);
    if (!mappingByCertDomain.has(key)) mappingByCertDomain.set(key, mapping);
  }

  const certByDomain = new Map<string, CertCandidate>();
  for (const cert of certs) {
    const key = normalizeHost(cert.domain);
    const existing = certByDomain.get(key);
    if (
      !existing ||
      (cert.certEndTime || "").localeCompare(existing.certEndTime || "") > 0
    ) {
      certByDomain.set(key, cert);
    }
  }

  // Explicit cdn_domains assignments: normalized CDN domain -> certificate.
  const explicit = new Map<string, CertCandidate>();
  for (const mapping of manualMappings) {
    if (mapping.cdnDomains.length === 0) continue;
    const cert = certByDomain.get(normalizeHost(mapping.certDomain));
    if (!cert) {
      console.warn(
        `Manual mapping for ${mapping.certDomain} has no matching active certificate`
      );
      continue;
    }
    for (const domain of mapping.cdnDomains) {
      const key = normalizeHost(domain);
      if (excluded.has(key)) continue;
      if (explicit.has(key)) {
        console.warn(
          `Qiniu domain ${key} is mapped by more than one cert; keeping the first`
        );
        continue;
      }
      explicit.set(key, cert);
    }
  }

  const autoCerts = certs.filter((cert) => {
    const mapping = mappingByCertDomain.get(normalizeHost(cert.domain));
    if (!mapping) return true;
    // `cdn_domains` is authoritative for its certificate: only those domains
    // are bound with it, so it takes no part in automatic matching.
    if (mapping.cdnDomains.length > 0) return false;
    return mapping.autoMatch;
  });

  const byCert = new Map<string, BindingPlan>();

  const addDomain = (cert: CertCandidate, name: string) => {
    let entry = byCert.get(cert.certificateId);
    if (!entry) {
      entry = { cert, cdnDomains: [] };
      byCert.set(cert.certificateId, entry);
    }
    const key = normalizeHost(name);
    if (!entry.cdnDomains.some((d) => normalizeHost(d) === key)) {
      entry.cdnDomains.push(name);
    }
  };

  const knownQiniuDomains = new Set(
    qiniuDomains.map((domain) => normalizeHost(domain.name))
  );

  for (const qiniuDomain of qiniuDomains) {
    const key = normalizeHost(qiniuDomain.name);
    if (!key || excluded.has(key)) continue;

    const cert =
      explicit.get(key) ?? selectCertForDomain(qiniuDomain.name, autoCerts);
    if (!cert) continue;
    addDomain(cert, qiniuDomain.name);
  }

  // Explicitly mapped domains are bound even when the Qiniu `/domain` list
  // does not include them (a mapping is a destination, not a lookup).
  for (const [key, cert] of explicit) {
    if (knownQiniuDomains.has(key)) continue;
    console.warn(
      `Manually mapped Qiniu domain ${key} is not in the Qiniu domain list`
    );
    addDomain(cert, key);
  }

  const plan = [...byCert.values()].sort((a, b) =>
    a.cert.domain.localeCompare(b.cert.domain)
  );
  for (const entry of plan) entry.cdnDomains.sort();
  return plan;
}

/**
 * Match a single cert to Qiniu CDN domains.
 * Kept for API compatibility; uses the same ranking as `buildBindingPlan`.
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

  const excludeSet = excludedDomains(manualMapping ? [manualMapping] : []);

  // If auto_match is disabled, return empty
  if (manualMapping && !manualMapping.autoMatch) {
    return [];
  }

  const cert: CertCandidate = {
    certificateId: "",
    domain: certDomain,
    fingerprint: "",
    isWildcard: certIsWildcard,
    sans: certSubjectAltNames,
    certEndTime: "",
    publicKey: "",
  };

  const matched: string[] = [];
  for (const qdomain of qiniuDomains) {
    if (excludeSet.has(normalizeHost(qdomain.name))) continue;
    if (matchRank(cert, qdomain.name) !== undefined) {
      matched.push(qdomain.name);
    }
  }

  return matched.sort();
}
