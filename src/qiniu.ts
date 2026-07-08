/**
 * Qiniu Cloud CDN API wrapper.
 * Uses the Qiniu Node.js SDK for auth, and raw HTTP for SSL cert APIs
 * (since the Node.js SDK doesn't expose them).
 */

import qiniu from "qiniu";

const macAuth = qiniu.auth.digest.Mac;
const generateToken: (
  mac: any,
  requestURI: string,
  reqMethod: string,
  reqContentType: string,
  reqBody: string,
  reqHeaders?: any
) => string = qiniu.util.generateAccessTokenV2 as any;

const DOMAIN_API = "https://api.qiniu.com";

export interface QiniuDomain {
  name: string;
  type: string;
}

export class QiniuAPIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QiniuAPIError";
  }
}

export class QiniuCDNClient {
  private mac: any;

  constructor(accessKey: string, secretKey: string) {
    this.mac = new macAuth(accessKey, secretKey);
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<Record<string, any>> {
    const url = `${DOMAIN_API}${path}`;
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const contentType = "application/json";

    const accessToken = generateToken(
      this.mac,
      url,
      method,
      contentType,
      bodyStr || "",
      undefined
    ) as string;

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      Authorization: accessToken,
    };

    const resp = await fetch(url, {
      method,
      headers,
      body: bodyStr,
    });

    const data = (await resp.json()) as Record<string, any>;

    if (resp.status >= 400) {
      const errMsg = data?.error || resp.statusText;
      throw new QiniuAPIError(
        `Qiniu API error (HTTP ${resp.status}): ${errMsg}`
      );
    }

    return data;
  }

  async listDomains(): Promise<QiniuDomain[]> {
    try {
      const resp = await this.request("GET", "/domain");
      const rawDomains = resp.domains || [];
      return rawDomains.map((d: any) => ({
        name: d.name || "",
        type: d.type || "normal",
      }));
    } catch (err) {
      if (err instanceof QiniuAPIError) throw err;
      return [];
    }
  }

  async getDomain(name: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/domain/${name}`);
  }

  async createSSLCert(
    certName: string,
    commonName: string,
    privateKey: string,
    certificate: string
  ): Promise<string> {
    const resp = await this.request("POST", "/sslcert", {
      name: certName,
      common_name: commonName,
      pri: privateKey,
      ca: certificate,
    });

    const certId = resp.certID;
    if (!certId) {
      throw new QiniuAPIError(
        `Failed to get certID from response: ${JSON.stringify(resp)}`
      );
    }

    return certId;
  }

  async putHTTPSConf(
    domain: string,
    certId: string,
    forceHttps: boolean
  ): Promise<void> {
    await this.request("PUT", `/domain/${domain}/httpsconf`, {
      certid: certId,
      forceHttps,
    });
  }
}
