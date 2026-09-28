"use strict";

const express = require("express");
const { z } = require("zod");
const Ajv = require("ajv");
const { paymentMiddleware, x402ResourceServer } = require("@x402/express");
const { ExactEvmScheme } = require("@x402/evm/exact/server");
const { HTTPFacilitatorClient } = require("@x402/core/server");
const {
  fetchPdfBuffer,
  extractPdfText,
  mapPdfTextToSchema,
} = require("./docExtract");

const PORT = Number(process.env.PORT) || 3000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_REDIRECTS = 3;

const PAY_TO_ADDRESS = process.env.PAY_TO_ADDRESS || "";
const X402_NETWORK = process.env.X402_NETWORK || "eip155:84532";
const X402_PRICE = process.env.X402_PRICE || "$0.001";
const X402_DOC_PRICE = process.env.X402_DOC_PRICE || "$0.05";
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402.org/facilitator";
const REQUIRE_X402 =
  process.env.REQUIRE_X402 === "1" || process.env.NODE_ENV === "production";

const BodySchema = z.object({
  url: z.string().url(),
  schema: z.record(z.unknown()),
});

const PRIVATE_HOSTS = new Set(["localhost", "metadata.google.internal"]);

function isPrivateIpv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIpv6(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // ULA
  if (h.startsWith("fe80")) return true; // link-local
  // IPv4-mapped
  const m = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (m) return isPrivateIpv4(m[1]);
  return false;
}

function assertSafeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw Object.assign(new Error("Invalid URL"), { status: 400, code: "bad_url" });
  }
  if (u.protocol !== "https:") {
    throw Object.assign(new Error("Only https URLs are allowed"), {
      status: 400,
      code: "https_only",
    });
  }
  if (u.username || u.password) {
    throw Object.assign(new Error("URLs with credentials are not allowed"), {
      status: 400,
      code: "bad_url",
    });
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    PRIVATE_HOSTS.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw Object.assign(new Error("Hostname not allowed"), {
      status: 400,
      code: "ssrf_blocked",
    });
  }
  // IP literal checks
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isPrivateIpv4(host)) {
      throw Object.assign(new Error("Private IP not allowed"), {
        status: 400,
        code: "ssrf_blocked",
      });
    }
  } else if (host.includes(":")) {
    if (isPrivateIpv6(host)) {
      throw Object.assign(new Error("Private IP not allowed"), {
        status: 400,
        code: "ssrf_blocked",
      });
    }
  }
  return u;
}

async function fetchSafe(urlString) {
  let current = assertSafeUrl(urlString);
  let redirects = 0;

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "url-json-extract/1.0",
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        throw Object.assign(new Error("Upstream request timed out"), {
          status: 504,
          code: "timeout",
        });
      }
      throw Object.assign(new Error(`Fetch failed: ${err.message}`), {
        status: 400,
        code: "fetch_failed",
      });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) {
        throw Object.assign(new Error("Redirect without Location"), {
          status: 400,
          code: "bad_redirect",
        });
      }
      redirects += 1;
      if (redirects > MAX_REDIRECTS) {
        throw Object.assign(new Error("Too many redirects"), {
          status: 400,
          code: "too_many_redirects",
        });
      }
      current = assertSafeUrl(new URL(loc, current).toString());
      continue;
    }

    if (!res.ok) {
      throw Object.assign(new Error(`Upstream returned ${res.status}`), {
        status: 400,
        code: "upstream_error",
      });
    }

    const cl = res.headers.get("content-length");
    if (cl && Number(cl) > MAX_BODY_BYTES) {
      throw Object.assign(new Error("Response body too large"), {
        status: 413,
        code: "body_too_large",
      });
    }

    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        try {
          reader.cancel();
        } catch (_) {}
        throw Object.assign(new Error("Response body too large"), {
          status: 413,
          code: "body_too_large",
        });
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return { url: current.toString(), text: buf.toString("utf8"), contentType: res.headers.get("content-type") || "" };
  }
}

