# QiNiuCert

> 七牛云 SSL 证书自动同步工具 —— 从腾讯云自动同步 SSL 证书到七牛云 CDN。

[![npm version](https://img.shields.io/npm/v/@swimmingliu/qiniucert)](https://www.npmjs.com/package/@swimmingliu/qiniucert)
[![License](https://img.shields.io/npm/l/@swimmingliu/qiniucert)](LICENSE)

## 背景

腾讯云的免费 SSL 证书（TrustAsia C1 DV Free）可以自动续签，但七牛云 CDN 不会自动同步更新后的证书。`qiniucert` 解决了这个问题：

1. 从腾讯云获取最新证书（含公钥 + 私钥）
2. 比对 SHA1 指纹判断证书是否已更新
3. 上传新证书到七牛云
4. 绑定证书到对应 CDN 域名（默认开启强制 HTTPS）

## 安装

```bash
# npm
npm install -g @swimmingliu/qiniucert

# pnpm
pnpm add -g @swimmingliu/qiniucert

# 或直接使用 npx（无需安装）
npx @swimmingliu/qiniucert sync --dry-run
```

## 配置

创建 `config.yaml`（参考 `config.example.yaml`）：

```yaml
# 腾讯云 API 凭证（https://console.cloud.tencent.com/cam/capi）
tencent:
  secret_id: "AKIDxxxx"
  secret_key: "xxxx"
  region: "ap-guangzhou"

# 七牛云 API 凭证（https://portal.qiniu.com/user/key）
qiniu:
  access_key: "xxxx"
  secret_key: "xxxx"

# 域名映射（可选，不配置则自动匹配）
domains:
  - cert_domain: "example.com"
    cdn_domains:
      - "cdn.example.com"

sync:
  force_https: true   # 默认开启强制 HTTPS 跳转
```

### 域名匹配规则

- **自动匹配**（默认）：从七牛云获取所有 CDN 域名，按证书域名自动匹配
  - 精确匹配：`example.com` ↔ `example.com`
  - 泛域名匹配：`*.example.com` ↔ `cdn.example.com`、`static.example.com`
- **手动指定**：在 `domains` 中显式配置 `cert_domain → cdn_domains`
- **排除域名**：`exclude_cdn_domains` 可排除特定域名

## 使用

```bash
# 增量同步（仅同步变化的证书）
qiniucert sync

# 预览变更（dry-run）
qiniucert sync --dry-run

# 强制全量同步
qiniucert sync --force

# 使用指定配置文件
qiniucert sync -c /path/to/config.yaml

# 重新绑定证书（如修改 forceHttps 后）
qiniucert rebind

# 查看缓存状态
qiniucert status
```

## 工作原理

```
腾讯云 SSL API                   QiNiuCert                    七牛云 CDN API
──────────────                  ──────────                    ──────────────
DescribeCertificates ──▶  获取证书列表
DescribeCertificateDetail  获取公钥+私钥+指纹
                                                        ◀── GET /domain
                          域名匹配 + 指纹比对
                          ├─ 已变更 ──▶ POST /sslcert ──▶  上传证书
                          │            PUT /httpsconf ──▶  绑定域名
                          └─ 未变更 ──▶  跳过
                          更新 .cert_cache.json
```

## 定时运行

### GitHub Actions（推荐）

仓库已包含 `.github/workflows/sync.yml`，配置以下 Secrets 即可每日自动同步：

- `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`
- `QINIU_ACCESS_KEY` / `QINIU_SECRET_KEY`

### Cron

```bash
# 每天凌晨 3 点
0 3 * * * cd /path/to/QiNiuCert && qiniucert sync >> sync.log 2>&1
```

## 安全

- `config.yaml` 含 API 密钥，已在 `.gitignore` 中忽略
- `.cert_cache.json` 不存储私钥（仅存 SHA1 指纹 + CertID）
- 推荐用 CI/CD Secrets 或环境变量管理密钥

## License

Apache-2.0
