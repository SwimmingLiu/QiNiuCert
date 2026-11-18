import test from "node:test";
import assert from "node:assert/strict";
import type { DomainMapping } from "../src/config.js";
import {
  buildBindingPlan,
  certCoversDomain,
  domainMatchesPatterns,
  matchCertToDomains,
  matchRank,
  selectCertForDomain,
  type CertCandidate,
} from "../src/matcher.js";
import type { QiniuDomain } from "../src/qiniu.js";

const domain = (name: string, certId = ""): QiniuDomain => ({
  name,
  type: "normal",
  certId,
});

function cert(
  name: string,
  opts: {
    sans?: string[];
    end?: string;
    id?: string;
    fingerprint?: string;
  } = {}
): CertCandidate {
  return {
    certificateId: opts.id ?? name,
    domain: name,
    fingerprint: opts.fingerprint ?? "FP",
    isWildcard: name.startsWith("*."),
    sans: opts.sans ?? [],
    certEndTime: opts.end ?? "2027-06-01 00:00:00",
    publicKey: "PEM",
  };
}

const mapping = (over: Partial<DomainMapping>): DomainMapping => ({
  certDomain: "",
  cdnDomains: [],
  excludeCdnDomains: [],
  autoMatch: true,
  ...over,
});

test("matches an exact cert domain to a newly added Qiniu domain", () => {
  const matched = matchCertToDomains(
    "rollie-rank-oss.swimmingliu.cn",
    false,
    [],
    [domain("rollie-rank-oss.swimmingliu.cn"), domain("oss.swimmingliu.cn")]
  );
  assert.deepEqual(matched, ["rollie-rank-oss.swimmingliu.cn"]);
});

test("wildcard cert covers one label but not the apex or deeper names", () => {
  assert.equal(certCoversDomain("*.example.com", true, [], "cdn.example.com"), true);
  assert.equal(certCoversDomain("*.example.com", true, [], "example.com"), false);
  assert.equal(certCoversDomain("*.example.com", true, [], "a.b.example.com"), false);
});

test("SANs are honoured", () => {
  assert.equal(
    certCoversDomain("example.com", false, ["cdn.example.com"], "cdn.example.com"),
    true
  );
});

test("host matching ignores case and a trailing dot", () => {
  assert.equal(certCoversDomain("Example.COM", false, [], "example.com."), true);
  assert.equal(domainMatchesPatterns("CDN.example.com", ["cdn.example.com"]), true);
});

test("suffix lookalikes are not matched", () => {
  assert.equal(
    certCoversDomain("oss.example.com", false, [], "notoss.example.com"),
    false
  );
});

test("isWildcard alone does not create a wildcard pattern", () => {
  assert.equal(certCoversDomain("example.com", true, [], "cdn.example.com"), false);
  assert.equal(certCoversDomain("example.com", true, [], "example.com"), true);
});

test("match rank prefers exact CN over wildcard CN over exact SAN over wildcard SAN", () => {
  const exact = cert("cdn.example.com");
  const wildcard = cert("*.example.com");
  const san = cert("other.example.com", { sans: ["cdn.example.com"] });
  const wildcardSan = cert("other.example.com", { sans: ["*.example.com"] });

  assert.equal(matchRank(exact, "cdn.example.com"), 0);
  assert.equal(matchRank(wildcard, "cdn.example.com"), 1);
  assert.equal(matchRank(san, "cdn.example.com"), 2);
  assert.equal(matchRank(wildcardSan, "cdn.example.com"), 3);
  assert.equal(matchRank(exact, "other.example.com"), undefined);
  assert.equal(selectCertForDomain("cdn.example.com", [wildcard],), wildcard);
  assert.equal(
    selectCertForDomain("cdn.example.com", [san, exact]),
    exact
  );
});

test("a SAN certificate cannot claim a domain ahead of its exact certificate", () => {
  // Regression: alphabetical processing let `aaa.example.com` (SAN) claim the
  // domain before the certificate whose CN is the domain itself.
  const sanCert = cert("aaa.example.com", { sans: ["rollie-rank-oss.swimmingliu.cn"] });
  const exactCert = cert("rollie-rank-oss.swimmingliu.cn");
  const plan = buildBindingPlan(
    [sanCert, exactCert],
    [domain("rollie-rank-oss.swimmingliu.cn")],
    []
  );

  assert.equal(plan.length, 1);
  assert.equal(plan[0].cert.certificateId, exactCert.certificateId);
  assert.deepEqual(plan[0].cdnDomains, ["rollie-rank-oss.swimmingliu.cn"]);
});

