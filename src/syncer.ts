/**
 * Core sync orchestrator.
 * Coordinates cert discovery, matching, upload, and domain binding.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "./config.js";
import { buildAllMatches, certCoversDomain, domainMatchesPatterns } from "./matcher.js";
import { sameLeafCertificate } from "./pem.js";
import { QiniuCDNClient } from "./qiniu.js";
import type { CertDetail } from "./tencent.js";
import { TencentSSLClient } from "./tencent.js";

export interface SyncResult {
  certDomain: string;
  cdnDomain: string;
  action: "uploaded" | "skipped" | "error";
  certId: string;
  message: string;
}

export interface SyncReport {
  results: SyncResult[];
  totalCerts: number;
  totalDomains: number;
  uploaded: number;
  skipped: number;
  errors: number;
}

export interface ExpiryCheckResult {
  certDomain: string;
  cdnDomain: string;
  certId: string;
  expiresAt: string;
  daysLeft: number | null;
  error?: boolean;
}

export interface VerifyResult {
  cdnDomain: string;
  status:
    | "ok"
    | "unbound"
    | "stale-cert"
    | "expiring"
    | "unmatched"
    | "unreachable";
  certDomain?: string;
  certId?: string;
  expiresAt?: string;
  daysLeft?: number | null;
  message: string;
}

/**
 * Local cache tracking what was uploaded to Qiniu.
 *
 * The cache is keyed by certificate domain, so it records the last uploaded
 * fingerprint plus every Qiniu domain that was bound with that upload:
 * `{ [certDomain]: { fingerprint, certId, bindings: { [cdnDomain]: certId } } }`.
 * `bindings` lets the syncer tell "this domain already has the current cert"
 * from "this domain is new and still needs it", which is what makes a newly
 * added Qiniu domain sync on the next run without touching the fingerprint.
 */
export interface CertCacheEntry {
  fingerprint: string;
  certId: string;
  bindings?: Record<string, string>;
}

export class CertCache {
  private data: Record<string, CertCacheEntry> = {};
  private path: string;

  constructor(cachePath: string) {
    this.path = resolve(cachePath);
    this.load();
  }

  private load(): void {
    try {
      const content = readFileSync(this.path, "utf-8");
      this.data = JSON.parse(content);
    } catch {
      this.data = {};
    }
  }

  save(): void {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  isChanged(certDomain: string, fingerprint: string): boolean {
    const entry = this.data[certDomain];
    if (!entry) return true;
    return entry.fingerprint !== fingerprint;
  }

  getCertId(certDomain: string): string | undefined {
    return this.data[certDomain]?.certId;
  }

  /** Qiniu cert ID last bound to `cdnDomain` by a previous sync, if any. */
  getBoundCertId(certDomain: string, cdnDomain: string): string | undefined {
    return this.data[certDomain]?.bindings?.[cdnDomain];
  }

  /**
   * True when `cdnDomain` already received the certificate with `fingerprint`.
   * A cache written before bindings were tracked has no `bindings` map: treat
   * it as "unknown" so the next run re-binds every domain once and fills it in.
   */
  isBound(certDomain: string, cdnDomain: string, fingerprint: string): boolean {
    const entry = this.data[certDomain];
    if (!entry || entry.fingerprint !== fingerprint || !entry.bindings) {
      return false;
    }
    return Boolean(entry.bindings[cdnDomain]);
  }

  recordBinding(certDomain: string, fingerprint: string, cdnDomain: string, certId: string): void {
    const previous = this.data[certDomain];
    // A renewed certificate invalidates every binding recorded for the old one.
    const bindings =
      previous && previous.fingerprint === fingerprint
        ? { ...(previous.bindings ?? {}) }
        : {};
    bindings[cdnDomain] = certId;
    this.data[certDomain] = { fingerprint, certId, bindings };
    this.save();
  }

  getAllEntries(): Record<string, CertCacheEntry> {
    return { ...this.data };
  }
}

export class Syncer {
  private tencent: TencentSSLClient;
  private qiniu: QiniuCDNClient;
  private cache: CertCache;
  private forceHttps: boolean;
  private config: AppConfig;

