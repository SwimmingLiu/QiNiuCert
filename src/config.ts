/**
 * Configuration loading and validation.
 * Reads config.yaml and provides typed config object.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

export interface TencentConfig {
  secretId: string;
  secretKey: string;
  region: string;
}

export interface QiniuConfig {
  accessKey: string;
  secretKey: string;
}

export interface DomainMapping {
  certDomain: string;
  cdnDomains: string[];
  excludeCdnDomains: string[];
  autoMatch: boolean;
}

export interface SyncOptions {
  forceHttps: boolean;
  cacheFile: string;
}

export interface AppConfig {
  tencent: TencentConfig;
  qiniu: QiniuConfig;
  domainMappings: DomainMapping[];
  sync: SyncOptions;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function validateRequired(value: unknown, name: string): string {
  if (!value || typeof value !== "string" || value.startsWith("xxx")) {
    throw new ConfigError(
      `${name} is required and must be a valid value (not placeholder)`
    );
  }
  return value;
}

export function loadConfig(configPath?: string): AppConfig {
  const path = configPath || process.env.QINIUCERT_CONFIG || "config.yaml";
  const resolved = resolve(path);

  let raw: Record<string, any>;
  try {
    const content = readFileSync(resolved, "utf-8");
    raw = (yaml.load(content) as Record<string, any>) || {};
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new ConfigError(
        `Config file not found: ${resolved}\nCopy config.example.yaml to config.yaml and fill in your credentials.`
      );
    }
    throw new ConfigError(`Failed to read config: ${err.message}`);
  }

  const tc = raw.tencent || {};
  const tencent: TencentConfig = {
    secretId: validateRequired(tc.secret_id, "tencent.secret_id"),
    secretKey: validateRequired(tc.secret_key, "tencent.secret_key"),
    region: tc.region || "ap-guangzhou",
  };

  const qn = raw.qiniu || {};
  const qiniu: QiniuConfig = {
    accessKey: validateRequired(qn.access_key, "qiniu.access_key"),
    secretKey: validateRequired(qn.secret_key, "qiniu.secret_key"),
  };

  const domainMappings: DomainMapping[] = (raw.domains || []).map(
    (item: any, i: number) => {
      const certDomain = validateRequired(
        item.cert_domain,
        `domains[${i}].cert_domain`
      );
      return {
        certDomain,
        cdnDomains: item.cdn_domains || [],
        excludeCdnDomains: item.exclude_cdn_domains || [],
        autoMatch: item.auto_match !== false,
      };
    }
  );

  const syncRaw = raw.sync || {};
  const sync: SyncOptions = {
    forceHttps: syncRaw.force_https !== false,
    cacheFile: syncRaw.cache_file || ".cert_cache.json",
  };

  return { tencent, qiniu, domainMappings, sync };
}
