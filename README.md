# url-json-extract

URL → JSON extract service (Node/Express) with optional **x402** paywall on `POST /v1/extract`. Fetches a page over HTTPS, pulls dumb HTML signals (`<title>`, meta/og, JSON-LD), shapes an object to match a client-supplied JSON Schema, and validates with Ajv.

`GET /health` is always free (no payment).

## API

### `GET /health`

```json
{"ok":true}
```

### `POST /v1/extract`

Request body (Zod-validated):

```json
{ "url": "https://example.com", "schema": { "...": "JSON Schema object" } }
```

**Success (200):** response body **is** the extracted object that matches `schema` (no `{ok,data}` wrapper).

**Errors:**
- `400` — bad/unsafe URL (SSRF, non-https), invalid request, invalid schema, or Ajv validation failure (`{ error, errors }` Ajv-style)
- `402` — payment required (when paywall is configured; see x402 below)
- `413` — upstream body over size cap (~2 MB)
- `503` — paywall required but `PAY_TO_ADDRESS` missing (`NODE_ENV=production` or `REQUIRE_X402=1`)
- `504` — upstream timeout (~8 s)

## Env vars

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `PAY_TO_ADDRESS` | _(empty)_ | EVM address (`0x…`) that receives payments. **Required in production.** |
| `X402_NETWORK` | `eip155:84532` | CAIP-2 network id (Base Sepolia testnet) |
| `X402_PRICE` | `$0.001` | Price string for x402 exact scheme |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | Public testnet facilitator |
| `REQUIRE_X402` | _(unset)_ | Set `1` to refuse unpaid extract when `PAY_TO_ADDRESS` is missing |
| `NODE_ENV` | _(unset)_ | If `production` and no `PAY_TO_ADDRESS`, extract returns `503` |

Local default (no `PAY_TO_ADDRESS`): server starts, logs a warning, and `/v1/extract` stays **unprotected** so unpaid curls still work. Production **must** set `PAY_TO_ADDRESS` (or set `REQUIRE_X402=1`).

## Local run

```bash
npm install
PORT=3000 npm start
```

With paywall (Base Sepolia testnet):

```bash
PAY_TO_ADDRESS=0x0000000000000000000000000000000000000001 \
X402_NETWORK=eip155:84532 \
X402_PRICE='$0.001' \
FACILITATOR_URL=https://x402.org/facilitator \
PORT=3001 npm start
```

## Curl examples

### Health (always free)

```bash
curl -sS http://127.0.0.1:3000/health
```

### Unpaid local extract (no `PAY_TO_ADDRESS`)

Happy path (example.com title):

```bash
curl -sS -X POST http://127.0.0.1:3000/v1/extract \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","schema":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}}'
```

Expected: `{"title":"Example Domain"}` (or similar containing `Example Domain`).

Schema failure (required field not extracted):

```bash
curl -sS -X POST http://127.0.0.1:3000/v1/extract \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","schema":{"type":"object","properties":{"missingField":{"type":"string"}},"required":["missingField"]}}'
```

Expected: `400` with Ajv `errors`.

### 402 without payment (paywall configured)

```bash
curl -sS -i -X POST http://127.0.0.1:3001/v1/extract \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","schema":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}}'
```

Expected: **HTTP 402** with a payment-required body and headers (e.g. `PAYMENT-REQUIRED` / `WWW-Authenticate` depending on `@x402/express` version). `/health` on the same port still returns `200`.

## SSRF / fetch guards

- HTTPS only
- Blocks localhost, `*.local`, `*.internal`, private/link-local/metadata IPs (`169.254.169.254`, `::1`, etc.)
- Manual redirects (max 3); each hop re-checked
- ~8 s timeout, ~2 MB body cap (stream abort)

## Railway deploy

```bash
railway login
railway init   # or link an existing project
railway up
```

Set Railway variables (production **must** include `PAY_TO_ADDRESS`):

- `PAY_TO_ADDRESS` — your receiving EVM address
- `X402_NETWORK` — e.g. `eip155:84532` (Base Sepolia) or mainnet CAIP-2 id
- `X402_PRICE` — e.g. `$0.001`
- `FACILITATOR_URL` — facilitator endpoint for that network
- `NODE_ENV=production` (optional but recommended; without `PAY_TO_ADDRESS` extract returns 503)

`PORT` is provided by Railway automatically; `npm start` reads `process.env.PORT` (default 3000).

Optional `Procfile`: `web: npm start`.