  constructor(
    config: AppConfig,
    clients?: {
      tencent?: TencentSSLClient;
      qiniu?: QiniuCDNClient;
      cache?: CertCache;
    }
  ) {
    this.config = config;
    this.tencent =
      clients?.tencent ??
      new TencentSSLClient(
        config.tencent.secretId,
        config.tencent.secretKey,
        config.tencent.region
      );
    this.qiniu =
      clients?.qiniu ??
      new QiniuCDNClient(config.qiniu.accessKey, config.qiniu.secretKey);
    this.cache = clients?.cache ?? new CertCache(config.sync.cacheFile);
    this.forceHttps = config.sync.forceHttps;
  }

  async sync(force = false, dryRun = false): Promise<SyncReport> {
    const report: SyncReport = {
      results: [],
      totalCerts: 0,
      totalDomains: 0,
      uploaded: 0,
      skipped: 0,
      errors: 0,
    };

    // Step 1: List active certs from Tencent Cloud
    const certs = await this.tencent.listCertificates([1]);
    if (certs.length === 0) {
      console.log("No active certificates found in Tencent Cloud");
      return report;
    }

    // Step 2: Get cert details, deduplicate by domain (keep latest CertEndTime)
    certs.sort(
      (a, b) =>
        (b.certEndTime || "").localeCompare(a.certEndTime || "")
    );

    const certDetails = new Map<string, CertDetail>();
    const certDomainsMap = new Map<
      string,
      { isWildcard: boolean; sans: string[] }
    >();

    for (const cert of certs) {
      if (certDetails.has(cert.domain)) continue;
      try {
        const detail = await this.tencent.getCertificateDetail(
          cert.certificateId
        );
        certDetails.set(cert.domain, detail);
        certDomainsMap.set(cert.domain, {
          isWildcard: detail.isWildcard,
          sans: detail.subjectAltNames,
        });
        report.totalCerts++;
      } catch (err: any) {
        console.error(
          `Failed to get detail for cert ${cert.certificateId} (${cert.domain}): ${err.message}`
        );
      }
    }

    // Step 3: List CDN domains from Qiniu (includes domains added since last run)
    const qiniuDomains = await this.qiniu.listDomains();
    if (qiniuDomains.length === 0) {
      console.log("No CDN domains found in Qiniu");
      return report;
    }

    // Step 4: Match certs to domains
    const matches = buildAllMatches(
      certDomainsMap,
      qiniuDomains,
      this.config.domainMappings
    );

    if (matches.size === 0) {
      console.log("No matching certificates found for Qiniu CDN domains");
      return report;
    }

    // Step 5: Sync each pair
    for (const [certDomain, cdnDomains] of matches) {
      const detail = certDetails.get(certDomain);
      if (!detail) continue;

      for (const cdnDomain of cdnDomains) {
        const result = await this.syncOne(
          detail,
          cdnDomain,
          force,
          dryRun
        );
        report.results.push(result);
        report.totalDomains++;
        if (result.action === "uploaded") report.uploaded++;
        else if (result.action === "skipped") report.skipped++;
        else report.errors++;
      }
    }

    // Print summary
    console.log("\n=== Sync Complete ===");
    console.log(`Certificates processed: ${report.totalCerts}`);
    console.log(`Domain bindings: ${report.totalDomains}`);
    console.log(`  Uploaded: ${report.uploaded}`);
    console.log(`  Skipped (unchanged): ${report.skipped}`);
    console.log(`  Errors: ${report.errors}`);

    return report;
  }

