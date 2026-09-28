"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { PDFParse } = require("pdf-parse");

const DOC_FETCH_TIMEOUT_MS = 20_000;
const MAX_PDF_BYTES = 5 * 1024 * 1024; // ~5 MB
const MAX_PDF_PAGES = 20;
const MAX_REDIRECTS = 3;
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

function localFixturesAllowed() {
  return (
    process.env.ALLOW_LOCAL_FIXTURES === "1" &&
    process.env.NODE_ENV !== "production"
  );
}

/**
 * Resolve file://sample-invoice.pdf (or file://fixtures/…) under fixtures/
 * ONLY when ALLOW_LOCAL_FIXTURES=1 and not production.
 */
function readLocalFixture(urlString) {
  if (!localFixturesAllowed()) {
    throw Object.assign(
      new Error("Local fixtures disabled (set ALLOW_LOCAL_FIXTURES=1 for non-production local tests)"),
      { status: 400, code: "local_fixtures_disabled" }
    );
  }
  let u;
  try {
    u = new URL(urlString);
  } catch {
    throw Object.assign(new Error("Invalid file URL"), { status: 400, code: "bad_url" });
  }
  if (u.protocol !== "file:") {
    throw Object.assign(new Error("Not a file URL"), { status: 400, code: "bad_url" });
  }
  // file://sample-invoice.pdf → hostname is the filename, pathname="/"
  // file:///sample-invoice.pdf → pathname="/sample-invoice.pdf"
  // file://fixtures/sample-invoice.pdf → hostname="fixtures", pathname="/sample-invoice.pdf"
  let name = "";
  if (u.hostname && u.hostname !== "." && u.pathname && u.pathname !== "/") {
    name = u.hostname + u.pathname;
  } else if (u.hostname && u.hostname !== "." && (!u.pathname || u.pathname === "/")) {
    name = u.hostname;
  } else {
    name = u.pathname || "";
  }
  name = decodeURIComponent(name).replace(/^\/+/, "");
  if (name.startsWith("fixtures/")) name = name.slice("fixtures/".length);
  // basename only — no path traversal
  const base = path.basename(name);
  if (!base || base.includes("..") || base !== name.split("/").pop()) {
    throw Object.assign(new Error("Invalid fixture path"), { status: 400, code: "bad_url" });
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw Object.assign(new Error("Invalid fixture path"), { status: 400, code: "bad_url" });
  }
  const full = path.join(FIXTURES_DIR, base);
  if (!full.startsWith(FIXTURES_DIR + path.sep) && full !== FIXTURES_DIR) {
    throw Object.assign(new Error("Invalid fixture path"), { status: 400, code: "bad_url" });
  }
  if (!fs.existsSync(full)) {
    throw Object.assign(new Error(`Fixture not found: ${base}`), {
      status: 400,
      code: "fixture_not_found",
    });
  }
  const buf = fs.readFileSync(full);
  if (buf.length > MAX_PDF_BYTES) {
    throw Object.assign(new Error("PDF too large"), { status: 413, code: "body_too_large" });
  }
  return buf;
}