test("plan and verify agree when a SAN cert and a wildcard both cover a domain", () => {
  const sanCert = cert("example.org", { sans: ["rollie-rank-oss.swimmingliu.cn"] });
  const wildcard = cert("*.swimmingliu.cn", { end: "2027-12-01 00:00:00" });
  const plan = buildBindingPlan(
    [wildcard, sanCert],
    [domain("rollie-rank-oss.swimmingliu.cn")],
    []
  );
  // A wildcard CN (rank 1) is more specific than a SAN on another domain (2).
  assert.equal(plan[0].cert.certificateId, wildcard.certificateId);
  // verify uses the same selection, so it can never expect a different cert.
  assert.equal(
    selectCertForDomain("rollie-rank-oss.swimmingliu.cn", [wildcard, sanCert])
      ?.certificateId,
    wildcard.certificateId
  );
});

test("the only certificate carrying a SAN is still used when another cert shares its CN", () => {
  // Two certs share Domain `swimmingliu.cn`; only the younger one has the SAN.
  const withoutSan = cert("swimmingliu.cn", { end: "2027-09-30 00:00:00", id: "no-san" });
  const withSan = cert("swimmingliu.cn", {
    end: "2027-01-31 00:00:00",
    id: "with-san",
    sans: ["rollie-rank-oss.swimmingliu.cn"],
  });
  const plan = buildBindingPlan(
    [withoutSan, withSan],
    [domain("rollie-rank-oss.swimmingliu.cn")],
    []
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0].cert.certificateId, "with-san");
});

test("a domain is claimed by exactly one certificate", () => {
  const plan = buildBindingPlan(
    [cert("oss.example.com", { id: "a" }), cert("oss.example.com", { id: "b" })],
    [domain("oss.example.com")],
    []
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0].cdnDomains.length, 1);
});

test("explicit cdn_domains mapping wins over automatic matching", () => {
  const manual = cert("example.com", { id: "manual" });
  const wildcard = cert("*.example.com", { id: "wildcard" });
  const plan = buildBindingPlan(
    [wildcard, manual],
    [domain("cdn.example.com")],
    [mapping({ certDomain: "example.com", cdnDomains: ["cdn.example.com"] })]
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0].cert.certificateId, "manual");
  assert.deepEqual(plan[0].cdnDomains, ["cdn.example.com"]);
});

test("a mapped domain missing from the Qiniu list is still bound", () => {
  const manual = cert("example.com", { id: "manual" });
  const plan = buildBindingPlan(
    [manual],
    [domain("cdn.example.com")],
    [mapping({ certDomain: "example.com", cdnDomains: ["dock.example.com"] })]
  );
  const byCert = Object.fromEntries(plan.map((p) => [p.cert.certificateId, p.cdnDomains]));
  assert.deepEqual(byCert.manual, ["dock.example.com"]);
});

test("manual mapping values are normalized (case, trailing dot)", () => {
  const c = cert("Example.com");
  const plan = buildBindingPlan(
    [c],
    [domain("cdn.example.com")],
    [
      mapping({
        certDomain: "EXAMPLE.com.",
        cdnDomains: ["CDN.EXAMPLE.COM."],
      }),
    ]
  );
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].cdnDomains, ["cdn.example.com"]);
});

test("normalized exclusions are honoured", () => {
  const plan = buildBindingPlan(
    [cert("*.example.com")],
    [domain("a.example.com"), domain("b.example.com")],
    [mapping({ certDomain: "*.example.com", excludeCdnDomains: ["A.example.com."] })]
  );
  assert.deepEqual(plan[0].cdnDomains, ["b.example.com"]);
});

test("auto_match false keeps a certificate out of automatic matching", () => {
  const plan = buildBindingPlan(
    [cert("example.com")],
    [domain("example.com")],
    [mapping({ certDomain: "example.com", autoMatch: false })]
  );
  assert.deepEqual(plan, []);
});