  async rebindAll(): Promise<SyncReport> {
    /** Re-bind all cached certs to their domains with current forceHttps setting. */
    const report: SyncReport = {
      results: [],
      totalCerts: 0,
      totalDomains: 0,
      uploaded: 0,
      skipped: 0,
      errors: 0,
    };

    const entries = this.cache.getAllEntries();

    // Need to match to Qiniu domains
    const qiniuDomains = await this.qiniu.listDomains();

    for (const [certDomain, { certId, fingerprint }] of Object.entries(
      entries
    )) {
      // Find matching Qiniu domains
      for (const qd of qiniuDomains) {
        if (domainMatchesPatterns(qd.name, [certDomain])) {
          try {
            await this.qiniu.putHTTPSConf(
              qd.name,
              certId,
              this.forceHttps
            );
            this.cache.recordBinding(
              certDomain,
              fingerprint,
              qd.name,
              certId
            );
            report.results.push({
              certDomain,
              cdnDomain: qd.name,
              action: "uploaded",
              certId,
              message: `Re-bound with forceHttps=${this.forceHttps}`,
            });
            report.uploaded++;
            report.totalDomains++;
          } catch (err: any) {
            report.results.push({
              certDomain,
              cdnDomain: qd.name,
              action: "error",
              certId,
              message: err.message,
            });
            report.errors++;
            report.totalDomains++;
          }
        }
      }
    }

    return report;
  }

  getCache(): CertCache {
    return this.cache;
  }

  async checkExpiry(warnDays = 7): Promise<ExpiryCheckResult[]> {
    const entries = this.cache.getAllEntries();
    const qiniuDomains = await this.qiniu.listDomains();
    const results: ExpiryCheckResult[] = [];

    for (const [certDomain, entry] of Object.entries(entries)) {
      for (const qd of qiniuDomains) {
        if (!domainMatchesPatterns(qd.name, [certDomain])) continue;

        const certId = qd.certId || "";
        const expiresAt = await this.qiniu.getCertNotAfter(certId);
        const timestamp = expiresAt ? Date.parse(expiresAt) : NaN;
        const daysLeft = Number.isNaN(timestamp)
          ? null
          : Math.floor((timestamp - Date.now()) / 86_400_000);
        const result: ExpiryCheckResult = {
          certDomain,
          cdnDomain: qd.name,
          certId,
          expiresAt: expiresAt || "unknown",
          daysLeft,
        };

        const expectedCertId = entry.bindings?.[qd.name] ?? entry.certId;
        if (!certId) {
          console.error(`Qiniu domain ${qd.name} has no certificate bound`);
          result.error = true;
        } else if (expectedCertId !== certId) {
          console.error(
            `Qiniu domain ${qd.name} is bound to a different certificate than the sync cache`
          );
          result.error = true;
        } else if (daysLeft === null) {
          console.error(`Cannot read the expiry of the Qiniu certificate for ${qd.name}`);
          result.error = true;
        } else if (daysLeft <= warnDays) {
          console.error(
            `Qiniu certificate for ${qd.name} expires ${expiresAt} (${daysLeft} days left)`
          );
          result.error = true;
        } else {
          console.log(`${qd.name}: ${daysLeft} days until certificate expiry`);
        }
        results.push(result);
      }
    }

    if (results.length === 0 && Object.keys(entries).length > 0) {
      throw new Error("No Qiniu domains match the cached certificates");
    }

    // A Qiniu domain that no cached certificate covers is never bound by
    // `sync`, so the expiry check is the only place that can surface it.
    const covered = new Set(results.map((r) => r.cdnDomain));
    for (const qd of qiniuDomains) {
      if (qd.type === "test" || covered.has(qd.name)) continue;
      if (!qd.certId) {
        console.warn(
          `Qiniu domain ${qd.name} has no certificate bound and no cached cert matches it; add a matching cert in Tencent Cloud`
        );
      }
    }

    return results;
  }