async function fetchPdfBuffer(urlString, assertSafeUrl) {
  if (urlString.startsWith("file://")) {
    return readLocalFixture(urlString);
  }

  let current = assertSafeUrl(urlString);
  let redirects = 0;

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOC_FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "url-json-extract/1.0",
          Accept: "application/pdf,*/*;q=0.8",
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
    if (cl && Number(cl) > MAX_PDF_BYTES) {
      throw Object.assign(new Error("PDF too large"), {
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
      if (size > MAX_PDF_BYTES) {
        try {
          reader.cancel();
        } catch (_) {}
        throw Object.assign(new Error("PDF too large"), {
          status: 413,
          code: "body_too_large",
        });
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }
}

function assertLooksLikePdf(buf) {
  const head = buf.slice(0, 5).toString("utf8");
  if (head !== "%PDF-") {
    throw Object.assign(new Error("URL did not return a PDF"), {
      status: 400,
      code: "not_pdf",
    });
  }
}

async function extractTextWithPdfParse(buf) {
  const parser = new PDFParse({ data: buf });
  try {
    const info = await parser.getInfo().catch(() => null);
    const pages = (info && info.total) || 0;
    if (pages > MAX_PDF_PAGES) {
      throw Object.assign(new Error(`PDF has too many pages (${pages} > ${MAX_PDF_PAGES})`), {
        status: 413,
        code: "too_many_pages",
      });
    }
    const result = await parser.getText();
    const total = result.total || pages || (result.pages && result.pages.length) || 0;
    if (total > MAX_PDF_PAGES) {
      throw Object.assign(new Error(`PDF has too many pages (${total} > ${MAX_PDF_PAGES})`), {
        status: 413,
        code: "too_many_pages",
      });
    }
    // Strip the "-- N of M --" footers pdf-parse adds
    let text = result.text || "";
    text = text.replace(/\n-- \d+ of \d+ --\n/g, "\n").trim();
    return { text, pages: total || 1 };
  } finally {
    try {
      await parser.destroy();
    } catch (_) {}
  }
}

function extractTextWithPdftotext(buf) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/pdftotext", ["-layout", "-f", "1", "-l", String(MAX_PDF_PAGES), "-", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        Object.assign(new Error("pdftotext timed out"), { status: 504, code: "timeout" })
      );
    }, DOC_FETCH_TIMEOUT_MS);

    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        Object.assign(new Error(`pdftotext failed: ${e.message}`), {
          status: 400,
          code: "pdf_extract_failed",
        })
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          Object.assign(
            new Error(`pdftotext exited ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 200)}`),
            { status: 400, code: "pdf_extract_failed" }
          )
        );
        return;
      }
      resolve({ text: Buffer.concat(out).toString("utf8").trim(), pages: null });
    });
    child.stdin.write(buf);
    child.stdin.end();
  });
}

async function extractPdfText(buf) {
  assertLooksLikePdf(buf);
  try {
    return await extractTextWithPdfParse(buf);
  } catch (err) {
    if (err.status === 413 || err.status === 504) throw err;
    // fall back to poppler
    try {
      return await extractTextWithPdftotext(buf);
    } catch (err2) {
      if (err2.status) throw err2;
      throw Object.assign(new Error(`PDF text extract failed: ${err.message}`), {
        status: 400,
        code: "pdf_extract_failed",
      });
    }
  }
}

function parseLabeledLines(text) {
  const labels = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9 /_-]{0,60}?)\s*[:：]\s*(.+)$/);
    if (m) {
      const key = m[1].trim().toLowerCase().replace(/\s+/g, "_");
      labels[key] = m[2].trim();
    }
  }
  return labels;
}

function parseMoney(s) {
  if (s == null) return undefined;
  const m = String(s).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!m) return undefined;
  return Number(m[0]);
}

function parseLineItems(text) {
  const items = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // "1. Widget A  qty 2  @ 25.00  = 50.00"
    let m = line.match(
      /^\d+[.)]\s+(.+?)\s+qty\s+(\d+(?:\.\d+)?)\s+@\s+([\d,.]+)\s*=\s*([\d,.]+)/i
    );
    if (m) {
      items.push({
        description: m[1].trim(),
        quantity: Number(m[2]),
        unit_price: parseMoney(m[3]),
        amount: parseMoney(m[4]),
      });
      continue;
    }
    // looser: "Widget A ... 50.00" at end
    m = line.match(/^\d+[.)]\s+(.+?)\s+([\d,.]+)\s*$/);
    if (m) {
      items.push({
        description: m[1].trim(),
        amount: parseMoney(m[2]),
      });
    }
  }
  return items;
}

function firstLabel(labels, keys) {
  for (const k of keys) {
    if (labels[k] != null && labels[k] !== "") return labels[k];
  }
  return undefined;
}

