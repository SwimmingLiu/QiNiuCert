#!/usr/bin/env node
/**
 * QiNiuCert CLI - Sync SSL certs from Tencent Cloud to Qiniu CDN.
 *
 * Usage:
 *   qiniucert sync              Incremental sync
 *   qiniucert sync --force      Force re-upload all
 *   qiniucert sync --dry-run    Preview
 *   qiniucert check-expiry     Check expiry of certificates bound in Qiniu
 *   qiniucert verify            Verify every Qiniu domain has a valid cert
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
  .command("check-expiry")
  .description("Fail when a cached Qiniu certificate is near expiry")
  .option(
    "-c, --config <path>",
    "Path to config.yaml",
    process.env.QINIUCERT_CONFIG || "config.yaml"
  )
  .option("--warn-days <days>", "Warn this many days before expiry", "7")
  .action(async (opts) => {
    try {
      const warnDays = Number(opts.warnDays);
      if (!Number.isInteger(warnDays) || warnDays < 0) {
        throw new ConfigError("--warn-days must be a non-negative integer");
      }
      const config = loadConfig(opts.config);
      const results = await new Syncer(config).checkExpiry(warnDays);
      console.log(JSON.stringify(results, null, 2));
      if (results.some((result) => result.error)) process.exitCode = 1;
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  });

program
  .command("verify")
  .description("Verify every Qiniu CDN domain is bound to a valid, unexpired cert")
  .option(
    "-c, --config <path>",
    "Path to config.yaml",
    process.env.QINIUCERT_CONFIG || "config.yaml"
  )
  .option("--min-days <days>", "Require at least this many days before expiry", "7")
  .option("--check-reachability", "Also fail when a domain does not serve HTTPS")
  .option(
    "--fail-on-unmatched",
    "Also fail when a Qiniu domain has no matching Tencent Cloud cert"
  )
  .action(async (opts) => {
    try {
      const minDays = Number(opts.minDays);
      if (!Number.isInteger(minDays) || minDays < 0) {
        throw new ConfigError("--min-days must be a non-negative integer");
      }
      const config = loadConfig(opts.config);
      const results = await new Syncer(config).verify(minDays, {
        checkReachability: Boolean(opts.checkReachability),
      });
      console.log(JSON.stringify(results, null, 2));

      // `unmatched` means sync had nothing to bind (no Tencent cert covers
      // the domain). Surface it loudly but only fail on request: the domain
      // may have been added before its certificate.
      const failing = results.filter((r) => {
        if (r.status === "ok") return false;
        if (r.status === "unmatched") return Boolean(opts.failOnUnmatched);
        return true;
      });
      for (const r of results) {
        if (r.status === "unmatched") console.warn(`! ${r.cdnDomain}: ${r.message}`);
      }
      for (const r of failing) {
        if (r.status !== "unmatched") console.error(`✗ ${r.cdnDomain}: ${r.message}`);
      }
      console.log(
        `\n${results.length - failing.length}/${results.length} Qiniu domains verified`
      );
      if (failing.length > 0) process.exitCode = 1;
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
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
      const bindings = Object.entries(info.bindings ?? {});
      if (bindings.length > 0) {
        console.log(`    Bound domains:`);
        for (const [cdnDomain, certId] of bindings) {
          console.log(`      ${cdnDomain} → ${certId}`);
        }
      }
      console.log();
    }
  });

export function main(): void {
  program.parse();
}

// Run if called directly (works across platforms and symlinks)
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