  /**
   * End-to-end verification, independent of the cache file.
   *
   * For every production Qiniu CDN domain it checks that a Tencent
   * certificate covers it, that the domain has a certificate bound in Qiniu,
   * that the bound certificate's validity reaches `minDaysLeft`, and that the
   * domain is reachable over HTTPS. Used by CI after `sync` so a newly added
   * domain that failed to bind fails the job instead of being discovered
   * later from a browser warning.
   */
  async verify(
    minDaysLeft = 7,
    opts: { checkReachability?: boolean } = {}
  ): Promise<VerifyResult[]> {
    const certs = await this.tencent.listCertificates([1]);
    const details: CertDetail[] = [];
    const seen = new Set<string>();
    for (const cert of certs) {
      if (seen.has(cert.domain)) continue;
      seen.add(cert.domain);
      try {
        details.push(
          await this.tencent.getCertificateDetail(cert.certificateId)
        );
      } catch (err: any) {
        console.error(
          `Verification: could not read cert ${cert.certificateId} (${cert.domain}): ${err.message}`
        );
      }
    }

    const qiniuDomains = await this.qiniu.listDomains();
    const results: VerifyResult[] = [];

    for (const qd of qiniuDomains) {
      if (qd.type === "test") continue;

      // Prefer the certificate whose own domain is an exact match (that is
      // what `buildAllMatches` binds), then the one valid the longest.
      const cover = details
        .filter((d) =>
          certCoversDomain(
            d.domain,
            d.isWildcard,
            d.subjectAltNames,
            qd.name
          )
        )
        .sort((a, b) => {
          const aExact = a.domain === qd.name ? 0 : 1;
          const bExact = b.domain === qd.name ? 0 : 1;
          if (aExact !== bExact) return aExact - bExact;
          return (b.certEndTime || "").localeCompare(a.certEndTime || "");
        })[0];

      if (!cover) {
        results.push({
          cdnDomain: qd.name,
          status: "unmatched",
          certId: qd.certId,
          message: `No Tencent Cloud certificate covers ${qd.name}; add one in Tencent Cloud`,
        });
        continue;
      }

      if (!qd.certId) {
        results.push({
          cdnDomain: qd.name,
          certDomain: cover.domain,
          status: "unbound",
          message: `${qd.name} has no certificate bound in Qiniu`,
        });
        continue;
      }

      const expiresAt = await this.qiniu.getCertNotAfter(qd.certId);
      const timestamp = expiresAt ? Date.parse(expiresAt) : NaN;
      const daysLeft = Number.isNaN(timestamp)
        ? null
        : Math.floor((timestamp - Date.now()) / 86_400_000);

      if (daysLeft === null) {
        results.push({
          cdnDomain: qd.name,
          certDomain: cover.domain,
          status: "stale-cert",
          certId: qd.certId,
          message: `Cannot read the expiry of the certificate bound to ${qd.name}`,
        });
        continue;
      }

      // Compare certificate contents, not just expiry: a renewed certificate
      // can have the same remaining lifetime while being a different cert.
      const boundPem = await this.qiniu.getCertPem(qd.certId);
      if (!sameLeafCertificate(boundPem, cover.publicKey)) {
        results.push({
          cdnDomain: qd.name,
          certDomain: cover.domain,
          status: "stale-cert",
          certId: qd.certId,
          expiresAt,
          daysLeft,
          message: `${qd.name} is not bound to the current Tencent Cloud certificate for ${cover.domain}`,
        });
        continue;
      }

      if (daysLeft <= minDaysLeft) {
        results.push({
          cdnDomain: qd.name,
          certDomain: cover.domain,
          status: "expiring",
          certId: qd.certId,
          expiresAt: expiresAt!,
          daysLeft,
          message: `Certificate on ${qd.name} expires in ${daysLeft} days`,
        });
        continue;
      }

      results.push({
        cdnDomain: qd.name,
        certDomain: cover.domain,
        status: "ok",
        certId: qd.certId,
        expiresAt: expiresAt!,
        daysLeft,
        message: `Bound to ${cover.domain}, ${daysLeft} days left`,
      });
    }

    if (opts.checkReachability) {
      for (const result of results) {
        if (!(await this.isHttpsReachable(result.cdnDomain))) {
          result.status = "unreachable";
          result.message = `${result.message}; ${result.cdnDomain} did not complete a verified HTTPS handshake`;
        }
      }
    }

    return results;
  }

