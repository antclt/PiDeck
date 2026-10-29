# watcha-edge — 爱猹收打赏代理

PiDeck 的「请作者喝咖啡」需要一个能保管**服务端 API Key** 的地方。
Electron 客户端不能持有它（解包即泄漏），所以中间放这一个 Worker：只转发
`/access`，不碰模型、不碰余额逻辑、不扣次数。

## 当前部署

| 项 | 值 |
|---|---|
| Worker 名 | `watcha-edge` |
| 域名 | `https://pideck-pay.caoayu.top`（custom domain，绑定在 `caoayu.top` 区域） |
| 账户 | `7a550f5222c5a06652bfa6d26ec40b95` |
| 环境 | **正式（live）** |
| 放置策略 | `[placement] mode = "smart"`（尽量靠近源站，杀延迟） |

沙箱如果要单独跑，另建一个 Worker（换 key 与 entitlement），不要复用这个。

## 它做什么

| 路由 | 入参 | 出参 |
|---|---|---|
| `POST /access` | `{ user_id }` | `{ access, remaining, purchaseUrl?, qrCodeUrl? }` |
| `GET /health` | — | `{ ok: true }` |

上游固定为 `https://pay.watcha.cn`，`entitlement_id` 来自环境变量，请求体里
不接受任何 URL —— 避免这个入口被当成开放代理。

## 两种部署形态

| 形态 | 文件 | 适用 |
|---|---|---|
| Cloudflare Worker | `worker.mjs` + `wrangler.toml` | 免费、免运维；但边缘到境内源站延迟高（见下） |
| 自建 Node 服务 | `server.mjs` | 有国内/香港 VPS 时首选，链路快且稳：`WATCHA_API_KEY=... WATCHA_ENTITLEMENT=... PORT=8787 node server.mjs` |

两者契约完全一致，客户端只认 `src/shared/watcha.ts` 里的 `WATCHA_EDGE_URL`，换部署形态改这一行即可。

## 已知问题：跨境延迟

Cloudflare 边缘 → `pay.watcha.cn` 实测 **8–12 秒**，偶发失败。已做的缓解：

1. 单次上游超时 6s，失败重试一次（总预算 12s）；
2. Smart Placement 让 Worker 尽量跑在靠近源站的机房（生效需要一点流量学习时间）。

应用侧是「打开弹窗才查一次」，可以接受；如果以后要放进常驻 UI，就该换成
香港/国内 VPS 或直接在自有服务端做。

## 重新部署

```bash
cd deploy/watcha-edge
CLOUDFLARE_API_TOKEN=... npx wrangler deploy
```

改 key（例如换成沙箱）只需重推 secret：

```bash
cat ~/.watcha-live-key | tr -d '\n' | npx wrangler secret put WATCHA_API_KEY
printf '%s' 'ent_xxx' | npx wrangler secret put WATCHA_ENTITLEMENT
```

## 取舍

- **没有鉴权**：拿到域名的人可以替任意 user_id 查支持记录（无法窃取资金）。
- **没有限流**：Cloudflare 免费额度够用；被打再上 WAF rate limit。
- 客户端 CSP 不放行 `mobilecodec.alipay.com`，二维码在本地由文本生成。
