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

域名映射不用配，工具会自动从七牛云拉域名列表，按证书覆盖范围自动匹配：精确域名优先于泛域名 `*.example.com`，泛域名只覆盖一层子域、不覆盖裸域；证书主域名和 SAN 都参与匹配；同一个域名只会绑一张证书，冲突时取最精确的那张。`exclude_cdn_domains` 里的域名不参与管理。

**新增域名不用改任何配置**：每次运行都会重新拉取七牛云域名列表。只要腾讯云上有一张覆盖新域名的证书（主域名或 SAN），新域名就会在下次同步时自动上传/复用证书并绑定 HTTPS。定时任务每天跑一次，等于加完域名最迟一天后自动生效。

想手动控制哪些域名绑哪些证书，可以加上 `domains` 字段：

```yaml
domains:
  - cert_domain: "example.com"
    cdn_domains: ["cdn.example.com", "static.example.com"]
```

## 使用

```bash
qiniucert sync                # 增量同步，只更新变了证书或还没绑定的域名
qiniucert sync --dry-run      # 看看会干嘛，不动真格
qiniucert sync --force        # 强制全量重传
qiniucert verify              # 校验七牛云每个域名的证书有效、未过期
qiniucert verify --check-reachability   # 同时验证 HTTPS 能正常握手
qiniucert check-expiry       # 七牛证书临期（默认 7 天）时退出非零
qiniucert rebind              # 换了 forceHttps 设置后重绑
qiniucert status              # 看缓存
```

每次同步会把证书指纹按证书域名记在 `.cert_cache.json` 里，同时记录每个 CDN 域名实际绑定的是哪张七牛证书。判断「跳过」时看的是七牛那边当前的绑定：已绑定且证书没变才跳过；新域名、绑定被手动移除、或绑了别的证书，都会在下次运行自动补绑。同一张证书新增域名时复用七牛上已有的证书 ID，不会重复上传。

`verify` 不走缓存，按和 `sync` 完全相同的匹配结果，直接对比腾讯云当前证书和七牛域名上实际绑定的证书内容，并检查到期时间。新加的域名如果没有任何证书覆盖会以 `unmatched` 报出来，加 `--fail-on-unmatched` 可让它退出非零。

## 定时跑

仓库里带了 GitHub Actions workflow（`.github/workflows/sync.yml`）。在仓库 Settings → Secrets 里加上：

- `TENCENT_SECERT_ID`（沿用现有名称）/ `TENCENT_SECRET_KEY`
- `QINIU_ACCESS_KEY` / `QINIU_SECRET_KEY`

就会每天 UTC 03:23 自动同步，并检查七牛证书是否在 7 天内到期。同步后会跑 `verify --check-reachability --fail-on-unmatched`：任何域名没绑证书、证书内容不是腾讯云当前那张、剩余有效期不足 7 天、或 HTTPS 握手失败，都会让任务失败并发通知。同步或临期检查失败时，GitHub 会向启用失败通知的账号发邮件；请在 GitHub Settings → Notifications 里开启 Actions 通知。手动触发也行。

`.github/workflows/ci.yml` 在每次 push 和 PR 上跑类型检查、单元测试和构建。

公开仓库 60 天无活动会被 GitHub 停用定时任务。`.github/workflows/keepalive.yml` 每月 1 日和 15 日用 `GITHUB_TOKEN` 自动提交一次 `.github/keepalive`，防止停用。它不需要 PAT，只会向 `main` 提交保活时间；同日重复运行不会重复提交。它不能保证 Actions 永不故障，所以失败邮件通知仍然重要。

用 cron 也一样：

```bash
0 3 * * * cd /path/to/project && qiniucert sync && qiniucert verify >> sync.log 2>&1
```

## License

Apache-2.0
