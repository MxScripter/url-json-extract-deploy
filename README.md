# url-json-extract

Day 1 unpaid URL → JSON extract service (Node/Express). Fetches a page over HTTPS, pulls dumb HTML signals (`<title>`, meta/og, JSON-LD), shapes an object to match a client-supplied JSON Schema, and validates with Ajv.

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
- `413` — upstream body over size cap (~2 MB)
- `504` — upstream timeout (~8 s)

## Local run

```bash
npm install
PORT=3000 npm start
```

## Curl examples

Health:

```bash
curl -sS http://127.0.0.1:3000/health
```

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

## SSRF / fetch guards

- HTTPS only
- Blocks localhost, `*.local`, `*.internal`, private/link-local/metadata IPs (`169.254.169.254`, `::1`, etc.)
- Manual redirects (max 3); each hop re-checked
- ~8 s timeout, ~2 MB body cap (stream abort)

## Railway deploy (do not run from this README unless you mean to)

```bash
railway login
railway init   # or link an existing project
railway up
```

Set `PORT` is provided by Railway automatically; `npm start` reads `process.env.PORT` (default 3000).

Optional `Procfile`: `web: npm start`.
