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
  buildBindingPlan,
  certCoversDomain,
  domainMatchesPatterns,
  excludedDomains,
  matchCertToDomains,
  matchRank,
  normalizeHost,
  selectCertForDomain,
  type BindingPlan,
  type CertCandidate,
} from "./matcher.js";
export { leafCertificateBody, leafSha1, sameLeafCertificate } from "./pem.js";
export {
  Syncer,
  CertCache,
  type SyncResult,
  type SyncReport,
  type CertCacheEntry,
  type ExpiryCheckResult,
  type VerifyResult,
} from "./syncer.js";
