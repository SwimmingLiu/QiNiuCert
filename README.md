# QiNiuCert

> 把腾讯云 SSL 证书自动同步到七牛云 CDN

[![npm version](https://img.shields.io/npm/v/@swimmingliu/qiniucert)](https://www.npmjs.com/package/@swimmingliu/qiniucert)

腾讯云免费证书能自动续签，七牛云不认。这工具干一件事：把最新证书搬过去。

## 安装

```bash
npm install -g @swimmingliu/qiniucert
# 或者不装直接用
npx @swimmingliu/qiniucert sync --dry-run
```

## 配置

复制 `config.example.yaml` 为 `config.yaml`，填好 API 密钥：

```yaml
tencent:
  secret_id: "AKIDxxxx"     # 腾讯云 API 密钥
  secret_key: "xxxx"

qiniu:
  access_key: "xxxx"        # 七牛云 API 密钥
  secret_key: "xxxx"

sync:
  force_https: true         # 开启强制 HTTPS（默认）
```

域名映射不用配，工具会自动从七牛云拉域名列表，按证书域名自动匹配。泛域名 `*.example.com` 能匹配到 `cdn.example.com` 这类子域名。

想手动控制哪些域名绑哪些证书，可以加上 `domains` 字段：

```yaml
domains:
  - cert_domain: "example.com"
    cdn_domains: ["cdn.example.com", "static.example.com"]
```

## 使用

```bash
qiniucert sync                # 增量同步，只更新变了证书
qiniucert sync --dry-run      # 看看会干嘛，不动真格
qiniucert sync --force        # 强制全量重传
qiniucert rebind              # 换了 forceHttps 设置后重绑
qiniucert status              # 看缓存
```

每次同步会把证书 SHA1 指纹记在 `.cert_cache.json` 里。下次跑的时候指纹没变就跳过。

## 定时跑

仓库里带了 GitHub Actions workflow（`.github/workflows/sync.yml`）。在仓库 Settings → Secrets 里加上：

- `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`
- `QINIU_ACCESS_KEY` / `QINIU_SECRET_KEY`

就会每天凌晨 3 点（UTC）自动跑一次。手动触发也行。

用 cron 也一样：

```bash
0 3 * * * cd /path/to/project && qiniucert sync >> sync.log 2>&1
```

## License

Apache-2.0
