# MyLucky / LuckMail 私有邮箱网关：JS 自动化接入文档

本文面向 Node.js / JavaScript 自动化程序。目标是让原来调用 LuckMail 官方“购买邮箱 + token 查码”的程序，尽量只改 `baseURL` 和请求头，就能改用你导入的私有邮箱池。

## 1. 网关信息

```text
Base URL: https://luckmail.monsterx.site
Auth:     X-API-Key: <你的 LuckMail API Key>
```

> 当前网关鉴权复用你的 LuckMail key。不要把 key 写死到前端页面或公开仓库里，建议从环境变量读取。

Node.js 环境变量示例：

```bash
export LUCKMAIL_BASE_URL='https://luckmail.monsterx.site'
export LUCKMAIL_API_KEY='luck_xxx'
```

## 2. 给第三方接入时需要提供的信息

如果第三方是可信技术人员，通常只需要给这份文档，再单独给他可用的 `X-API-Key` 即可。

请明确告诉对方这几个固定值：

```text
Base URL: https://luckmail.monsterx.site
Header:   X-API-Key: <你提供给他的 key>
Domain:   outlook.jp
Project:  openai
Type:     ms_graph
```

第三方接入时只需要按这个流程做：

```text
1. 调 purchase 拿 email_address + token
2. 把 email_address 输入到自己的自动化流程
3. 触发目标站发送邮箱验证码
4. 用 token 轮询 /code
5. 拿到 verification_code 后提交验证码
```

重要约束：

- `quantity` 固定传 `1`，不要批量提前购买/占用邮箱。
- 轮询间隔建议 `3` 秒左右。
- 单个订单等待建议 `180-300` 秒。
- 必须先触发验证码发送，再开始轮询 `/code`。
- 收到 `status=success` 且 `verification_code` 非空后，再提交验证码。
- 一个邮箱成功接到验证码后会被标记为 `used`，后续不会再次分配。
- 不要把 key 写进前端页面、浏览器扩展公开代码或公开仓库。

调试时请让第三方回传以下信息，不需要让他提供完整 key：

```text
order_no
HTTP status
response code
response message
token 前 12 位，例如 lmp_xxxxx...
发生问题的大概时间
```

不需要给第三方：服务器 SSH、Cloudflare 权限、state.json、邮箱池完整列表、部署脚本。

## 3. 兼容的旧接口

网关兼容以下 LuckMail 风格接口：

```text
POST /api/v1/openapi/email/purchase
GET  /api/v1/openapi/email/token/{token}/alive
GET  /api/v1/openapi/email/token/{token}/code
```

核心流程：

1. `purchase` 分配一个私有邮箱，并返回本地兼容 `token`。
2. 自动化程序把 `email_address` 提交给目标注册/登录流程。
3. 目标触发邮件验证码后，程序用 `token` 轮询 `/code`。
4. 网关收到验证码后会把该邮箱标记为 `used`，后续默认不再分配。

## 4. 最小改造方式

如果你原来的 JS 程序已经这样封装了 LuckMail：

```js
const baseURL = 'https://mail.luckyous.com';
```

改成：

```js
const baseURL = process.env.LUCKMAIL_BASE_URL || 'https://luckmail.monsterx.site';
```

并确保每个请求带上：

```js
headers: {
  'X-API-Key': process.env.LUCKMAIL_API_KEY,
}
```

## 5. 使用 Node.js fetch 接入

Node.js 18+ 自带 `fetch`。

```js
const BASE_URL = process.env.LUCKMAIL_BASE_URL || 'https://luckmail.monsterx.site';
const API_KEY = process.env.LUCKMAIL_API_KEY;

if (!API_KEY) {
  throw new Error('Missing LUCKMAIL_API_KEY');
}

async function luckmailRequest(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'X-API-Key': API_KEY,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`LuckMail gateway returned non-JSON: HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  if (!res.ok || payload.code !== 0) {
    throw new Error(`LuckMail gateway error: HTTP ${res.status}, code=${payload.code}, message=${payload.message}`);
  }

  return payload.data;
}

