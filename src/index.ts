/**
 * QiNiuCert - Public API exports.
 * Auto-sync Tencent Cloud SSL certs to Qiniu CDN.
 */

export { loadConfig, ConfigError } from "./config.js";
export type {
  AppConfig,
  TencentConfig,
  QiniuConfig,
  DomainMapping,
  SyncOptions,
} from "./config.js";

export { TencentSSLClient, type CertSummary, type CertDetail } from "./tencent.js";
export { QiniuCDNClient, QiniuAPIError, type QiniuDomain } from "./qiniu.js";
export {
  matchCertToDomains,
  buildAllMatches,
} from "./matcher.js";
export { Syncer, CertCache, type SyncResult, type SyncReport } from "./syncer.js";
