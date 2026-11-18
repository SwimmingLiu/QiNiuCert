/**
 * Core sync orchestrator.
 * Coordinates cert discovery, matching, upload, and domain binding.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "./config.js";
import type { BindingPlan, CertCandidate } from "./matcher.js";
import {
  buildBindingPlan,
  certCoversDomain,
  excludedDomains,
  normalizeHost,
  selectCertForDomain,
} from "./matcher.js";
import { sameLeafCertificate } from "./pem.js";
import { QiniuCDNClient, type QiniuDomain } from "./qiniu.js";
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
  /** Certificates whose details could not be read from Tencent Cloud. */
  failedCertificates: number;
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
 * Keyed by certificate domain. `certIds` lists every Qiniu certificate known
 * to carry `fingerprint` (so a renewal can never be mistaken for the old one),
 * and `bindings` records which CDN domain received which Qiniu certificate.
 * A CDN domain missing from `bindings` is a new domain and gets bound on the
 * next run even though the certificate itself has not changed.
 */
export interface CertCacheEntry {
  fingerprint: string;
  certId: string;
  certIds?: string[];
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

  /** Every Qiniu certificate ID known to carry `fingerprint`. */
  knownCertIds(certDomain: string, fingerprint: string): Set<string> {
    const entry = this.data[certDomain];
    if (!entry || entry.fingerprint !== fingerprint) return new Set();
    const ids = new Set(entry.certIds ?? []);
    if (entry.certId) ids.add(entry.certId);
    return ids;
  }

  /** Qiniu cert ID last bound to `cdnDomain` by a previous sync, if any. */
  getBoundCertId(certDomain: string, cdnDomain: string): string | undefined {
    return this.data[certDomain]?.bindings?.[cdnDomain];
  }

  recordCert(certDomain: string, fingerprint: string, certId: string): void {
    const previous = this.data[certDomain];
    const sameCert = previous?.fingerprint === fingerprint;
    const certIds = new Set(sameCert ? previous?.certIds ?? [] : []);
    if (sameCert && previous?.certId) certIds.add(previous.certId);
    certIds.add(certId);
    this.data[certDomain] = {
      fingerprint,
      certId,
      certIds: [...certIds],
      bindings: sameCert ? { ...(previous?.bindings ?? {}) } : {},
    };
    this.save();
  }

  recordBinding(certDomain: string, cdnDomain: string, certId: string): void {
    const entry = this.data[certDomain];
    if (!entry) return;
    entry.bindings = { ...(entry.bindings ?? {}), [cdnDomain]: certId };
    this.save();
  }

