/**
 * Tencent Cloud SSL Certificate API wrapper.
 * Uses the official tencentcloud-sdk-nodejs-ssl SDK.
 */

import tencentcloud from "tencentcloud-sdk-nodejs-ssl";

const SslClient = tencentcloud.ssl.v20191205.Client;

export interface CertSummary {
  certificateId: string;
  domain: string;
  alias: string;
  status: number;
  certBeginTime: string;
  certEndTime: string;
}

export interface CertDetail {
  certificateId: string;
  domain: string;
  alias: string;
  status: number;
  certBeginTime: string;
  certEndTime: string;
  publicKey: string;
  privateKey: string;
  fingerprint: string;
  subjectAltNames: string[];
  isWildcard: boolean;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

export class TencentSSLClient {
  private client: InstanceType<typeof SslClient>;

  constructor(secretId: string, secretKey: string, region = "ap-guangzhou") {
    this.client = new SslClient({
      credential: {
        secretId,
        secretKey,
      },
      region,
      profile: {
        httpProfile: {
          endpoint: "ssl.tencentcloudapi.com",
        },
      },
    });
  }

  async listCertificates(
    status: number[] = [1],
    searchKey?: string
  ): Promise<CertSummary[]> {
    const allCerts: CertSummary[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const resp = await this._retry(() =>
        this.client.DescribeCertificates({
          Offset: offset,
          Limit: limit,
          CertificateStatus: status,
          SearchKey: searchKey,
        })
      );

      if (resp.Certificates) {
        for (const cert of resp.Certificates) {
          allCerts.push({
            certificateId: cert.CertificateId || "",
            domain: cert.Domain || "",
            alias: (cert as any).Alias || "",
            status: cert.Status || 0,
            certBeginTime: (cert as any).CertBeginTime || "",
            certEndTime: (cert as any).CertEndTime || "",
          });
        }
      }

      if (allCerts.length >= (resp.TotalCount || 0)) break;
      offset += limit;
    }

    return allCerts;
  }

  async getCertificateDetail(certificateId: string): Promise<CertDetail> {
    const resp = await this._retry(() =>
      this.client.DescribeCertificateDetail({
        CertificateId: certificateId,
      })
    );

    return {
      certificateId: resp.CertificateId || "",
      domain: resp.Domain || "",
      alias: (resp as any).Alias || "",
      status: resp.Status || 0,
      certBeginTime: (resp as any).CertBeginTime || "",
      certEndTime: (resp as any).CertEndTime || "",
      publicKey: (resp as any).CertificatePublicKey || "",
      privateKey: (resp as any).CertificatePrivateKey || "",
      fingerprint: (resp as any).CertFingerprint || "",
      subjectAltNames: (resp as any).SubjectAltName || [],
      isWildcard: (resp as any).IsWildcard || false,
    };
  }

  private async _retry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const isRetryable =
          err?.code === "RequestLimitExceeded" ||
          err?.code === "InternalError" ||
          err?.code === "ResourceInsufficient" ||
          (err?.statusCode && err.statusCode >= 500);

        if (isRetryable && attempt < retries - 1) {
          const wait = RETRY_DELAY_MS * (attempt + 1);
          console.warn(
            `Tencent API call failed (attempt ${attempt + 1}/${retries}): ${err.message}. Retrying in ${wait}ms...`
          );
          await new Promise((r) => setTimeout(r, wait));
        } else {
          throw err;
        }
      }
    }
    throw new Error("unreachable");
  }
}