async function purchaseEmail({
  projectCode = 'openai',
  emailType = 'ms_graph',
  domain = 'outlook.jp',
  quantity = 1,
  specifiedEmail,
} = {}) {
  return luckmailRequest('/api/v1/openapi/email/purchase', {
    method: 'POST',
    body: JSON.stringify({
      project_code: projectCode,
      email_type: emailType,
      domain,
      quantity,
      ...(specifiedEmail ? { specified_email: specifiedEmail } : {}),
    }),
  });
}

async function checkAlive(token) {
  return luckmailRequest(`/api/v1/openapi/email/token/${encodeURIComponent(token)}/alive`);
}

async function getCode(token) {
  return luckmailRequest(`/api/v1/openapi/email/token/${encodeURIComponent(token)}/code`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCode(token, {
  timeoutMs = 5 * 60 * 1000,
  intervalMs = 3000,
  onPoll = () => {},
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastResult = null;

  while (Date.now() < deadline) {
    lastResult = await getCode(token);
    onPoll(lastResult);

    if (lastResult.status === 'success' && lastResult.verification_code) {
      return lastResult.verification_code;
    }

    if (['timeout', 'cancelled'].includes(lastResult.status)) {
      throw new Error(`Mail order ended with status=${lastResult.status}`);
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for verification code; lastStatus=${lastResult?.status || 'unknown'}`);
}

async function main() {
  const purchase = await purchaseEmail({
    projectCode: 'openai',
    emailType: 'ms_graph',
    domain: 'outlook.jp',
    quantity: 1,
  });

  const item = purchase.purchases[0];
  console.log('email:', item.email_address);
  console.log('order_no:', item.order_no);
  console.log('token:', item.token);

  // 这里把 item.email_address 交给你的注册/登录自动化流程。
  // 等目标页面/API 触发发送验证码后，再开始轮询。

  const code = await waitForCode(item.token, {
    timeoutMs: 180_000,
    intervalMs: 3_000,
    onPoll: (result) => console.log('poll:', result.status),
  });

  console.log('verification code:', code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## 6. 使用 axios 接入

安装：

```bash
npm install axios
```

示例：

```js
import axios from 'axios';

const client = axios.create({
  baseURL: process.env.LUCKMAIL_BASE_URL || 'https://luckmail.monsterx.site',
  timeout: 120_000,
  headers: {
    'X-API-Key': process.env.LUCKMAIL_API_KEY,
    Accept: 'application/json',
  },
});

async function request(config) {
  const res = await client.request(config);
  if (res.data?.code !== 0) {
    throw new Error(`LuckMail gateway error: code=${res.data?.code}, message=${res.data?.message}`);
  }
  return res.data.data;
}

export async function purchaseEmail() {
  return request({
    method: 'POST',
    url: '/api/v1/openapi/email/purchase',
    data: {
      project_code: 'openai',
      email_type: 'ms_graph',
      domain: 'outlook.jp',
      quantity: 1,
    },
  });
}

export async function getCode(token) {
  return request({
    method: 'GET',
    url: `/api/v1/openapi/email/token/${encodeURIComponent(token)}/code`,
  });
}
```

## 7. 接口详情

### 7.1 购买/分配邮箱

```http
POST /api/v1/openapi/email/purchase
X-API-Key: <你的 LuckMail API Key>
Content-Type: application/json
```

请求体：

```json
{
  "project_code": "openai",
  "email_type": "ms_graph",
  "domain": "outlook.jp",
  "quantity": 1
}
```

可选字段：

- `domain`: 推荐传 `outlook.jp` 或你导入邮箱的域名。
- `specified_email`: 指定某一个邮箱；使用时 `quantity` 必须是 `1`。
- `quantity`: `1` 到 `100`，自动化注册建议一次拿 `1` 个，避免邮箱被长时间 reserved。

成功响应：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "purchases": [
      {
        "id": 1,
        "email_address": "user@outlook.jp",
        "token": "lmp_xxx",
        "project_name": "OpenAi",
        "price": "",
        "order_no": "ORD2026xxxx"
      }
    ],
    "total_cost": "",
    "balance_after": ""
  }
}
```

### 7.2 检查 token 是否有效

```http
GET /api/v1/openapi/email/token/{token}/alive
X-API-Key: <你的 LuckMail API Key>
```

成功响应：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "alive": true,
    "status": "ok",
    "order_no": "ORD2026xxxx",
    "email_address": "user@outlook.jp"
  }
}
```

### 7.3 查询验证码

```http
GET /api/v1/openapi/email/token/{token}/code
X-API-Key: <你的 LuckMail API Key>
```

未收到时：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "order_no": "ORD2026xxxx",
    "status": "pending",
    "verification_code": ""
  }
}
```

收到后：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "order_no": "ORD2026xxxx",
    "status": "success",
    "verification_code": "123456",
    "mail_from": "...",
    "mail_subject": "...",
    "mail_body_html": "..."
  }
}
```

`status` 常见值：

- `pending`: 还没收到验证码，继续轮询。
- `success`: 已收到验证码。
- `timeout`: LuckMail 订单超时。
- `cancelled`: 订单已取消。

## 8. 自动化程序推荐调用顺序

```text
purchase -> 拿 email_address/token
         -> 把 email_address 输入到目标流程
         -> 点击/调用发送验证码
         -> waitForCode(token)
         -> 把 verification_code 输入到目标流程
```

不要在还没触发发送验证码之前长时间高频轮询。推荐：

- 触发验证码后再开始轮询。
- 轮询间隔 `3s` 左右。
- 单个订单等待 `180s ~ 300s`。
- `quantity` 优先保持 `1`。

## 9. 错误处理

### 9.1 未带 key 或 key 错误

HTTP `401`：

```json
{
  "code": 401,
  "message": "unauthorized",
  "data": null
}
```

处理：检查 `X-API-Key` 是否传入，是否与网关配置一致。

### 9.2 分配失败

HTTP `400`：

```json
{
  "code": 400,
  "message": "...",
  "data": null
}
```

常见原因：

- 私有邮箱池没有匹配域名。
- `specified_email` 已被本地标记为 `used/reserved`。
- `quantity` 超出范围。

### 9.3 网关内部错误

HTTP `500`：

```json
{
  "code": 500,
  "message": "...",
  "data": null
}
```

处理：看网关服务日志，或者先用 `alive` / `purchase` 做最小复现。

## 10. 和官方 LuckMail 接口的差异

- 返回的 `token` 是本地兼容 token，通常以 `lmp_` 开头，不是 LuckMail 官方 token。
- 网关内部会把 `token` 映射到真实 LuckMail `order_no`。
- 私有邮箱成功收到验证码后，本地会标记为 `used`，默认避免二次分配。
- 新导入且不能 `specified_email` 的邮箱，网关会自动走预热/回退策略，不需要 JS 程序处理。

## 11. 迁移检查清单

- [ ] `baseURL` 改为 `https://luckmail.monsterx.site`
- [ ] 每个请求加 `X-API-Key`
- [ ] `purchase` 后保存 `email_address` 和 `token`
- [ ] 触发目标验证码发送后，再用 `token` 轮询 `/code`
- [ ] `status=success` 且 `verification_code` 非空时再提交验证码
- [ ] 不要把 API Key 写死到仓库或浏览器端代码

## 12. 最短可复制版本

```js
const BASE = 'https://luckmail.monsterx.site';
const KEY = process.env.LUCKMAIL_API_KEY;

async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      'X-API-Key': KEY,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const json = await res.json();
  if (!res.ok || json.code !== 0) throw new Error(json.message || `HTTP ${res.status}`);
  return json.data;
}

const data = await api('/api/v1/openapi/email/purchase', {
  method: 'POST',
  body: JSON.stringify({ project_code: 'openai', email_type: 'ms_graph', domain: 'outlook.jp', quantity: 1 }),
});

const { email_address, token } = data.purchases[0];
console.log(email_address, token);

// 触发验证码后轮询：
while (true) {
  const result = await api(`/api/v1/openapi/email/token/${encodeURIComponent(token)}/code`, {
    method: 'GET',
  });
  if (result.status === 'success' && result.verification_code) {
    console.log('code:', result.verification_code);
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
```
