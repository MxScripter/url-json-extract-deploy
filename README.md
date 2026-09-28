# url-json-extract

URL → JSON extract service (Node/Express) with optional **x402** paywall.

- `POST /v1/extract` — fetch an HTTPS page, pull dumb HTML signals, shape to a JSON Schema (price default `$0.001`).
- `POST /v1/doc-extract` — fetch an HTTPS PDF, extract text (no OCR), heuristically map into a JSON Schema (price default `$0.05`).
- `GET /health` — always free.

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

### `POST /v1/doc-extract`

Request body:

```json
{ "url": "https://example.com/invoice.pdf", "schema": { "...": "JSON Schema object" } }
```

HTTPS URL to a **PDF** only. Text is extracted with `pdf-parse` in-process (falls back to `/usr/bin/pdftotext` / poppler). No OCR in phase-1.

Heuristics map invoice-ish fields (`invoice_number`, `date`, `total`, `vendor`, `line_items`, …) plus generic `Key: value` labeled lines onto the schema.

**Success (200):** response body **is** the schema object (no wrapper).

**Errors:**
- `400` — bad/unsafe URL (SSRF, non-https), invalid request, invalid schema, not a PDF, extract failure
- `402` — payment required (when paywall configured)
- `413` — PDF over ~5 MB or more than ~20 pages
- `422` — Ajv `schema_validation_failed` (doc-extract only; `/v1/extract` still uses `400` for this)
- `503` — paywall required but `PAY_TO_ADDRESS` missing
- `504` — fetch/extract timeout (~20 s)

Sample schemas live in `fixtures/schemas/{invoice,receipt,order}.json`. A small text invoice PDF is at `fixtures/sample-invoice.pdf`.

#### Local fixture URL (dev only)

When `ALLOW_LOCAL_FIXTURES=1` and `NODE_ENV` is **not** `production`, you can pass:

```json
{ "url": "file://sample-invoice.pdf", "schema": { ... } }
```

which reads `fixtures/sample-invoice.pdf` from disk (basename only — no path traversal). Never enable in production.

## Env vars

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `PAY_TO_ADDRESS` | _(empty)_ | EVM address (`0x…`) that receives payments. **Required in production.** |
| `X402_NETWORK` | `eip155:84532` | CAIP-2 network id (Base Sepolia testnet) |
| `X402_PRICE` | `$0.001` | Price for `POST /v1/extract` |
| `X402_DOC_PRICE` | `$0.05` | Price for `POST /v1/doc-extract` |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | Public testnet facilitator |
| `REQUIRE_X402` | _(unset)_ | Set `1` to refuse unpaid routes when `PAY_TO_ADDRESS` is missing |
| `NODE_ENV` | _(unset)_ | If `production` and no `PAY_TO_ADDRESS`, paid routes return `503` |
| `ALLOW_LOCAL_FIXTURES` | _(unset)_ | Set `1` to allow `file://…` fixture URLs for local doc-extract tests (ignored when `NODE_ENV=production`) |

Local default (no `PAY_TO_ADDRESS`): server starts, logs a warning, and both extract routes stay **unprotected**. Production **must** set `PAY_TO_ADDRESS` (or set `REQUIRE_X402=1`).

## x402 settle behavior

`@x402/express` **verifies before the handler and settles after a successful 2xx response**. On handler 4xx/5xx it cancels settlement (payment is not settled). The `exact` scheme uses the `authorization` payment flow (`settleAfterHandler: true`). No extra config is required for settle-on-success.

## Local run

```bash
npm install
PORT=3000 npm start
```

Doc-extract with local fixture (unpaid):

```bash
ALLOW_LOCAL_FIXTURES=1 PORT=3010 npm start
```

With paywall (Base Sepolia testnet):

```bash
PAY_TO_ADDRESS=0x0000000000000000000000000000000000000001 \
X402_NETWORK=eip155:84532 \
X402_PRICE='$0.001' \
X402_DOC_PRICE='$0.05' \
FACILITATOR_URL=https://x402.org/facilitator \
PORT=3011 npm start
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

### Unpaid local doc-extract (`ALLOW_LOCAL_FIXTURES=1`, no `PAY_TO_ADDRESS`)

Happy path (sample invoice fixture):

```bash
curl -sS -X POST http://127.0.0.1:3010/v1/doc-extract \
  -H 'Content-Type: application/json' \
  -d '{"url":"file://sample-invoice.pdf","schema":{"type":"object","properties":{"invoice_number":{"type":"string"},"date":{"type":"string"},"vendor":{"type":"string"},"total":{"type":"number"},"currency":{"type":"string"}},"required":["invoice_number","date","vendor","total"]}}'
```

Expected: `200` with fields like `invoice_number`, `vendor`, `total` matching the fixture.

Schema failure (require a field the PDF does not contain):

```bash
curl -sS -i -X POST http://127.0.0.1:3010/v1/doc-extract \
  -H 'Content-Type: application/json' \
  -d '{"url":"file://sample-invoice.pdf","schema":{"type":"object","properties":{"missingField":{"type":"string"}},"required":["missingField"]}}'
```

Expected: **HTTP 422** with `error: "schema_validation_failed"` and Ajv `errors`.

### 402 without payment (paywall configured)

```bash
curl -sS -i -X POST http://127.0.0.1:3011/v1/doc-extract \
  -H 'Content-Type: application/json' \
  -d '{"url":"file://sample-invoice.pdf","schema":{"type":"object","properties":{"invoice_number":{"type":"string"}},"required":["invoice_number"]}}'
```

Expected: **HTTP 402** for doc-extract. `/health` on the same port still returns `200`. `/v1/extract` remains independently priced/protected as before.

## SSRF / fetch guards

- HTTPS only (except optional `file://` fixtures under the local-fixtures flag)
- Blocks localhost, `*.local`, `*.internal`, private/link-local/metadata IPs (`169.254.169.254`, `::1`, etc.)
- Manual redirects (max 3); each hop re-checked
- Extract: ~8 s timeout, ~2 MB body cap
- Doc-extract: ~20 s timeout, ~5 MB PDF / ~20 pages

## Railway deploy

```bash
railway login
railway init   # or link an existing project
railway up
```

Set Railway variables (production **must** include `PAY_TO_ADDRESS`):

- `PAY_TO_ADDRESS` — your receiving EVM address
- `X402_NETWORK` — e.g. `eip155:84532` (Base Sepolia) or mainnet CAIP-2 id
- `X402_PRICE` — e.g. `$0.001` (extract)
- `X402_DOC_PRICE` — e.g. `$0.05` (doc-extract)
- `FACILITATOR_URL` — facilitator endpoint for that network
- `NODE_ENV=production` (optional but recommended; without `PAY_TO_ADDRESS` paid routes return 503)
- Do **not** set `ALLOW_LOCAL_FIXTURES` in production

`PORT` is provided by Railway automatically; `npm start` reads `process.env.PORT` (default 3000).

Optional `Procfile`: `web: npm start`.