  forget(certDomain: string): void {
    delete this.data[certDomain];
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

  /**
   * Read every active certificate. Failures are counted rather than swallowed,
   * so a certificate that could not be read cannot make the run look clean.
   */
  private async loadCertificates(): Promise<{
    details: CertDetail[];
    failures: number;
  }> {
    const summaries = await this.tencent.listCertificates([1]);
    const details: CertDetail[] = [];
    let failures = 0;

    for (const summary of summaries) {
      try {
        const detail = await this.tencent.getCertificateDetail(
          summary.certificateId
        );
        if (detail.domain) details.push(detail);
      } catch (err: any) {
        failures++;
        console.error(
          `Failed to get detail for cert ${summary.certificateId} (${summary.domain}): ${err.message}`
        );
      }
    }

    return { details, failures };
  }

  private buildPlan(details: CertDetail[], qiniuDomains: QiniuDomain[]): BindingPlan[] {
    const candidates: CertCandidate[] = details.map((detail) => ({
      certificateId: detail.certificateId,
      domain: detail.domain,
      fingerprint: detail.fingerprint,
      isWildcard: detail.isWildcard,
      sans: detail.subjectAltNames,
      certEndTime: detail.certEndTime,
      publicKey: detail.publicKey,
    }));
    return buildBindingPlan(
      candidates,
      qiniuDomains,
      this.config.domainMappings
    );
  }

  async sync(force = false, dryRun = false): Promise<SyncReport> {
    const report: SyncReport = {
      results: [],
      totalCerts: 0,
      totalDomains: 0,
      uploaded: 0,
      skipped: 0,
      errors: 0,
      failedCertificates: 0,
    };

    const { details, failures } = await this.loadCertificates();
    report.failedCertificates = failures;
    // A certificate we could not read may have been the one covering a Qiniu
    // domain, so it must fail the run even if every other binding succeeds.
    report.errors = failures;
    report.totalCerts = details.length;
    if (details.length === 0) {
      console.log("No active certificates found in Tencent Cloud");
      return report;
    }

    // Live list: domains added on Qiniu since the last run show up here.
    const qiniuDomains = await this.qiniu.listDomains();
    if (qiniuDomains.length === 0) {
      console.log("No CDN domains found in Qiniu");
      return report;
    }

    const plan = this.buildPlan(details, qiniuDomains);
    if (plan.length === 0) {
      console.log("No matching certificates found for Qiniu CDN domains");
      return report;
    }

    const detailById = new Map(details.map((d) => [d.certificateId, d]));

    for (const { cert, cdnDomains } of plan) {
      const detail = detailById.get(cert.certificateId);
      if (!detail) continue;

      for (const cdnDomain of cdnDomains) {
        const result = await this.syncOne(
          detail,
          cdnDomain,
          qiniuDomains,
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

    console.log("\n=== Sync Complete ===");
    console.log(`Certificates processed: ${report.totalCerts}`);
    console.log(`Domain bindings: ${report.totalDomains}`);
    console.log(`  Uploaded: ${report.uploaded}`);
    console.log(`  Skipped (unchanged): ${report.skipped}`);
    console.log(`  Errors: ${report.errors}`);
    if (report.failedCertificates > 0) {
      console.warn(
        `  Certificate read failures: ${report.failedCertificates} (rerun or check Tencent Cloud)`
      );
    }

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
      failedCertificates: 0,
    };

    const entries = this.cache.getAllEntries();
    const qiniuDomains = await this.qiniu.listDomains();

    for (const [certDomain, entry] of Object.entries(entries)) {
      // Rebind every domain this certificate was bound to, including SAN
      // domains whose name is not the certificate domain.
      const domains = new Set(Object.keys(entry.bindings ?? {}));
      for (const qd of qiniuDomains) {
        if (normalizeHost(qd.name) === normalizeHost(certDomain)) {
          domains.add(qd.name);
        }
      }

      for (const cdnDomain of domains) {
        try {
          await this.qiniu.putHTTPSConf(
            cdnDomain,
            entry.certId,
            this.forceHttps
          );
          this.cache.recordBinding(certDomain, cdnDomain, entry.certId);
          report.results.push({
            certDomain,
            cdnDomain,
            action: "uploaded",
            certId: entry.certId,
            message: `Re-bound with forceHttps=${this.forceHttps}`,
          });
          report.uploaded++;
          report.totalDomains++;
        } catch (err: any) {
          report.results.push({
            certDomain,
            cdnDomain,
            action: "error",
            certId: entry.certId,
            message: err.message,
          });
          report.errors++;
          report.totalDomains++;
        }
      }
    }

    return report;
  }

  getCache(): CertCache {
    return this.cache;
  }

  /**
   * Expiry of what Qiniu actually serves, for the domains this tool manages.
   * Uses the same plan as `sync`, so exclusions and manual mappings are
   * honoured and a SAN-only certificate is not treated as unmatched.
   */
  async checkExpiry(warnDays = 7): Promise<ExpiryCheckResult[]> {
    const { details } = await this.loadCertificates();
    const qiniuDomains = await this.qiniu.listDomains();
    const plan = this.buildPlan(details, qiniuDomains);
    const live = new Map(qiniuDomains.map((d) => [normalizeHost(d.name), d]));
    const results: ExpiryCheckResult[] = [];

    for (const { cert, cdnDomains } of plan) {
      for (const cdnDomain of cdnDomains) {
        const qd = live.get(normalizeHost(cdnDomain));
        const certId = qd?.certId || "";
        let expiresAt: string | undefined;
        let failure: string | undefined;

        try {
          expiresAt = await this.qiniu.getCertNotAfter(certId);
        } catch (err: any) {
          failure = err.message;
        }

        const timestamp = expiresAt ? Date.parse(expiresAt) : NaN;
        const daysLeft = Number.isNaN(timestamp)
          ? null
          : Math.floor((timestamp - Date.now()) / 86_400_000);
        const result: ExpiryCheckResult = {
          certDomain: cert.domain,
          cdnDomain,
          certId,
          expiresAt: expiresAt || "unknown",
          daysLeft,
        };

        if (!certId) {
          console.error(`Qiniu domain ${cdnDomain} has no certificate bound`);
          result.error = true;
        } else if (failure || daysLeft === null) {
          console.error(
            `Cannot read the expiry of the Qiniu certificate for ${cdnDomain}${failure ? `: ${failure}` : ""}`
          );
          result.error = true;
        } else if (daysLeft <= warnDays) {
          console.error(
            `Qiniu certificate for ${cdnDomain} expires ${expiresAt} (${daysLeft} days left)`
          );
          result.error = true;
        } else {
          console.log(`${cdnDomain}: ${daysLeft} days until certificate expiry`);
        }
        results.push(result);
      }
    }

    return results;
  }

  /**
   * End-to-end verification, independent of the cache file.
   *
   * Uses the same binding plan as `sync`, so the certificate it expects is the
   * one `sync` would bind. For every managed Qiniu CDN domain it checks that a
   * certificate is bound, that the bound certificate is the planned one, that
   * it reaches `minDaysLeft`, and optionally that HTTPS works. Qiniu domains
   * the plan cannot cover (no Tencent certificate, or excluded) are reported
   * as `unmatched`.
   */
  async verify(
    minDaysLeft = 7,
    opts: { checkReachability?: boolean } = {}
  ): Promise<VerifyResult[]> {
    const { details, failures } = await this.loadCertificates();
    if (failures > 0) {
      console.error(
        `Verification is incomplete: ${failures} certificate(s) could not be read from Tencent Cloud`
      );
    }

    const qiniuDomains = await this.qiniu.listDomains();
    const plan = this.buildPlan(details, qiniuDomains);
    const planned = new Map<string, CertCandidate>();
    for (const { cert, cdnDomains } of plan) {
      for (const cdnDomain of cdnDomains) {
        planned.set(normalizeHost(cdnDomain), cert);
      }
    }
    const excluded = excludedDomains(this.config.domainMappings);

    const candidates: CertCandidate[] = details.map((detail) => ({
      certificateId: detail.certificateId,
      domain: detail.domain,
      fingerprint: detail.fingerprint,
      isWildcard: detail.isWildcard,
      sans: detail.subjectAltNames,
      certEndTime: detail.certEndTime,
      publicKey: detail.publicKey,
    }));

    const results: VerifyResult[] = [];

    for (const qd of qiniuDomains) {
      if (qd.type === "test") continue;
      const key = normalizeHost(qd.name);
      const cert = planned.get(key);

      if (!cert) {
        if (excluded.has(key)) {
          results.push({
            cdnDomain: qd.name,
            status: "ok",
            certId: qd.certId,
            message: "Excluded from management by configuration",
          });
        } else if (selectCertForDomain(qd.name, candidates)) {
          results.push({
            cdnDomain: qd.name,
            status: "unmatched",
            certId: qd.certId,
            message: `${qd.name} is not in the sync plan; check the domains config`,
          });
        } else {
          results.push({
            cdnDomain: qd.name,
            status: "unmatched",
            certId: qd.certId,
            message: `No Tencent Cloud certificate covers ${qd.name}; add one in Tencent Cloud`,
          });
        }
        continue;
      }

      results.push(await this.verifyOne(qd, cert, minDaysLeft));
    }

    if (failures > 0) {
      results.push({
        cdnDomain: "(tencent)",
        status: "stale-cert",
        message: `${failures} Tencent Cloud certificate(s) could not be read`,
      });
    }

    if (opts.checkReachability) {
      for (const result of results) {
        if (result.status !== "ok") continue;
        if (!(await this.isHttpsReachable(result.cdnDomain))) {
          result.status = "unreachable";
          result.message = `${result.message}; ${result.cdnDomain} did not complete a verified HTTPS handshake`;
        }
      }
    }

    return results;
  }

  private async verifyOne(
    qd: QiniuDomain,
    cert: CertCandidate,
    minDaysLeft: number
  ): Promise<VerifyResult> {
    if (!qd.certId) {
      return {
        cdnDomain: qd.name,
        certDomain: cert.domain,
        status: "unbound",
        message: `${qd.name} has no certificate bound in Qiniu`,
      };
    }

    let expiresAt: string | undefined;
    let pem: string | undefined;
    let failure: string | undefined;
    try {
      expiresAt = await this.qiniu.getCertNotAfter(qd.certId);
      pem = await this.qiniu.getCertPem(qd.certId);
    } catch (err: any) {
      failure = err.message;
    }

    if (failure) {
      return {
        cdnDomain: qd.name,
        certDomain: cert.domain,
        status: "stale-cert",
        certId: qd.certId,
        message: `Cannot read the certificate bound to ${qd.name}: ${failure}`,
      };
    }

    const timestamp = expiresAt ? Date.parse(expiresAt) : NaN;
    const daysLeft = Number.isNaN(timestamp)
      ? null
      : Math.floor((timestamp - Date.now()) / 86_400_000);

    if (!sameLeafCertificate(pem, cert.publicKey)) {
      return {
        cdnDomain: qd.name,
        certDomain: cert.domain,
        status: "stale-cert",
        certId: qd.certId,
        expiresAt,
        daysLeft,
        message: `${qd.name} is not bound to the current Tencent Cloud certificate for ${cert.domain}`,
      };
    }

    if (daysLeft === null) {
      return {
        cdnDomain: qd.name,
        certDomain: cert.domain,
        status: "stale-cert",
        certId: qd.certId,
        message: `Cannot read the expiry of the certificate bound to ${qd.name}`,
      };
    }

    if (daysLeft <= minDaysLeft) {
      return {
        cdnDomain: qd.name,
        certDomain: cert.domain,
        status: "expiring",
        certId: qd.certId,
        expiresAt,
        daysLeft,
        message: `Certificate on ${qd.name} expires in ${daysLeft} days`,
      };
    }

    return {
      cdnDomain: qd.name,
      certDomain: cert.domain,
      status: "ok",
      certId: qd.certId,
      expiresAt,
      daysLeft,
      message: `Bound to ${cert.domain}, ${daysLeft} days left`,
    };
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
    qiniuDomains: QiniuDomain[],
    force: boolean,
    dryRun: boolean
  ): Promise<SyncResult> {
    const certDomain = certInfo.domain;
    const live = qiniuDomains.find(
      (d) => normalizeHost(d.name) === normalizeHost(cdnDomain)
    );
    const liveCertId = live?.certId || "";

    // Skip only when Qiniu itself already reports a certificate that this
    // cache knows carries the current fingerprint. A removed or replaced
    // binding on Qiniu fails this check and is repaired.
    const known = this.cache.knownCertIds(
      certDomain,
      certInfo.fingerprint
    );
    if (!force && liveCertId && known.has(liveCertId)) {
      console.log(
        `Certificate ${certDomain} unchanged and already bound, skipping ${cdnDomain}`
      );
      return {
        certDomain,
        cdnDomain,
        action: "skipped",
        certId: liveCertId,
        message: "Certificate unchanged and already bound",
      };
    }

    if (dryRun) {
      console.log(
        `[DRY RUN] Would upload cert ${certDomain} and bind to ${cdnDomain}`
      );
      return {
        certDomain,
        cdnDomain,
        action: "skipped",
        certId: "",
        message: "Dry run: would upload and bind",
      };
    }

    try {
      let qiniuCertId = await this.resolveQiniuCertId(certInfo, force);

      try {
        await this.qiniu.putHTTPSConf(cdnDomain, qiniuCertId, this.forceHttps);
      } catch (err: any) {
        // The reused Qiniu certificate may have been deleted: upload once and
        // retry rather than failing every scheduled run.
        if (err?.statusCode !== 404) throw err;
        console.warn(
          `Qiniu cert ${qiniuCertId} is not usable for ${cdnDomain} (${err.message}); uploading again`
        );
        this.cache.forget(certDomain);
        qiniuCertId = await this.uploadCert(certInfo);
        await this.qiniu.putHTTPSConf(cdnDomain, qiniuCertId, this.forceHttps);
      }

      this.cache.recordBinding(certDomain, cdnDomain, qiniuCertId);

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
        action: "error",
        certId: "",
        message: err.message,
      };
    }
  }

  /**
   * Qiniu certificate ID to bind: a previously uploaded certificate when it
   * still exists and still carries this certificate's leaf, otherwise a fresh
   * upload.
   */
  private async resolveQiniuCertId(
    certInfo: CertDetail,
    force: boolean
  ): Promise<string> {
    if (!force) {
      const cached = this.cache.getCertId(certInfo.domain);
      if (cached && !this.cache.isChanged(certInfo.domain, certInfo.fingerprint)) {
        let pem: string | undefined;
        try {
          pem = await this.qiniu.getCertPem(cached);
        } catch (err: any) {
          console.warn(
            `Cached Qiniu cert ${cached} is no longer available (${err.message}); uploading again`
          );
        }
        if (pem && sameLeafCertificate(pem, certInfo.publicKey)) {
          console.log(
            `Reusing Qiniu cert ${cached} for ${certInfo.domain}...`
          );
          return cached;
        }
      }
    }
    return this.uploadCert(certInfo);
  }

  private async uploadCert(certInfo: CertDetail): Promise<string> {
    if (!certInfo.privateKey) {
      throw new Error(
        "Private key not available (free certs may not expose key via API)"
      );
    }
    console.log(`Uploading cert ${certInfo.domain}...`);
    const certId = await this.qiniu.createSSLCert(
      `synced-${certInfo.domain}`,
      certInfo.domain,
      certInfo.privateKey,
      certInfo.publicKey
    );
    this.cache.recordCert(certInfo.domain, certInfo.fingerprint, certId);
    return certId;
  }
}