function decodeEntities(s) {
  return s
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/'/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function extractMeta(html, prop) {
  // property= or name=
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["'][^>]*>|<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["'][^>]*>`,
    "i"
  );
  const m = html.match(re);
  return m ? decodeEntities(m[1] || m[2] || "").trim() : undefined;
}

function extractFacts(html, pageUrl) {
  const facts = { url: pageUrl };

  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleM) facts.title = decodeEntities(titleM[1].replace(/\s+/g, " ").trim());

  const desc =
    extractMeta(html, "description") ||
    extractMeta(html, "og:description") ||
    extractMeta(html, "twitter:description");
  if (desc) facts.description = desc;

  const ogTitle = extractMeta(html, "og:title");
  if (ogTitle) facts.ogTitle = ogTitle;
  if (!facts.title && ogTitle) facts.title = ogTitle;

  const ogUrl = extractMeta(html, "og:url");
  if (ogUrl) facts.ogUrl = ogUrl;

  const ogImage = extractMeta(html, "og:image");
  if (ogImage) facts.image = ogImage;

  const siteName = extractMeta(html, "og:site_name");
  if (siteName) facts.siteName = siteName;

  // JSON-LD: pick first object / @graph item fields we care about
  const ldBlocks = [];
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let lm;
  while ((lm = ldRe.exec(html))) {
    try {
      ldBlocks.push(JSON.parse(lm[1].trim()));
    } catch (_) {}
  }
  for (const block of ldBlocks) {
    const items = Array.isArray(block)
      ? block
      : block["@graph"]
        ? block["@graph"]
        : [block];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (!facts.title && typeof item.name === "string") facts.title = item.name;
      if (!facts.description && typeof item.description === "string") {
        facts.description = item.description;
      }
      if (!facts.image) {
        const img = item.image;
        if (typeof img === "string") facts.image = img;
        else if (img && typeof img === "object" && typeof img.url === "string") {
          facts.image = img.url;
        }
      }
    }
  }

  return facts;
}

/** Map extracted facts onto a simple JSON Schema object shape. */
function buildFromSchema(schema, facts) {
  if (!schema || schema.type !== "object" || !schema.properties) {
    // If schema isn't a plain object schema, return facts and let Ajv decide
    return { ...facts };
  }
  const out = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const t = prop && prop.type;
    if (key in facts) {
      const v = facts[key];
      if (t === "string" || t === undefined) {
        if (typeof v === "string") out[key] = v;
      } else if (t === "number" || t === "integer") {
        const n = Number(v);
        if (!Number.isNaN(n)) out[key] = t === "integer" ? Math.trunc(n) : n;
      } else if (t === "boolean") {
        out[key] = Boolean(v);
      } else {
        out[key] = v;
      }
      continue;
    }
    // common aliases
    if (key === "name" && facts.title) out[key] = facts.title;
    else if (key === "headline" && facts.title) out[key] = facts.title;
    else if (key === "desc" && facts.description) out[key] = facts.description;
    else if (key === "summary" && facts.description) out[key] = facts.description;
    else if (key === "pageUrl" && facts.url) out[key] = facts.url;
    else if (key === "canonical" && (facts.ogUrl || facts.url)) {
      out[key] = facts.ogUrl || facts.url;
    }
  }
  return out;
}

const app = express();
app.disable("x-powered-by");
// Railway (and most hosts) terminate TLS upstream; without this, x402
// resource.url is built as http:// and can break settlement matching.
app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

