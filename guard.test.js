import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCatalog, assertAllowed, normalizePath, isSafeShape, sanitizeQuery, sanitizeBody, searchCatalog, listModules, describeEndpoint,
} from "./guard.js";

const DATA = [{ url: "https://{cloudServerCode}.accurate.id/accurate" }];
const BASE = [{ url: "https://account.accurate.id" }];
const op = (extra = {}) => ({ tags: ["/api/glaccount"], description: "Melihat daftar data Akun Perkiraan", servers: DATA, security: [{ default: ["glaccount_view"] }], ...extra });

const spec = {
  tags: [{ name: "/api/glaccount", description: "Akun Perkiraan" }, { name: "/api/sales-invoice", description: "Faktur Penjualan" }],
  paths: {
    "/api/glaccount/list.do": { get: op({ parameters: [{ name: "sp.page", in: "query", schema: { type: "integer" } }, { name: "X-Session-ID", in: "header" }] }) },
    "/api/glaccount/detail.do": { get: op({ parameters: [{ name: "id", in: "query", required: true, schema: { type: "integer" } }] }) },
    "/api/glaccount/get-pl-account-amount.do": { get: op() },
    "/api/glaccount/save.do": { post: op({ security: [{ default: ["glaccount_save"] }], requestBody: { content: { "application/json": { schema: {
      required: ["name"], properties: { name: { type: "string", description: "Nama akun" }, id: { type: "integer" },
        detail: { type: "array", items: { properties: { amount: { type: "number" } } } } } } } } } }) },
    // POST scope tulis tetapi nama operasi menghapus -> ditolak
    "/api/glaccount/void.do": { post: op({ security: [{ default: ["glaccount_save"] }] }) },
    // POST dengan campuran scope simpan + hapus -> ditolak
    "/api/glaccount/save-and-delete.do": { post: op({ security: [{ default: ["glaccount_save", "glaccount_delete"] }] }) },
    // DELETE ber-scope save (ada di spesifikasi asli) -> metode DELETE tidak pernah diizinkan
    "/api/sales-invoice/delete.do": { delete: op({ tags: ["/api/sales-invoice"], security: [{ default: ["sales_invoice_save"] }] }) },
    // POST tulis di server dasar -> ditolak
    "/api/base-save.do": { post: { tags: ["/api"], servers: BASE, security: [{ default: ["x_save"] }] } },
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

test("katalog: baca = GET *_view, tulis = POST *_save saja", () => {
  const byKind = (k) => [...catalog.values()].filter((e) => e.kind === k).map((e) => e.path).sort();
  assert.deepEqual(byKind("read"), ["glaccount/detail.do", "glaccount/get-pl-account-amount.do", "glaccount/list.do", "sales-invoice/list.do"]);
  assert.deepEqual(byKind("write"), ["glaccount/save.do"]);
  assert.equal(catalog.get("glaccount/save.do").method, "POST");
});

test("baca: endpoint tulis, scope tulis, tanpa scope, nama berbahaya, dan server dasar ditolak", () => {
  for (const p of ["glaccount/save.do", "glaccount/delete.do", "glaccount/bulk-save.do", "glaccount/sneaky-read.do",
    "glaccount/no-scope.do", "sales-invoice/approve.do", "webhook-renew.do", "db-list.do"]) {
    assert.throws(() => assertAllowed(p, catalog, "read"), /Diblokir/, p);
  }
});

test("tulis: hanya POST *_save; hapus, void, scope campuran, DELETE, server dasar, dan endpoint baca ditolak", () => {
  assert.equal(assertAllowed("/api/glaccount/save.do", catalog, "write"), "glaccount/save.do");
  for (const p of ["glaccount/delete.do", "glaccount/void.do", "glaccount/save-and-delete.do", "sales-invoice/delete.do",
    "base-save.do", "glaccount/bulk-save.do", "glaccount/list.do", "../save.do"]) {
    assert.throws(() => assertAllowed(p, catalog, "write"), /Diblokir/, p);
  }
  assert.equal(isSafeShape("vendor/save.do", "write"), true);
  assert.equal(isSafeShape("vendor/delete.do", "write"), false);
  assert.equal(isSafeShape("vendor/remove-item.do", "write"), false);
});

test("sanitizeBody: objek saja, tolak hapus baris, kunci berbahaya, terlalu besar/dalam", () => {
  assert.deepEqual(sanitizeBody({ name: "PT X", detailItem: [{ itemNo: "A", quantity: 2 }] }), { name: "PT X", detailItem: [{ itemNo: "A", quantity: 2 }] });
  assert.throws(() => sanitizeBody([1]), /objek JSON/);
  assert.throws(() => sanitizeBody("x"), /objek JSON/);
  assert.throws(() => sanitizeBody({ detailItem: [{ id: 5, _status: "delete" }] }), /penghapusan .*detailItem\[0\]\._status/);
  assert.throws(() => sanitizeBody({ detailItem: [{ id: 5, _status: "DELETE" }] }), /penghapusan/);
  assert.throws(() => sanitizeBody(JSON.parse('{"a":{"__proto__":{"x":1}}}')), /tidak diizinkan/);
  assert.throws(() => sanitizeBody({ _method: "DELETE" }), /tidak diizinkan/);
  let deep = { v: 1 }; for (let i = 0; i < 10; i++) deep = { d: deep };
  assert.throws(() => sanitizeBody(deep), /bertingkat/);
  assert.throws(() => sanitizeBody({ s: "x".repeat(300 * 1024) }), /terlalu besar/);
});

test("deskripsi endpoint tulis memuat field isi beserta field wajib", () => {
  const d = describeEndpoint(catalog.get("glaccount/save.do"));
  assert.equal(d.jenis, "tulis");
  assert.deepEqual(d.isi.map((f) => [f.nama, f.wajib]), [["name", true], ["id", false], ["detail", false]]);
  assert.deepEqual(d.isi[2].isi.map((f) => f.nama), ["amount"]);
  const s = searchCatalog(catalog, "akun", 15, "write");
  assert.deepEqual(s.hasil.map((h) => [h.path, h.jenis, h.isi_wajib]), [["glaccount/save.do", "tulis", ["name"]]]);
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
