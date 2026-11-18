import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.js";
import type { QiniuCDNClient, QiniuDomain } from "../src/qiniu.js";
import type { CertDetail, TencentSSLClient } from "../src/tencent.js";
import { CertCache, Syncer } from "../src/syncer.js";

interface FakeQiniuState {
  domains: QiniuDomain[];
  created: Array<{ name: string; certId: string }>;
  bound: Array<{ domain: string; certId: string; forceHttps: boolean }>;
  notAfterById: Record<string, string>;
  pemById: Record<string, string>;
}

function fakeConfig(cacheFile: string): AppConfig {
  return {
    tencent: { secretId: "id", secretKey: "key", region: "ap-guangzhou" },
    qiniu: { accessKey: "ak", secretKey: "sk" },
    domainMappings: [],
    sync: { forceHttps: true, cacheFile },
  };
}

function pem(domain: string, fingerprint: string): string {
  const body = Buffer.from(`${domain}:${fingerprint}`).toString("base64");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

function detail(
  domain: string,
  fingerprint: string,
  opts: { endTime?: string; sans?: string[]; wildcard?: boolean } = {}
): CertDetail {
  return {
    certificateId: `tc-${domain}-${fingerprint}`,
    domain,
    alias: "",
    status: 1,
    certBeginTime: "2026-06-01 00:00:00",
    certEndTime: opts.endTime ?? "2027-06-01 00:00:00",
    publicKey: pem(domain, fingerprint),
    privateKey: `PRIV-${fingerprint}`,
    fingerprint,
    subjectAltNames: opts.sans ?? [],
    isWildcard: opts.wildcard ?? false,
  };
}

function makeFakes(certs: CertDetail[], domains: QiniuDomain[]) {
  const state: FakeQiniuState = {
    domains,
    created: [],
    bound: [],
    notAfterById: {},
    pemById: {},
  };
  let certSeq = 0;

  const tencent = {
    listCertificates: async () =>
      certs.map((c) => ({
        certificateId: c.certificateId,
        domain: c.domain,
        alias: "",
        status: 1,
        certBeginTime: c.certBeginTime,
        certEndTime: c.certEndTime,
      })),
    getCertificateDetail: async (id: string) => {
      const found = certs.find((c) => c.certificateId === id);
      if (!found) throw new Error(`unknown cert ${id}`);
      return found;
    },
  } as unknown as TencentSSLClient;

  const qiniu = {
    listDomains: async () => state.domains.map((d) => ({ ...d })),
    createSSLCert: async (name: string) => {
      const certId = `qn-cert-${++certSeq}`;
      state.created.push({ name, certId });
      return certId;
    },
    putHTTPSConf: async (domain: string, certId: string, forceHttps: boolean) => {
      state.bound.push({ domain, certId, forceHttps });
      state.domains = state.domains.map((d) =>
        d.name === domain ? { ...d, certId } : d
      );
    },
    getCertNotAfter: async (certId: string) => state.notAfterById[certId],
    getCertPem: async (certId: string) => state.pemById[certId],
  } as unknown as QiniuCDNClient;

  return { tencent, qiniu, state };
}

function withTempCache() {
  const dir = mkdtempSync(join(tmpdir(), "qiniucert-test-"));
  const cacheFile = join(dir, ".cert_cache.json");
  return {
    cacheFile,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("new Qiniu domain gets bound without re-uploading an unchanged cert", async () => {
  const tmp = withTempCache();
  try {
    // A cert with a SAN. First run: only the CN domain exists on Qiniu.
    const certs = [detail("swimmingliu.cn", "FP1", { sans: ["www.swimmingliu.cn"] })];
    const { tencent, qiniu, state } = makeFakes(certs, [
      { name: "swimmingliu.cn", type: "normal" },
    ]);
    const config = fakeConfig(tmp.cacheFile);
    await new Syncer(config, {
      tencent,
      qiniu,
      cache: new CertCache(tmp.cacheFile),
    }).sync();
    assert.equal(state.created.length, 1);

    // The user adds www.swimmingliu.cn on Qiniu; the cert is unchanged.
    state.domains.push({ name: "www.swimmingliu.cn", type: "normal" });
    const rerun = new Syncer(config, {
      tencent,
      qiniu,
      cache: new CertCache(tmp.cacheFile),
    });
    const report = await rerun.sync();

    assert.equal(state.created.length, 1, "cert must be reused, not re-uploaded");
    assert.deepEqual(
      state.bound.map((b) => b.domain).sort(),
      ["swimmingliu.cn", "www.swimmingliu.cn"]
    );
    assert.equal(report.uploaded, 1);
    assert.equal(report.skipped, 1);
    assert.equal(report.errors, 0);
  } finally {
    tmp.cleanup();
  }
});

test("unchanged, already-bound domains are skipped on rerun", async () => {
  const tmp = withTempCache();
  try {
    const certs = [detail("oss.swimmingliu.cn", "FP1")];
    const { tencent, qiniu, state } = makeFakes(certs, [
      { name: "oss.swimmingliu.cn", type: "normal" },
    ]);
    const config = fakeConfig(tmp.cacheFile);
    await new Syncer(config, {
      tencent,
      qiniu,
      cache: new CertCache(tmp.cacheFile),
    }).sync();
    const report = await new Syncer(config, {
      tencent,
      qiniu,
      cache: new CertCache(tmp.cacheFile),
    }).sync();

    assert.equal(state.created.length, 1);
    assert.equal(state.bound.length, 1);
    assert.equal(report.uploaded, 0);
    assert.equal(report.skipped, 1);
  } finally {
    tmp.cleanup();
  }
});

test("renewed certificate re-uploads and rebinds every domain", async () => {
  const tmp = withTempCache();
  try {
    const { tencent, qiniu, state } = makeFakes(
      [detail("oss.swimmingliu.cn", "FP1")],
      [{ name: "oss.swimmingliu.cn", type: "normal" }]
    );
    const config = fakeConfig(tmp.cacheFile);
    await new Syncer(config, {
      tencent,
      qiniu,
      cache: new CertCache(tmp.cacheFile),
    }).sync();

    const renewed = makeFakes([detail("oss.swimmingliu.cn", "FP2")], [
      ...state.domains,
    ]);
    const report = await new Syncer(config, {
      tencent: renewed.tencent,
      qiniu: renewed.qiniu,
      cache: new CertCache(tmp.cacheFile),
    }).sync();

    assert.equal(renewed.state.created.length, 1);
    assert.equal(report.uploaded, 1);
    assert.equal(renewed.state.bound[0].certId, "qn-cert-1");
  } finally {
    tmp.cleanup();
  }
});

test("cache written before bindings existed re-binds once and records them", async () => {
  const tmp = withTempCache();
  try {
    writeFileSync(
      tmp.cacheFile,
      JSON.stringify({
        "oss.swimmingliu.cn": { fingerprint: "FP1", certId: "qn-old" },
      })
    );
    const { tencent, qiniu, state } = makeFakes(
      [detail("oss.swimmingliu.cn", "FP1")],
      [{ name: "oss.swimmingliu.cn", type: "normal" }]
    );
    await new Syncer(fakeConfig(tmp.cacheFile), {
      tencent,
      qiniu,
      cache: new CertCache(tmp.cacheFile),
    }).sync();

    assert.equal(state.created.length, 0, "existing Qiniu cert is reused");
    assert.deepEqual(state.bound, [
      { domain: "oss.swimmingliu.cn", certId: "qn-old", forceHttps: true },
    ]);
    const entry = new CertCache(tmp.cacheFile).getAllEntries()[
      "oss.swimmingliu.cn"
    ];
    assert.equal(entry.bindings?.["oss.swimmingliu.cn"], "qn-old");
  } finally {
    tmp.cleanup();
  }
});

test("verify reports ok, unbound, expiring and unmatched domains", async () => {
  const tmp = withTempCache();
  try {
    const certs = [
      detail("oss.swimmingliu.cn", "FP1"),
      detail("old.swimmingliu.cn", "FP2"),
      detail("new.swimmingliu.cn", "FP3"),
    ];
    const { tencent, qiniu, state } = makeFakes(certs, [
      { name: "oss.swimmingliu.cn", type: "normal", certId: "qn-ok" },
      { name: "new.swimmingliu.cn", type: "normal" },
      { name: "old.swimmingliu.cn", type: "normal", certId: "qn-expiring" },
      { name: "no-cert.example.com", type: "normal" },
    ]);
    state.notAfterById["qn-ok"] = new Date(
      Date.now() + 90 * 86_400_000
    ).toISOString();
    state.pemById["qn-ok"] = certs[0].publicKey;
    state.notAfterById["qn-expiring"] = new Date(
      Date.now() + 2 * 86_400_000
    ).toISOString();
    state.pemById["qn-expiring"] = certs[1].publicKey;

    const results = await new Syncer(fakeConfig(tmp.cacheFile), {
      tencent,
      qiniu,
      cache: new CertCache(tmp.cacheFile),
    }).verify(7);

    const byDomain = Object.fromEntries(results.map((r) => [r.cdnDomain, r.status]));
    assert.deepEqual(byDomain, {
      "oss.swimmingliu.cn": "ok",
      "new.swimmingliu.cn": "unbound",
      "old.swimmingliu.cn": "expiring",
      "no-cert.example.com": "unmatched",
    });
  } finally {
    tmp.cleanup();
  }
});

test("verify flags a domain bound to a superseded certificate", async () => {
  const tmp = withTempCache();
  try {
    const certs = [detail("oss.swimmingliu.cn", "FP-NEW")];
    const { tencent, qiniu, state } = makeFakes(certs, [
      { name: "oss.swimmingliu.cn", type: "normal", certId: "qn-old" },
    ]);
    state.notAfterById["qn-old"] = new Date(
      Date.now() + 60 * 86_400_000
    ).toISOString();
    state.pemById["qn-old"] = pem("oss.swimmingliu.cn", "FP-OLD");

    const results = await new Syncer(fakeConfig(tmp.cacheFile), {
      tencent,
      qiniu,
      cache: new CertCache(tmp.cacheFile),
    }).verify(7);

    assert.equal(results.length, 1);
    assert.equal(results[0].status, "stale-cert");
  } finally {
    tmp.cleanup();
  }
});

test("verify ignores test domains", async () => {
  const tmp = withTempCache();
  try {
    const { tencent, qiniu } = makeFakes([], [
      { name: "bucket.hd-bkt.clouddn.com", type: "test" },
    ]);
    const results = await new Syncer(fakeConfig(tmp.cacheFile), {
      tencent,
      qiniu,
      cache: new CertCache(tmp.cacheFile),
    }).verify(7);
    assert.deepEqual(results, []);
  } finally {
    tmp.cleanup();
  }
});
