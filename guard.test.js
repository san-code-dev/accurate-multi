import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCatalog, assertAllowed, normalizePath, isSafeShape, sanitizeQuery, searchCatalog, listModules, describeEndpoint,
} from "./readonly-guard.js";

const DATA = [{ url: "https://{cloudServerCode}.accurate.id/accurate" }];
const BASE = [{ url: "https://account.accurate.id" }];
const op = (extra = {}) => ({ tags: ["/api/glaccount"], description: "Melihat daftar data Akun Perkiraan", servers: DATA, security: [{ default: ["glaccount_view"] }], ...extra });

const spec = {
  tags: [{ name: "/api/glaccount", description: "Akun Perkiraan" }, { name: "/api/sales-invoice", description: "Faktur Penjualan" }],
  paths: {
    "/api/glaccount/list.do": { get: op({ parameters: [{ name: "sp.page", in: "query", schema: { type: "integer" } }, { name: "X-Session-ID", in: "header" }] }) },
    "/api/glaccount/detail.do": { get: op({ parameters: [{ name: "id", in: "query", required: true, schema: { type: "integer" } }] }) },
    "/api/glaccount/get-pl-account-amount.do": { get: op() },
    "/api/glaccount/save.do": { post: op({ security: [{ default: ["glaccount_save"] }] }) },
    "/api/glaccount/delete.do": { delete: op({ security: [{ default: ["glaccount_delete"] }] }) },
    "/api/glaccount/bulk-save.do": { post: op() },
    // GET tetapi butuh scope tulis -> harus ditolak
    "/api/glaccount/sneaky-read.do": { get: op({ security: [{ default: ["glaccount_save"] }] }) },
    // GET tanpa info scope -> ditolak (fail closed)
    "/api/glaccount/no-scope.do": { get: op({ security: undefined }) },
    // GET dengan nama operasi berbahaya -> ditolak
    "/api/sales-invoice/approve.do": { get: op({ tags: ["/api/sales-invoice"], security: [{ default: ["sales_invoice_view"] }] }) },
    // GET di server dasar (bukan data usaha) -> ditolak
    "/api/webhook-renew.do": { get: { tags: ["/api"], servers: BASE, description: "Memperpanjang webhook" } },
    "/api/db-list.do": { get: { tags: ["/api"], servers: BASE, description: "Daftar data usaha" } },
    "/api/sales-invoice/list.do": { get: op({ tags: ["/api/sales-invoice"], description: "Melihat daftar Faktur Penjualan", security: [{ default: ["sales_invoice_view"] }] }) },
  },
};
const catalog = buildCatalog(spec);

test("katalog hanya berisi endpoint baca yang sah", () => {
  assert.deepEqual([...catalog.keys()].sort(), [
    "glaccount/detail.do", "glaccount/get-pl-account-amount.do", "glaccount/list.do", "sales-invoice/list.do",
  ]);
});

test("endpoint tulis, scope tulis, tanpa scope, nama berbahaya, dan server dasar ditolak", () => {
  for (const p of ["glaccount/save.do", "glaccount/delete.do", "glaccount/bulk-save.do", "glaccount/sneaky-read.do",
    "glaccount/no-scope.do", "sales-invoice/approve.do", "webhook-renew.do", "db-list.do"]) {
    assert.throws(() => assertAllowed(p, catalog), /Diblokir/, p);
  }
});

test("normalisasi path: /api/, api/, atau tanpa awalan", () => {
  for (const p of ["/api/glaccount/list.do", "api/glaccount/list.do", "glaccount/list.do", " /glaccount/list.do "]) {
    assert.equal(assertAllowed(p, catalog), "glaccount/list.do");
  }
});

test("upaya menyelundupkan path/URL ditolak", () => {
  for (const p of ["../glaccount/list.do", "glaccount/../glaccount/list.do", "https://evil.com/a.do", "//evil.com/list.do",
    "glaccount/list.do?x=1", "glaccount/list.do#x", "glaccount//list.do", "GLACCOUNT/list.do", "glaccount/list.do%00",
    "glaccount/list", "glaccount/list.do/", "", "   ", "glaccount\\list.do"]) {
    assert.throws(() => assertAllowed(p, catalog), /Diblokir/, JSON.stringify(p));
  }
});

test("bentuk path: kata operasi tulis terdeteksi di nama operasi, bukan di nama modul", () => {
  assert.equal(isSafeShape("bank-transfer/list.do"), true); // modul 'transfer' bukan operasi
  assert.equal(isSafeShape("item-transfer/detail.do"), true);
  assert.equal(isSafeShape("glaccount/get-pl-account-amount.do"), true);
  assert.equal(isSafeShape("report/stock-mutation-summary.do"), true);
  for (const p of ["x/save.do", "x/bulk-save.do", "x/delete.do", "x/update-status.do", "x/approve.do", "x/cancel.do", "x/void.do"]) {
    assert.equal(isSafeShape(p), false, p);
  }
});

test("sanitizeQuery menolak kunci/nilai berbahaya", () => {
  assert.deepEqual(sanitizeQuery({ "sp.page": 1, "filter.keywords.val[0]": "abc", fields: "id,number", ok: true }),
    { "sp.page": "1", "filter.keywords.val[0]": "abc", fields: "id,number", ok: "true" });
  assert.throws(() => sanitizeQuery({ "a b": 1 }));
  assert.throws(() => sanitizeQuery({ "a&b=c": 1 }));
  assert.throws(() => sanitizeQuery({ a: { x: 1 } }));
  assert.throws(() => sanitizeQuery({ a: "x\ny" }));
  assert.throws(() => sanitizeQuery(Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`k${i}`, 1]))));
  for (const k of ["_method", "method", "X-HTTP-Method-Override", "x-method-override"]) {
    assert.throws(() => sanitizeQuery({ [k]: "DELETE" }), /Diblokir/);
  }
});

test("pencarian, daftar modul, dan detail parameter", () => {
  const r = searchCatalog(catalog, "faktur penjualan");
  assert.equal(r.hasil[0].path, "sales-invoice/list.do");
  assert.equal(searchCatalog(catalog, "tidak-ada-sama-sekali").jumlah_ditemukan, 0);
  assert.deepEqual(listModules(catalog).map((m) => m.modul), ["glaccount", "sales-invoice"]);
  const d = describeEndpoint(catalog.get("glaccount/detail.do"));
  assert.equal(d.parameter[0].nama, "id");
  assert.equal(d.parameter[0].wajib, true);
  // parameter header (X-Session-ID) tidak ikut
  assert.equal(describeEndpoint(catalog.get("glaccount/list.do")).parameter.some((p) => p.nama === "X-Session-ID"), false);
});
