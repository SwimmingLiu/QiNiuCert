import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAllMatches,
  certCoversDomain,
  domainMatchesPatterns,
  matchCertToDomains,
} from "../src/matcher.js";
import type { QiniuDomain } from "../src/qiniu.js";

const domain = (name: string, certId = ""): QiniuDomain => ({
  name,
  type: "normal",
  certId,
});

test("matches an exact cert domain to a newly added Qiniu domain", () => {
  const matched = matchCertToDomains(
    "rollie-rank-oss.swimmingliu.cn",
    false,
    [],
    [
      domain("rollie-rank-oss.swimmingliu.cn"),
      domain("oss.swimmingliu.cn"),
    ]
  );
  assert.deepEqual(matched, ["rollie-rank-oss.swimmingliu.cn"]);
});

test("wildcard cert covers one label but not the apex or deeper names", () => {
  assert.equal(
    certCoversDomain("*.example.com", true, [], "cdn.example.com"),
    true
  );
  assert.equal(
    certCoversDomain("*.example.com", true, [], "example.com"),
    false
  );
  assert.equal(
    certCoversDomain("*.example.com", true, [], "a.b.example.com"),
    false
  );
});

test("SANs are honoured", () => {
  assert.equal(
    certCoversDomain(
      "example.com",
      false,
      ["www.example.com", "cdn.example.com"],
      "cdn.example.com"
    ),
    true
  );
});

test("host matching ignores case and a trailing dot", () => {
  assert.equal(
    certCoversDomain("Example.COM", false, [], "example.com."),
    true
  );
  assert.equal(domainMatchesPatterns("CDN.example.com", ["cdn.example.com"]), true);
});

test("suffix lookalikes are not matched", () => {
  assert.equal(
    certCoversDomain("oss.example.com", false, [], "notoss.example.com"),
    false
  );
});

test("a domain is claimed by one cert only, exact match first", () => {
  const matches = buildAllMatches(
    new Map([
      ["swimmingliu.cn", { isWildcard: false, sans: ["oss.swimmingliu.cn"] }],
      ["*.swimmingliu.cn", { isWildcard: true, sans: [] }],
    ]),
    [domain("oss.swimmingliu.cn"), domain("img.swimmingliu.cn")],
    []
  );
  assert.deepEqual(matches.get("swimmingliu.cn"), ["oss.swimmingliu.cn"]);
  assert.deepEqual(matches.get("*.swimmingliu.cn"), ["img.swimmingliu.cn"]);
});

test("isWildcard alone does not create a wildcard pattern", () => {
  // Tencent reports the concrete domain, so a bare `IsWildcard=true` must not
  // make `example.com` compile into `*.example.com`.
  assert.equal(certCoversDomain("example.com", true, [], "cdn.example.com"), false);
  assert.equal(certCoversDomain("example.com", true, [], "example.com"), true);
  assert.equal(
    certCoversDomain("*.example.com", true, [], "cdn.example.com"),
    true
  );
});

test("explicit cdn_domains mapping is used verbatim", () => {
  const matched = matchCertToDomains("example.com", false, [], [], {
    certDomain: "example.com",
    cdnDomains: ["b.example.com", "a.example.com"],
    excludeCdnDomains: [],
    autoMatch: true,
  });
  assert.deepEqual(matched, ["a.example.com", "b.example.com"]);
});

test("excluded domains are skipped", () => {
  const matched = matchCertToDomains(
    "*.example.com",
    true,
    [],
    [domain("a.example.com"), domain("b.example.com")],
    {
      certDomain: "*.example.com",
      cdnDomains: [],
      excludeCdnDomains: ["b.example.com"],
      autoMatch: true,
    }
  );
  assert.deepEqual(matched, ["a.example.com"]);
});

test("auto_match false disables matching for that cert", () => {
  const matched = matchCertToDomains(
    "example.com",
    false,
    [],
    [domain("example.com")],
    {
      certDomain: "example.com",
      cdnDomains: [],
      excludeCdnDomains: [],
      autoMatch: false,
    }
  );
  assert.deepEqual(matched, []);
});
