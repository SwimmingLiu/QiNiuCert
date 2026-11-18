import test from "node:test";
import assert from "node:assert/strict";
import { leafCertificateBody, sameLeafCertificate } from "../src/pem.js";

const wrap = (body: string) =>
  `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;

test("leaf body ignores line wrapping", () => {
  const body = "A".repeat(200);
  assert.equal(
    leafCertificateBody(wrap(body)),
    leafCertificateBody(`-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`)
  );
});

test("only the first block of a chain is compared", () => {
  const leaf = "L".repeat(100);
  const chain = `${wrap(leaf)}${wrap("I".repeat(100))}`;
  assert.equal(leafCertificateBody(chain), leaf);
});

test("same leaf certificate", () => {
  const leaf = "M".repeat(120);
  assert.equal(sameLeafCertificate(wrap(leaf), wrap(leaf)), true);
  assert.equal(sameLeafCertificate(wrap(leaf), wrap("N".repeat(120))), false);
  assert.equal(sameLeafCertificate(undefined, wrap(leaf)), false);
  assert.equal(sameLeafCertificate("not a pem", wrap(leaf)), false);
});