/** Heuristic map of PDF text → schema-shaped object (invoice-ish + generic labels). */
function mapPdfTextToSchema(schema, text) {
  const labels = parseLabeledLines(text);
  const lineItems = parseLineItems(text);

  const facts = {
    invoice_number: firstLabel(labels, [
      "invoice_number",
      "invoice_no",
      "invoice_#",
      "invoice",
      "inv_number",
      "inv_no",
    ]),
    order_number: firstLabel(labels, [
      "order_number",
      "order_no",
      "order_#",
      "order",
      "po_number",
      "po",
    ]),
    date: firstLabel(labels, ["date", "invoice_date", "order_date", "receipt_date"]),
    vendor: firstLabel(labels, ["vendor", "seller", "from", "supplier", "company"]),
    merchant: firstLabel(labels, ["merchant", "store", "vendor", "seller"]),
    customer: firstLabel(labels, ["bill_to", "customer", "sold_to", "ship_to", "buyer"]),
    total: parseMoney(firstLabel(labels, ["total", "amount_due", "grand_total", "balance_due"])),
    subtotal: parseMoney(firstLabel(labels, ["subtotal", "sub_total"])),
    tax: parseMoney(firstLabel(labels, ["tax", "vat", "sales_tax"])),
    currency: firstLabel(labels, ["currency", "curr"]),
    payment_method: firstLabel(labels, ["payment_method", "payment", "paid_with", "card"]),
    line_items: lineItems,
    items: lineItems,
  };

  // Fallbacks: invoice_number ↔ order_number, vendor ↔ merchant
  if (!facts.order_number && facts.invoice_number) facts.order_number = facts.invoice_number;
  if (!facts.invoice_number && facts.order_number) facts.invoice_number = facts.order_number;
  if (!facts.merchant && facts.vendor) facts.merchant = facts.vendor;
  if (!facts.vendor && facts.merchant) facts.vendor = facts.merchant;

  // Also expose every labeled key as a fact for generic string fields
  for (const [k, v] of Object.entries(labels)) {
    if (!(k in facts)) facts[k] = v;
  }

  if (!schema || schema.type !== "object" || !schema.properties) {
    return { ...facts };
  }

  const out = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const t = prop && prop.type;
    let v = facts[key];

    // soft aliases
    if (v === undefined) {
      if (key === "merchant" && facts.vendor) v = facts.vendor;
      else if (key === "vendor" && facts.merchant) v = facts.merchant;
      else if (key === "order_number" && facts.invoice_number) v = facts.invoice_number;
      else if (key === "invoice_number" && facts.order_number) v = facts.order_number;
      else if ((key === "items" || key === "line_items") && facts.line_items) {
        v = facts.line_items;
      } else if (key === "amount" && facts.total != null) v = facts.total;
      else if (labels[key] != null) v = labels[key];
    }

    if (v === undefined) continue;

    if (t === "string" || t === undefined) {
      if (typeof v === "string") out[key] = v;
      else if (typeof v === "number") out[key] = String(v);
    } else if (t === "number" || t === "integer") {
      const n = typeof v === "number" ? v : parseMoney(v);
      if (n != null && !Number.isNaN(n)) out[key] = t === "integer" ? Math.trunc(n) : n;
    } else if (t === "boolean") {
      out[key] = Boolean(v);
    } else if (t === "array") {
      if (Array.isArray(v)) {
        const itemSchema = prop.items;
        if (itemSchema && itemSchema.type === "object" && itemSchema.properties) {
          out[key] = v.map((item) => {
            const row = {};
            for (const ik of Object.keys(itemSchema.properties)) {
              if (item[ik] !== undefined) row[ik] = item[ik];
            }
            return row;
          });
        } else {
          out[key] = v;
        }
      }
    } else if (t === "object" && v && typeof v === "object") {
      out[key] = v;
    } else {
      out[key] = v;
    }
  }
  return out;
}

module.exports = {
  DOC_FETCH_TIMEOUT_MS,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  fetchPdfBuffer,
  extractPdfText,
  mapPdfTextToSchema,
  localFixturesAllowed,
};