// --- x402 paywall (POST /v1/extract + /v1/doc-extract; /health stays free) ---
if (PAY_TO_ADDRESS) {
  const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    X402_NETWORK,
    new ExactEvmScheme()
  );
  app.use(
    paymentMiddleware(
      {
        "POST /v1/extract": {
          accepts: {
            scheme: "exact",
            price: X402_PRICE,
            network: X402_NETWORK,
            payTo: PAY_TO_ADDRESS,
          },
          description: "Extract JSON fields from a URL against a schema",
          mimeType: "application/json",
        },
        "POST /v1/doc-extract": {
          accepts: {
            scheme: "exact",
            price: X402_DOC_PRICE,
            network: X402_NETWORK,
            payTo: PAY_TO_ADDRESS,
          },
          description: "Extract JSON fields from a PDF URL against a schema",
          mimeType: "application/json",
        },
      },
      resourceServer
    )
  );
  console.log(
    `x402 paywall ON for POST /v1/extract (${X402_PRICE}) and POST /v1/doc-extract (${X402_DOC_PRICE}) on ${X402_NETWORK} → ${PAY_TO_ADDRESS}`
  );
} else if (REQUIRE_X402) {
  const refusePaywall = (req, res, next) => {
    if (req.method !== "POST") return next();
    return res.status(503).json({
      error: "paywall_not_configured",
      message:
        "PAY_TO_ADDRESS is required when NODE_ENV=production or REQUIRE_X402=1",
    });
  };
  app.use("/v1/extract", refusePaywall);
  app.use("/v1/doc-extract", refusePaywall);
  console.error(
    "FATAL config: PAY_TO_ADDRESS missing but REQUIRE_X402/production is set — POST /v1/extract and /v1/doc-extract return 503"
  );
} else {
  console.warn(
    "WARNING: PAY_TO_ADDRESS not set — POST /v1/extract and /v1/doc-extract are UNPROTECTED. Set PAY_TO_ADDRESS for production (or REQUIRE_X402=1)."
  );
}

app.post("/v1/extract", async (req, res) => {
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_request",
      issues: parsed.error.issues,
    });
  }

  const { url, schema } = parsed.data;

  let page;
  try {
    assertSafeUrl(url);
    page = await fetchSafe(url);
  } catch (err) {
    const status = err.status || 400;
    return res.status(status).json({
      error: err.code || "fetch_error",
      message: err.message,
    });
  }

  const facts = extractFacts(page.text, page.url);
  const data = buildFromSchema(schema, facts);

  const ajv = new Ajv({ allErrors: true, strict: false });
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    return res.status(400).json({
      error: "invalid_schema",
      message: err.message,
    });
  }

  const ok = validate(data);
  if (!ok) {
    return res.status(400).json({
      error: "schema_validation_failed",
      errors: validate.errors,
    });
  }

  // Success body IS the data matching schema (no wrapper)
  return res.status(200).json(data);
});


app.post("/v1/doc-extract", async (req, res) => {
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_request",
      issues: parsed.error.issues,
    });
  }

  const { url, schema } = parsed.data;

  // Compile schema early so invalid schemas are 400 (not 422)
  const ajv = new Ajv({ allErrors: true, strict: false });
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    return res.status(400).json({
      error: "invalid_schema",
      message: err.message,
    });
  }

  let buf;
  try {
    buf = await fetchPdfBuffer(url, assertSafeUrl);
  } catch (err) {
    const status = err.status || 400;
    return res.status(status).json({
      error: err.code || "fetch_error",
      message: err.message,
    });
  }

  let extracted;
  try {
    extracted = await extractPdfText(buf);
  } catch (err) {
    const status = err.status || 400;
    return res.status(status).json({
      error: err.code || "pdf_extract_failed",
      message: err.message,
    });
  }

  const data = mapPdfTextToSchema(schema, extracted.text);
  const ok = validate(data);
  if (!ok) {
    // mazbot: doc-extract schema fails use 422 (extract stays 400)
    return res.status(422).json({
      error: "schema_validation_failed",
      errors: validate.errors,
    });
  }

  return res.status(200).json(data);
});

app.use((err, _req, res, _next) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "body_too_large", message: "Request body too large" });
  }
  console.error(err);
  res.status(500).json({ error: "internal", message: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`url-json-extract listening on :${PORT}`);
});