  private async isHttpsReachable(domain: string): Promise<boolean> {
    try {
      const resp = await fetch(`https://${domain}/`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      // Any HTTP answer means TLS negotiated successfully; fetch rejects on
      // certificate errors, connection failures, and timeouts.
      return resp.status > 0;
    } catch (err: any) {
      console.error(`HTTPS check failed for ${domain}: ${err.message}`);
      return false;
    }
  }

  private async syncOne(
    certInfo: CertDetail,
    cdnDomain: string,
    force: boolean,
    dryRun: boolean
  ): Promise<SyncResult> {
    const certDomain = certInfo.domain;

    // Per-domain cache: a new Qiniu domain has no binding yet, so it is synced
    // even when the certificate fingerprint itself is unchanged.
    if (
      !force &&
      this.cache.isBound(certDomain, cdnDomain, certInfo.fingerprint)
    ) {
      const cachedCertId =
        this.cache.getBoundCertId(certDomain, cdnDomain) || "";
      console.log(
        `Certificate ${certDomain} unchanged and already bound, skipping ${cdnDomain}`
      );
      return {
        certDomain,
        cdnDomain,
        action: "skipped",
        certId: cachedCertId,
        message: "Certificate unchanged and already bound",
      };
    }

    // Check private key (only needed when the cert still has to be uploaded
    // to Qiniu; re-binding a cached cert ID works without it).
    const cachedCertId = this.cache.getCertId(certDomain);
    const canReuse =
      cachedCertId &&
      !this.cache.isChanged(certDomain, certInfo.fingerprint);

    if (!certInfo.privateKey && !canReuse) {
      return {
        certDomain,
        cdnDomain,
        action: "error" as const,
        certId: "",
        message:
          "Private key not available (free certs may not expose key via API)",
      };
    }

    if (dryRun) {
      console.log(
        `[DRY RUN] Would upload cert ${certDomain} and bind to ${cdnDomain}`
      );
      return {
        certDomain,
        cdnDomain,
        action: "skipped" as const,
        certId: "",
        message: "Dry run: would upload and bind",
      };
    }

    // Upload + bind. Reuse the Qiniu cert uploaded for this fingerprint when
    // one exists, so adding a domain does not create a duplicate certificate.
    try {
      const certName = `synced-${certDomain}`;
      let qiniuCertId = "";

      if (
        !this.cache.isChanged(certDomain, certInfo.fingerprint)
      ) {
        qiniuCertId = this.cache.getCertId(certDomain) ?? "";
        if (qiniuCertId) {
          console.log(
            `Reusing Qiniu cert ${qiniuCertId} for ${certDomain} → ${cdnDomain}...`
          );
        }
      }

      if (!qiniuCertId) {
        console.log(`Uploading cert ${certDomain} → ${cdnDomain}...`);
        qiniuCertId = await this.qiniu.createSSLCert(
          certName,
          certDomain,
          certInfo.privateKey,
          certInfo.publicKey
        );
      }

      await this.qiniu.putHTTPSConf(
        cdnDomain,
        qiniuCertId,
        this.forceHttps
      );

      this.cache.recordBinding(
        certDomain,
        certInfo.fingerprint,
        cdnDomain,
        qiniuCertId
      );

      console.log(`  ✓ ${certDomain} → ${cdnDomain} (certID: ${qiniuCertId})`);
      return {
        certDomain,
        cdnDomain,
        action: "uploaded",
        certId: qiniuCertId,
        message: "Certificate uploaded and bound successfully",
      };
    } catch (err: any) {
      console.error(`  ✗ Failed: ${err.message}`);
      return {
        certDomain,
        cdnDomain,
        action: "error" as const,
        certId: "",
        message: err.message,
      };
    }
  }
}
