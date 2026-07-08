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
const FUSION_API = "https://fusion.qiniuapi.com";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

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
    body?: Record<string, unknown>,
    baseUrl = DOMAIN_API
  ): Promise<Record<string, any>> {
    const url = `${baseUrl}${path}`;
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

  private async requestWithFallback(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<Record<string, any>> {
    // Try primary endpoint first, fall back to fusion
    try {
      return await this.request(method, path, body, DOMAIN_API);
    } catch (err) {
      if (err instanceof QiniuAPIError && path.startsWith("/domain/")) {
        try {
          return await this.request(method, path, body, FUSION_API);
        } catch {
          // Fallback failed, throw original error
        }
      }
      throw err;
    }
  }

  private async retryRequest(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<Record<string, any>> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.requestWithFallback(method, path, body);
      } catch (err: any) {
        const status = err?.statusCode || err?.code;
        const isRetryable =
          status === 429 ||
          status === 502 ||
          status === 503 ||
          status === 504 ||
          err?.message?.includes("ETIMEDOUT") ||
          err?.message?.includes("ECONNREFUSED") ||
          err?.message?.includes("fetch failed");

        if (isRetryable && attempt < MAX_RETRIES - 1) {
          const wait = RETRY_DELAY_MS * (attempt + 1);
          console.warn(
            `Qiniu API call failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message}. Retrying in ${wait}ms...`
          );
          await new Promise((r) => setTimeout(r, wait));
        } else {
          throw err;
        }
      }
    }
    throw new Error("unreachable");
  }

  async listDomains(): Promise<QiniuDomain[]> {
    const resp = await this.retryRequest("GET", "/domain");
    const rawDomains = resp.domains || [];
    return rawDomains.map((d: any) => ({
      name: d.name || "",
      type: d.type || "normal",
    }));
  }

  async getDomain(name: string): Promise<Record<string, unknown>> {
    return this.retryRequest("GET", `/domain/${name}`);
  }

  async createSSLCert(
    certName: string,
    commonName: string,
    privateKey: string,
    certificate: string
  ): Promise<string> {
    const resp = await this.retryRequest("POST", "/sslcert", {
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
    await this.retryRequest("PUT", `/domain/${domain}/httpsconf`, {
      certid: certId,
      forceHttps,
    });
  }
}
