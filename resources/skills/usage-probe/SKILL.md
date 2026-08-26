---
name: usage-probe
description: 为 PiDeck 的「用量查询」功能编写自定义供应商配置。当用户想让某个供应商/中转站显示用量、余额或额度点数，而 PiDeck 内置支持里没有时，使用此技能引导用户写出 usage-probes.json 配置，或帮用户搜索该供应商的用量/余额接口文档。
---

# 用量查询自定义（usage-probe）

## 这是什么

PiDeck 输入框旁的「圆环」面板会显示当前供应商的用量/余额。内置已支持少数供应商
（opencode-go、DeepSeek）。如果你的供应商不在内置列表里，可以通过一个**纯 JSON 配置文件**
让它也能显示用量，**不需要写任何代码**。

配置文件位置（和 models.json 同一个目录）：

```
~/.pi/agent/usage-probes.json
```

改完立刻生效（无需重启），下次打开圆环面板就会读到新配置。

## 你（AI）的工作流程

当用户说「帮我让 XX 供应商显示用量」时，按下面顺序做：

1. **先看用户的供应商信息**：读 `~/.pi/agent/models.json`，找到该 provider 的
   `baseUrl`（就是匹配用的关键字）和 `api` 类型。apiKey 的位置不用读出来，也不要把
   key 贴到任何地方——请求是主进程用 Bearer 自动带的。
2. **确认用量/余额接口**：询问或搜索该供应商的「余额 / usage / balance / credits」
   接口。常见的搜索词：
   - `<供应商名> API 余额接口`、`<供应商名> balance API`
   - `<供应商名> usage endpoint`、`<供应商名> credits endpoint`
   - OpenRouter 是 `GET /api/v1/credits`；DeepSeek 是 `GET /user/balance`；
     Kimi/Moonshot 是 `GET /v1/users/me/balance`（以官方文档为准）。
   - 如果用户拿不到文档，让用户用浏览器打开供应商控制台的「用量/账单」页面，
     按 F12 看 Network 里那个返回数字的请求，把 URL 路径和返回的 JSON 结构发给你。
3. **确定响应里哪个字段是「剩余额度」**：看接口返回的 JSON，找到表示余额/剩余点数的
   字段（路径写法见下面「字段路径怎么写」）。
4. **生成 JSON 并让用户保存**：按下面的结构写出一份 `usage-probes.json`，让用户保存到
   `~/.pi/agent/usage-probes.json`（或直接告诉用户复制粘贴）。
5. **验证**：让用户打开圆环面板看是否显示。如果不显示，让用户把接口返回的**脱敏后**
   JSON 发给你（记得提醒用户抹掉 key/token），继续调整字段路径。

> 重要安全边界：配置文件里**不要**写 apiKey。鉴权统一走 `Authorization: Bearer <key>`，
> 主进程自动从 auth.json/models.json 取 key；只有个别接口用非标准鉴权头时才用
> `"headers": { "X-API-Key": "{{apiKey}}" }` 占位。

## 配置文件结构

顶层是一个 `probes` 数组，每条是一个供应商。字段含义：

```jsonc
{
  "probes": [
    {
      // （可选）只是给自己看的名字，不影响功能
      "name": "我的中转站",

      // 匹配条件：你的供应商 baseUrl 里包含的任意关键字（小写匹配）
      "match": {
        "baseUrlContains": ["api.myprovider.com"]
      },

      // 发什么请求
      "request": {
        "path": "/user/balance",   // 相对 baseUrl 的路径，必须以 / 开头
        "method": "GET",            // 可选，GET 或 POST，缺省 GET
        // "body": { ... },         // 可选，POST 时的请求体
        // "headers": { "X-API-Key": "{{apiKey}}" }  // 可选，非标准鉴权头
      },

      // 怎么从响应里取数（三种形态选一种）
      "parse": {
        "kind": "balance",
        "valuePath": "balance_infos[0].total_balance",   // 剩余额度的字段路径
        "currencyPath": "balance_infos[0].currency"      // 可选，币种
      }
    }
  ]
}
```

### 三种 parse 形态

**1. balance（剩余额度，一个数字 + 可选币种）**

```jsonc
"parse": {
  "kind": "balance",
  "valuePath": "data.available_balance",
  "currencyPath": "data.currency"
}
```

**2. credits（额度点数，总额 / 已用 / 剩余，至少给一个）**

```jsonc
"parse": {
  "kind": "credits",
  "totalPath": "data.total_credits",     // 可选
  "usedPath": "data.total_usage",        // 可选
  "remainingPath": "data.remaining"      // 可选；不给时会用 total-used 自动算
}
```

**3. periods（三档百分比：滚动 / 周 / 月）**

```jsonc
"parse": { "kind": "periods" }
```

periods 形态不需要写字段路径：解析器会自动找响应里的
`usage.rolling / usage.weekly / usage.monthly`，每档取 `percent` / `resetsAt` / `status`。
只要你的供应商接口返回类似 `{ "usage": { "weekly": { "percent": 68 } } }` 的结构，
直接用 periods 即可，不用写路径。

### 字段路径怎么写

用「点号 + 方括号」从响应根一层层往下指：

- `data.balance` → `{ "data": { "balance": 110 } }` 里的 110
- `balance_infos[0].total_balance` → 数组第一项的 total_balance
- `data.credits.total` → 嵌套对象

数字可以是 number，也可以是能转成数字的字符串（很多网关余额字段是 `"110.00"` 这种字符串）。

## 完整示例

### 示例一：某 OpenAI 兼容网关返回 `{ data: { balance: 12.5, currency: "USD" } }`

```json
{
  "probes": [
    {
      "name": "我的网关",
      "match": { "baseUrlContains": ["gateway.example.com"] },
      "request": { "path": "/v1/balance" },
      "parse": {
        "kind": "balance",
        "valuePath": "data.balance",
        "currencyPath": "data.currency"
      }
    }
  ]
}
```

### 示例二：OpenRouter（额度点数）

```json
{
  "probes": [
    {
      "name": "OpenRouter",
      "match": { "baseUrlContains": ["openrouter.ai"] },
      "request": { "path": "/credits" },
      "parse": {
        "kind": "credits",
        "remainingPath": "data.total_credits",
        "usedPath": "data.total_usage"
      }
    }
  ]
}
```

> 提示：不同网关字段名可能不同，以上示例里的字段名请以官方文档或实际抓包为准。

## 排查清单

- 圆环面板显示「用量暂时不可用」但没有报错：多半是接口返回的字段路径没对上，
  把脱敏后的响应 JSON 发给 AI 帮你对齐路径。
- 显示「当前 provider 暂不支持用量查询」：说明没有匹配到任何探针。检查
  `match.baseUrlContains` 里的关键字，是不是和 `models.json` 里那个 provider 的
  `baseUrl` 完全不一致（注意大小写、是否带 `/v1`）。
- 配置写错了 JSON：主进程会忽略整条非法探针并在日志里提示，不会影响内置探针。
- 余额显示成「0」：可能字段取错了位置，或接口返回的字段本身是「已用」而不是「剩余」。
