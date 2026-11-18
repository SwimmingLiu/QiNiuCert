import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig, DomainMapping } from "../src/config.js";
import { QiniuAPIError, type QiniuCDNClient, type QiniuDomain } from "../src/qiniu.js";
import type { CertDetail, TencentSSLClient } from "../src/tencent.js";
import { CertCache, Syncer } from "../src/syncer.js";

interface FakeState {
  domains: QiniuDomain[];
  created: Array<{ name: string; commonName: string; certId: string; pem: string }>;
  bound: Array<{ domain: string; certId: string; forceHttps: boolean }>;
  notAfterById: Record<string, string>;
  pemById: Record<string, string>;
  deletedCertIds: Set<string>;
  failDetailFor: Set<string>;
}

function fakeConfig(
  cacheFile: string,
  over: Partial<AppConfig> = {}
): AppConfig {
  return {
    tencent: { secretId: "id", secretKey: "key", region: "ap-guangzhou" },
    qiniu: { accessKey: "ak", secretKey: "sk" },
    domainMappings: [],
    sync: { forceHttps: true, cacheFile },
    ...over,
  };
}

function pem(domain: string, fingerprint: string): string {
  const body = Buffer.from(`${domain}:${fingerprint}`).toString("base64");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

function detail(
  domain: string,
  fingerprint: string,
  opts: {
    endTime?: string;
    sans?: string[];
    wildcard?: boolean;
    id?: string;
    privateKey?: string;
  } = {}
): CertDetail {
  return {
    certificateId: opts.id ?? `tc-${domain}-${fingerprint}`,
    domain,
    alias: "",
    status: 1,
    certBeginTime: "2026-06-01 00:00:00",
    certEndTime: opts.endTime ?? "2027-06-01 00:00:00",
    publicKey: pem(domain, fingerprint),
    privateKey: opts.privateKey ?? `PRIV-${fingerprint}`,
    fingerprint,
    subjectAltNames: opts.sans ?? [],
    isWildcard: opts.wildcard ?? domain.startsWith("*."),
  };
}

function makeFakes(certs: CertDetail[], domains: QiniuDomain[]) {
  const state: FakeState = {
    domains,
    created: [],
    bound: [],
    notAfterById: {},
    pemById: {},
    deletedCertIds: new Set(),
    failDetailFor: new Set(),
  };
  let certSeq = 0;

  const tencent = {
    listCertificates: async () =>
      certs.map((c) => ({
        certificateId: c.certificateId,
        domain: c.domain,
        alias: c.alias,
        status: c.status,
        certBeginTime: c.certBeginTime,
        certEndTime: c.certEndTime,
      })),
    getCertificateDetail: async (id: string) => {
      if (state.failDetailFor.has(id)) {
        throw new Error(`InternalError for ${id}`);
      }
      const found = certs.find((c) => c.certificateId === id);
      if (!found) throw new Error(`unknown cert ${id}`);
      return found;
    },
  } as unknown as TencentSSLClient;

  const qiniu = {
    listDomains: async () => state.domains.map((d) => ({ ...d })),
    createSSLCert: async (
      name: string,
      commonName: string,
      _privateKey: string,
      certificate: string
    ) => {
      const certId = `qn-cert-${++certSeq}`;
      state.created.push({ name, commonName, certId, pem: certificate });
      state.pemById[certId] = certificate;
      state.notAfterById[certId] = new Date(
        Date.now() + 90 * 86_400_000
      ).toISOString();
      return certId;
    },
    getCertPem: async (certId: string) => {
      if (state.deletedCertIds.has(certId)) {
        throw new QiniuAPIError(`Qiniu API error (HTTP 404): not found`, 404);
      }
      return state.pemById[certId];
    },
    getCertNotAfter: async (certId: string) => {
      if (state.deletedCertIds.has(certId)) {
        throw new QiniuAPIError(`Qiniu API error (HTTP 404): not found`, 404);
      }
      return state.notAfterById[certId];
    },
    putHTTPSConf: async (domain: string, certId: string, forceHttps: boolean) => {
      if (state.deletedCertIds.has(certId)) {
        throw new QiniuAPIError(`Qiniu API error (HTTP 404): not found`, 404);
      }
      state.bound.push({ domain, certId, forceHttps });
      state.domains = state.domains.map((d) =>
        d.name === domain ? { ...d, certId } : d
      );
    },
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

function syncer(
  cacheFile: string,
  fakes: ReturnType<typeof makeFakes>,
  over: Partial<AppConfig> = {}
) {
  const config = fakeConfig(cacheFile, over);
  return new Syncer(config, {
    tencent: fakes.tencent,
    qiniu: fakes.qiniu,
    cache: new CertCache(cacheFile),
  });
}

test("new Qiniu domain gets bound without re-uploading an unchanged cert", async () => {
  const tmp = withTempCache();
  try {
    const certs = [detail("swimmingliu.cn", "FP1", { sans: ["www.swimmingliu.cn"] })];
    const fakes = makeFakes(certs, [{ name: "swimmingliu.cn", type: "normal" }]);
    await syncer(tmp.cacheFile, fakes).sync();
    assert.equal(fakes.state.created.length, 1);

    // The user adds www.swimmingliu.cn on Qiniu; the cert is unchanged.
    fakes.state.domains.push({ name: "www.swimmingliu.cn", type: "normal" });
    const report = await syncer(tmp.cacheFile, fakes).sync();

    assert.equal(fakes.state.created.length, 1, "cert must be reused");
    assert.deepEqual(
      fakes.state.bound.map((b) => b.domain).sort(),
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
    const fakes = makeFakes([detail("oss.swimmingliu.cn", "FP1")], [
      { name: "oss.swimmingliu.cn", type: "normal" },
    ]);
    await syncer(tmp.cacheFile, fakes).sync();
    const report = await syncer(tmp.cacheFile, fakes).sync();

    assert.equal(fakes.state.created.length, 1);
    assert.equal(fakes.state.bound.length, 1);
    assert.equal(report.uploaded, 0);
    assert.equal(report.skipped, 1);
  } finally {
    tmp.cleanup();
  }
});

test("a binding removed in Qiniu is repaired on the next run", async () => {
  const tmp = withTempCache();
  try {
    const fakes = makeFakes([detail("oss.swimmingliu.cn", "FP1")], [
      { name: "oss.swimmingliu.cn", type: "normal" },
    ]);
    await syncer(tmp.cacheFile, fakes).sync();

    // User removes the HTTPS config in the Qiniu console.
    fakes.state.domains = fakes.state.domains.map((d) => ({ ...d, certId: "" }));
    const report = await syncer(tmp.cacheFile, fakes).sync();

    assert.equal(report.uploaded, 1);
    assert.equal(fakes.state.domains[0].certId, "qn-cert-1");
  } finally {
    tmp.cleanup();
  }
});

test("a binding replaced by a foreign certificate is repaired", async () => {
  const tmp = withTempCache();
  try {
    const fakes = makeFakes([detail("oss.swimmingliu.cn", "FP1")], [
      { name: "oss.swimmingliu.cn", type: "normal" },
    ]);
    await syncer(tmp.cacheFile, fakes).sync();

    fakes.state.domains = fakes.state.domains.map((d) => ({
      ...d,
      certId: "someone-elses-cert",
    }));
    await syncer(tmp.cacheFile, fakes).sync();
    assert.equal(fakes.state.domains[0].certId, "qn-cert-1");
  } finally {
    tmp.cleanup();
  }
});

test("a cached Qiniu cert deleted upstream is replaced instead of failing forever", async () => {
  const tmp = withTempCache();
  try {
    const fakes = makeFakes([detail("oss.swimmingliu.cn", "FP1")], [
      { name: "oss.swimmingliu.cn", type: "normal" },
    ]);
    await syncer(tmp.cacheFile, fakes).sync();

    // Cert deleted in Qiniu, and a new domain needs binding.
    fakes.state.deletedCertIds.add("qn-cert-1");
    fakes.state.pemById = {};
    fakes.state.domains = fakes.state.domains.map((d) => ({ ...d, certId: "" }));
    fakes.state.domains.push({ name: "new.swimmingliu.cn", type: "normal" });

    const report = await syncer(tmp.cacheFile, fakes, {
      domainMappings: [
        {
          certDomain: "oss.swimmingliu.cn",
          cdnDomains: ["new.swimmingliu.cn"],
          excludeCdnDomains: [],
          autoMatch: true,
        },
      ],
    }).sync();

    assert.equal(report.errors, 0);
    assert.ok(fakes.state.created.length >= 1);
    assert.equal(
      fakes.state.domains.find((d) => d.name === "new.swimmingliu.cn")?.certId,
      "qn-cert-2"
    );
  } finally {
    tmp.cleanup();
  }
});

test("renewed certificate re-uploads and rebinds every domain", async () => {
  const tmp = withTempCache();
  try {
    const first = makeFakes([detail("oss.swimmingliu.cn", "FP1")], [
      { name: "oss.swimmingliu.cn", type: "normal" },
    ]);
    await syncer(tmp.cacheFile, first).sync();

    const renewed = makeFakes([detail("oss.swimmingliu.cn", "FP2")], [
      ...first.state.domains,
    ]);
    const report = await syncer(tmp.cacheFile, renewed).sync();

    assert.equal(renewed.state.created.length, 1);
    assert.equal(report.uploaded, 1);
    assert.equal(renewed.state.bound[0].certId, "qn-cert-1");
    assert.equal(
      new CertCache(tmp.cacheFile).getAllEntries()["oss.swimmingliu.cn"].fingerprint,
      "FP2"
    );
  } finally {
    tmp.cleanup();
  }
});

test("a cached cert whose PEM differs from the current one is not reused", async () => {
  const tmp = withTempCache();
  try {
    // Cache says FP1/qn-old, but Qiniu's qn-old actually carries other bytes.
    writeFileSync(
      tmp.cacheFile,
      JSON.stringify({
        "oss.swimmingliu.cn": { fingerprint: "FP1", certId: "qn-old", certIds: ["qn-old"] },
      })
    );
    const fakes = makeFakes([detail("oss.swimmingliu.cn", "FP1")], [
      { name: "oss.swimmingliu.cn", type: "normal" },
    ]);
    fakes.state.pemById["qn-old"] = pem("oss.swimmingliu.cn", "OTHER");
    fakes.state.notAfterById["qn-old"] = new Date(
      Date.now() + 90 * 86_400_000
    ).toISOString();

    await syncer(tmp.cacheFile, fakes).sync();
    assert.equal(fakes.state.created.length, 1);
    assert.equal(fakes.state.domains[0].certId, "qn-cert-1");
  } finally {
    tmp.cleanup();
  }
});

test("a certificate detail failure is counted instead of reporting success", async () => {
  const tmp = withTempCache();
  try {
    const broken = detail("rollie-rank-oss.swimmingliu.cn", "FP1", { id: "broken" });
    const fakes = makeFakes([broken], [
      { name: "rollie-rank-oss.swimmingliu.cn", type: "normal" },
    ]);
    fakes.state.failDetailFor.add("broken");

    const report = await syncer(tmp.cacheFile, fakes).sync();
    assert.equal(report.failedCertificates, 1);
    assert.equal(report.totalDomains, 0);
    assert.equal(report.errors, 1, "a read failure must fail the run");
  } finally {
    tmp.cleanup();
  }
});

test("two certs sharing a CN: the one carrying the new SAN is bound", async () => {
  const tmp = withTempCache();
  try {
    const older = detail("swimmingliu.cn", "FP-OLD", {
      id: "older",
      endTime: "2027-09-30 00:00:00",
    });
    const newer = detail("swimmingliu.cn", "FP-NEW", {
      id: "newer",
      endTime: "2027-01-31 00:00:00",
      sans: ["rollie-rank-oss.swimmingliu.cn"],
    });
    const fakes = makeFakes([older, newer], [
      { name: "rollie-rank-oss.swimmingliu.cn", type: "normal" },
    ]);

    const report = await syncer(tmp.cacheFile, fakes).sync();
    assert.equal(report.errors, 0);
    assert.equal(report.uploaded, 1);
    assert.equal(
      fakes.state.domains[0].certId,
      "qn-cert-1",
      "the SAN-bearing certificate must be bound"
    );
    assert.deepEqual(fakes.state.created.map((c) => c.commonName), ["swimmingliu.cn"]);
  } finally {
    tmp.cleanup();
  }
});

test("a SAN certificate cannot take a domain from its exact certificate", async () => {
  const tmp = withTempCache();
  try {
    const sanCert = detail("aaa.example.com", "FP-SAN", {
      sans: ["rollie-rank-oss.swimmingliu.cn"],
    });
    const exact = detail("rollie-rank-oss.swimmingliu.cn", "FP-EXACT");
    const fakes = makeFakes([sanCert, exact], [
      { name: "rollie-rank-oss.swimmingliu.cn", type: "normal" },
    ]);

    await syncer(tmp.cacheFile, fakes).sync();
    assert.equal(fakes.state.created.length, 1);
    assert.equal(fakes.state.created[0].commonName, "rollie-rank-oss.swimmingliu.cn");
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
    const fakes = makeFakes(certs, [
      { name: "oss.swimmingliu.cn", type: "normal", certId: "qn-ok" },
      { name: "new.swimmingliu.cn", type: "normal" },
      { name: "old.swimmingliu.cn", type: "normal", certId: "qn-expiring" },
      { name: "no-cert.example.com", type: "normal" },
    ]);
    fakes.state.notAfterById["qn-ok"] = new Date(Date.now() + 90 * 86_400_000).toISOString();
    fakes.state.pemById["qn-ok"] = certs[0].publicKey;
    fakes.state.notAfterById["qn-expiring"] = new Date(Date.now() + 2 * 86_400_000).toISOString();
    fakes.state.pemById["qn-expiring"] = certs[1].publicKey;

    const results = await syncer(tmp.cacheFile, fakes).verify(7);
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
    const fakes = makeFakes(certs, [
      { name: "oss.swimmingliu.cn", type: "normal", certId: "qn-old" },
    ]);
    fakes.state.notAfterById["qn-old"] = new Date(Date.now() + 60 * 86_400_000).toISOString();
    fakes.state.pemById["qn-old"] = pem("oss.swimmingliu.cn", "FP-OLD");

    const results = await syncer(tmp.cacheFile, fakes).verify(7);
    assert.equal(results[0].status, "stale-cert");
  } finally {
    tmp.cleanup();
  }
});

test("verify reports a deleted bound certificate as a per-domain failure", async () => {
  const tmp = withTempCache();
  try {
    const certs = [detail("oss.swimmingliu.cn", "FP1"), detail("img.example.com", "FP2")];
    const fakes = makeFakes(certs, [
      { name: "oss.swimmingliu.cn", type: "normal", certId: "deleted" },
      { name: "img.example.com", type: "normal", certId: "qn-ok" },
    ]);
    fakes.state.deletedCertIds.add("deleted");
    fakes.state.notAfterById["qn-ok"] = new Date(Date.now() + 90 * 86_400_000).toISOString();
    fakes.state.pemById["qn-ok"] = certs[1].publicKey;

    const results = await syncer(tmp.cacheFile, fakes).verify(7);
    const byDomain = Object.fromEntries(results.map((r) => [r.cdnDomain, r.status]));
    assert.equal(byDomain["oss.swimmingliu.cn"], "stale-cert");
    assert.equal(byDomain["img.example.com"], "ok");
  } finally {
    tmp.cleanup();
  }
});

test("verify ignores test domains", async () => {
  const tmp = withTempCache();
  try {
    const fakes = makeFakes([], [{ name: "bucket.hd-bkt.clouddn.com", type: "test" }]);
    const results = await syncer(tmp.cacheFile, fakes).verify(7);
    assert.deepEqual(results, []);
  } finally {
    tmp.cleanup();
  }
});

test("check-expiry honours exclusions and does not fail on SAN-only certificates", async () => {
  const tmp = withTempCache();
  try {
    const certs = [
      detail("swimmingliu.cn", "FP1", { sans: ["rollie-rank-oss.swimmingliu.cn"] }),
    ];
    const fakes = makeFakes(certs, [
      { name: "rollie-rank-oss.swimmingliu.cn", type: "normal", certId: "qn-good" },
      { name: "skip.swimmingliu.cn", type: "normal" },
    ]);
    fakes.state.notAfterById["qn-good"] = new Date(Date.now() + 90 * 86_400_000).toISOString();

    const mappings: DomainMapping[] = [
      {
        certDomain: "swimmingliu.cn",
        cdnDomains: [],
        excludeCdnDomains: ["skip.swimmingliu.cn"],
        autoMatch: true,
      },
    ];
    const results = await syncer(tmp.cacheFile, fakes, {
      domainMappings: mappings,
    }).checkExpiry(7);

    assert.equal(results.length, 1);
    assert.equal(results[0].cdnDomain, "rollie-rank-oss.swimmingliu.cn");
    assert.notEqual(results[0].error, true);
  } finally {
    tmp.cleanup();
  }
});

test("check-expiry reports a per-domain error instead of throwing", async () => {
  const tmp = withTempCache();
  try {
    const certs = [detail("oss.swimmingliu.cn", "FP1"), detail("img.example.com", "FP2")];
    const fakes = makeFakes(certs, [
      { name: "oss.swimmingliu.cn", type: "normal", certId: "deleted" },
      { name: "img.example.com", type: "normal", certId: "qn-ok" },
    ]);
    fakes.state.deletedCertIds.add("deleted");
    fakes.state.notAfterById["qn-ok"] = new Date(Date.now() + 90 * 86_400_000).toISOString();

    const results = await syncer(tmp.cacheFile, fakes).checkExpiry(7);
    const byDomain = Object.fromEntries(results.map((r) => [r.cdnDomain, r.error]));
    assert.equal(byDomain["oss.swimmingliu.cn"], true);
    assert.notEqual(byDomain["img.example.com"], true);
  } finally {
    tmp.cleanup();
  }
});

test("rebind covers SAN domains recorded in the cache", async () => {
  const tmp = withTempCache();
  try {
    const certs = [detail("swimmingliu.cn", "FP1", { sans: ["www.swimmingliu.cn"] })];
    const fakes = makeFakes(certs, [
      { name: "swimmingliu.cn", type: "normal" },
      { name: "www.swimmingliu.cn", type: "normal" },
    ]);
    await syncer(tmp.cacheFile, fakes).sync();

    const report = await syncer(tmp.cacheFile, fakes, {
      sync: { forceHttps: false, cacheFile: tmp.cacheFile },
    }).rebindAll();

    assert.equal(report.totalDomains, 2);
    assert.ok(fakes.state.bound.slice(-2).every((b) => b.forceHttps === false));
  } finally {
    tmp.cleanup();
  }
});

test("verify marks a domain that fails its HTTPS handshake as unreachable", async () => {
  const tmp = withTempCache();
  try {
    // `.invalid` never resolves, so the reachability check must fail.
    const certs = [detail("sync-test.invalid", "FP1")];
    const fakes = makeFakes(certs, [
      { name: "sync-test.invalid", type: "normal", certId: "qn-ok" },
    ]);
    fakes.state.notAfterById["qn-ok"] = new Date(Date.now() + 90 * 86_400_000).toISOString();
    fakes.state.pemById["qn-ok"] = certs[0].publicKey;

    const results = await syncer(tmp.cacheFile, fakes).verify(7, {
      checkReachability: true,
    });
    assert.equal(results[0].status, "unreachable");
  } finally {
    tmp.cleanup();
  }
});
