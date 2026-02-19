# WeCom Fixed Domain Checklist (Path 1: Company Gateway)

Target:
- Public callback domain: `https://jpclaw-ai.mininglamp.com/webhook/wecom`
- Local JPClaw upstream: `http://127.0.0.1:18790`

## 1) DNS (Ops)
- Add record for `jpclaw-ai.mininglamp.com` to company gateway/LB entrypoint.
- Ensure external 443 is reachable.

## 2) Gateway Reverse Proxy (Ops)
- Route: `jpclaw-ai.mininglamp.com` -> `127.0.0.1:18790`
- Path pass-through: keep `/webhook/wecom` and query string unchanged.
- Method allowlist: `GET`, `POST`.
- Do not rewrite request body, query, or charset.
- Request timeout >= `30s`.

Nginx reference:

```nginx
server {
  listen 443 ssl http2;
  server_name jpclaw-ai.mininglamp.com;

  # tls cert files managed by your platform/cert manager
  # ssl_certificate ...
  # ssl_certificate_key ...

  location / {
    proxy_pass http://127.0.0.1:18790;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 30s;
  }
}
```

## 3) WeCom Console (Admin)
In "接收消息服务器配置":
- URL: `https://jpclaw-ai.mininglamp.com/webhook/wecom`
- Token: value in `.env` `WECOM_TOKEN`
- EncodingAESKey: value in `.env` `WECOM_ENCODING_AES_KEY`

## 4) Local JPClaw Preconditions (Done)
- `.env` configured:
  - `WECOM_ENABLED=true`
  - `WECOM_CORP_ID`
  - `WECOM_AGENT_ID`
  - `WECOM_APP_SECRET`
  - `WECOM_TOKEN`
  - `WECOM_ENCODING_AES_KEY`
- Gateway listening on `127.0.0.1:18790`.

## 5) Acceptance Test
1. Save config in WeCom console.
2. Verify WeCom URL check passes.
3. Send one text message in app/group.
4. Expect JPClaw to reply within ~1-5s.

## 6) Troubleshooting
- `域名主体校验未通过`: domain does not match enterprise filing/association policy.
- `invalid_signature`: token/aes key mismatch or gateway rewrote query/body.
- no reply:
  - verify access token call to WeCom API succeeds
  - verify gateway allows outbound to `qyapi.weixin.qq.com`
  - check `/Users/mlamp/Workspace/JPClaw/log/launchd-gateway.out.log`
