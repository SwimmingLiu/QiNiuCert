/**
 * Core sync orchestrator.
 * Coordinates cert discovery, matching, upload, and domain binding.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "./config.js";
import { buildAllMatches } from "./matcher.js";
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

/**
 * Local cache to track uploaded cert fingerprints.
 * Stored as JSON: { [certDomain]: { fingerprint, certId } }
 */
export class CertCache {
  private data: Record<string, { fingerprint: string; certId: string }> = {};
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

  update(certDomain: string, fingerprint: string, certId: string): void {
    this.data[certDomain] = { fingerprint, certId };
    this.save();
  }

  getAllEntries(): Record<string, { fingerprint: string; certId: string }> {
    return { ...this.data };
  }
}

export class Syncer {
  private tencent: TencentSSLClient;
  private qiniu: QiniuCDNClient;
  private cache: CertCache;
  private forceHttps: boolean;
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.tencent = new TencentSSLClient(
      config.tencent.secretId,
      config.tencent.secretKey,
      config.tencent.region
    );
    this.qiniu = new QiniuCDNClient(
      config.qiniu.accessKey,
      config.qiniu.secretKey
    );
    this.cache = new CertCache(config.sync.cacheFile);
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

    // Step 3: List CDN domains from Qiniu
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

    for (const [certDomain, { certId }] of Object.entries(entries)) {
      // Find matching Qiniu domains
      for (const qd of qiniuDomains) {
        if (
          qd.name === certDomain ||
          (certDomain.startsWith("*.") &&
            qd.name.endsWith(certDomain.slice(1)))
        ) {
          try {
            await this.qiniu.putHTTPSConf(
              qd.name,
              certId,
              this.forceHttps
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

  private async syncOne(
    certInfo: CertDetail,
    cdnDomain: string,
    force: boolean,
    dryRun: boolean
  ): Promise<SyncResult> {
    const certDomain = certInfo.domain;

    // Check fingerprint cache
    if (
      !force &&
      !this.cache.isChanged(certDomain, certInfo.fingerprint)
    ) {
      const cachedCertId = this.cache.getCertId(certDomain) || "";
      console.log(
        `Certificate ${certDomain} unchanged, skipping ${cdnDomain}`
      );
      return {
        certDomain,
        cdnDomain,
        action: "skipped",
        certId: cachedCertId,
        message: "Certificate unchanged",
      };
    }

    // Check private key
    if (!certInfo.privateKey) {
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

    // Upload + bind
    try {
      const certName = `synced-${certDomain}`;
      console.log(`Uploading cert ${certDomain} → ${cdnDomain}...`);

      const qiniuCertId = await this.qiniu.createSSLCert(
        certName,
        certDomain,
        certInfo.privateKey,
        certInfo.publicKey
      );

      await this.qiniu.putHTTPSConf(
        cdnDomain,
        qiniuCertId,
        this.forceHttps
      );

      this.cache.update(certDomain, certInfo.fingerprint, qiniuCertId);

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
