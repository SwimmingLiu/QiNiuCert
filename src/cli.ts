#!/usr/bin/env node
/**
 * QiNiuCert CLI - Sync SSL certs from Tencent Cloud to Qiniu CDN.
 *
 * Usage:
 *   qiniucert sync              Incremental sync
 *   qiniucert sync --force      Force re-upload all
 *   qiniucert sync --dry-run    Preview
 *   qiniucert status            Show cache
 *   qiniucert rebind            Re-bind all cached certs to domains
 */

import { Command } from "commander";
import { loadConfig, ConfigError } from "./config.js";
import { Syncer } from "./syncer.js";

const program = new Command();

program
  .name("qiniucert")
  .description("Sync SSL certificates from Tencent Cloud to Qiniu CDN")
  .version("1.0.0");

program
  .command("sync")
  .description("Sync SSL certificates")
  .option(
    "-c, --config <path>",
    "Path to config.yaml",
    process.env.QINIUCERT_CONFIG || "config.yaml"
  )
  .option("--force", "Force re-upload all, ignoring fingerprint cache")
  .option("--dry-run", "Preview without making changes")
  .action(async (opts) => {
    try {
      const config = loadConfig(opts.config);
      const syncer = new Syncer(config);
      const report = await syncer.sync(opts.force, opts.dryRun);

      console.log(
        JSON.stringify(
          {
            totalCerts: report.totalCerts,
            totalDomains: report.totalDomains,
            uploaded: report.uploaded,
            skipped: report.skipped,
            errors: report.errors,
            details: report.results.map((r) => ({
              certDomain: r.certDomain,
              cdnDomain: r.cdnDomain,
              action: r.action,
              certId: r.certId,
              message: r.message,
            })),
          },
          null,
          2
        )
      );

      if (report.errors > 0) process.exit(1);
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(`Error: ${err.message}`);
      } else {
        console.error(`Error: ${err}`);
      }
      process.exit(1);
    }
  });

program
  .command("rebind")
  .description("Re-bind all cached certs to domains (e.g. after changing forceHttps)")
  .option(
    "-c, --config <path>",
    "Path to config.yaml",
    process.env.QINIUCERT_CONFIG || "config.yaml"
  )
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const syncer = new Syncer(config);
    const report = await syncer.rebindAll();

    console.log(
      JSON.stringify(
        {
          totalDomains: report.totalDomains,
          uploaded: report.uploaded,
          errors: report.errors,
        },
        null,
        2
      )
    );

    if (report.errors > 0) process.exit(1);
  });

program
  .command("status")
  .description("Show cache status")
  .option("--cache-file <path>", "Path to cache file", ".cert_cache.json")
  .action(async (opts) => {
    const { existsSync } = await import("node:fs");
    const { CertCache } = await import("./syncer.js");

    if (!existsSync(opts.cacheFile)) {
      console.log(`No cache file found at ${opts.cacheFile}`);
      return;
    }

    const cache = new CertCache(opts.cacheFile);
    const entries = cache.getAllEntries();
    if (Object.keys(entries).length === 0) {
      console.log("Cache is empty. Run 'sync' first.");
      return;
    }

    console.log(`Cache file: ${opts.cacheFile}`);
    console.log(`Total entries: ${Object.keys(entries).length}\n`);
    for (const [domain, info] of Object.entries(entries)) {
      console.log(`  ${domain}:`);
      console.log(`    Qiniu CertID: ${info.certId}`);
      console.log(`    Fingerprint:  ${info.fingerprint}`);
      console.log();
    }
  });

export function main(): void {
  program.parse();
}

// Run if called directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  main();
}
