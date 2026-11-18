/**
 * PEM helpers used to decide whether the certificate already bound to a Qiniu
 * domain is the same one Tencent Cloud currently serves.
 *
 * Qiniu returns the uploaded chain (`ca`), while Tencent returns the leaf
 * certificate (`CertificatePublicKey`); the first PEM block of both is
 * compared by its DER bytes, so line-wrapping differences do not matter.
 */

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/;

/** Normalized base64 body of the first certificate in a PEM chain. */
export function leafCertificateBody(pem: string | undefined): string | undefined {
  if (!pem) return undefined;
  const match = PEM_BLOCK.exec(pem);
  if (!match) return undefined;
  return match[1].replace(/\s+/g, "");
}

/** True when two PEM values share the same leaf certificate. */
export function sameLeafCertificate(
  a: string | undefined,
  b: string | undefined
): boolean {
  const left = leafCertificateBody(a);
  const right = leafCertificateBody(b);
  return Boolean(left) && left === right;
}
