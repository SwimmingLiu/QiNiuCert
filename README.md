# QiNiuCert

> 把腾讯云 SSL 证书自动同步到七牛云 CDN

[![npm version](https://img.shields.io/npm/v/@swimmingliu/qiniucert)](https://www.npmjs.com/package/@swimmingliu/qiniucert)

腾讯云负责签发和续期证书，这工具负责把最新证书搬到七牛云。注意：免费 DV 证书需要在腾讯云控制台人工“快速续期”，并不支持自动续费。

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
qiniucert check-expiry       # 七牛证书临期（默认 7 天）时退出非零
qiniucert rebind              # 换了 forceHttps 设置后重绑
qiniucert status              # 看缓存
```

每次同步会把证书 SHA1 指纹记在 `.cert_cache.json` 里。下次跑的时候指纹没变就跳过。

## 定时跑

仓库里带了 GitHub Actions workflow（`.github/workflows/sync.yml`）。在仓库 Settings → Secrets 里加上：

- `TENCENT_SECERT_ID`（沿用现有名称）/ `TENCENT_SECRET_KEY`
- `QINIU_ACCESS_KEY` / `QINIU_SECRET_KEY`

就会每天 UTC 03:23 自动同步，并检查七牛证书是否在 7 天内到期。同步或临期检查失败时，GitHub 会向启用失败通知的账号发邮件；请在 GitHub Settings → Notifications 里开启 Actions 通知。手动触发也行。

公开仓库 60 天无活动会被 GitHub 停用定时任务。`.github/workflows/keepalive.yml` 每月 1 日和 15 日用 `GITHUB_TOKEN` 自动提交一次 `.github/keepalive`，防止停用。它不需要 PAT，只会向 `main` 提交保活时间；同日重复运行不会重复提交。它不能保证 Actions 永不故障，所以失败邮件通知仍然重要。

用 cron 也一样：

```bash
0 3 * * * cd /path/to/project && qiniucert sync >> sync.log 2>&1
```

## License

Apache-2.0
