import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTenants, createTenantRegistry } from "./tenants.js";

const T = (id, extra = {}) => ({ id, name: `PT ${id}`, token: `tok-${id}`, secret: `sec-${id}`, ...extra });

test("parseTenants: validasi id, ganda, kredensial kosong, encoding", () => {
  assert.equal(parseTenants({ tenants: [T("pt-a")] })[0].sigEncoding, "base64");
  assert.equal(parseTenants([T("pt-a")]).length, 1, "array langsung juga diterima");
  assert.throws(() => parseTenants({ tenants: [T("PT A")] }), /id 'PT A' tidak valid/);
  assert.throws(() => parseTenants({ tenants: [T("a"), T("a")] }), /ganda/);
  assert.throws(() => parseTenants({ tenants: [T("a", { token: "" })] }), /token kosong/);
  assert.throws(() => parseTenants({ tenants: [T("a", { secret: " " })] }), /secret kosong/);
  assert.throws(() => parseTenants({ tenants: [T("a", { sigEncoding: "utf8" })] }), /sigEncoding/);
  assert.throws(() => parseTenants({ x: 1 }), /Format tidak dikenali/);
});

function setup(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-tenants-"));
  const file = path.join(dir, "tenants.json");
  if (content !== undefined) fs.writeFileSync(file, JSON.stringify(content));
  const made = [];
  const reg = createTenantRegistry({ file, createClient: (t) => { made.push(t.id); return { id: t.id, token: t.token }; }, log: () => {} });
  // Paksa waktu ubah berbeda agar perubahan file selalu terdeteksi meski ditulis dalam milidetik yang sama.
  let tick = Date.now() / 1000;
  const write = (c) => { fs.writeFileSync(file, typeof c === "string" ? c : JSON.stringify(c)); tick += 5; fs.utimesSync(file, tick, tick); };
  return { dir, file, reg, made, write, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("list tidak pernah memuat token/secret; tenant nonaktif disembunyikan", () => {
  const s = setup({ tenants: [T("pt-a", { description: "Pusat" }), T("pt-b", { enabled: false })] });
  try {
    const list = s.reg.list();
    assert.deepEqual(list, [{ id: "pt-a", name: "PT pt-a", description: "Pusat", boleh_tulis: false }]);
    assert.ok(!JSON.stringify(list).includes("tok-") && !JSON.stringify(list).includes("sec-"));
    assert.throws(() => s.reg.resolve("pt-b"), /tidak ditemukan atau nonaktif/);
  } finally { s.done(); }
});

test("resolve: tenant wajib bila >1, opsional bila 1; klien dipakai ulang", () => {
  const s = setup({ tenants: [T("pt-a"), T("pt-b")] });
  try {
    assert.throws(() => s.reg.resolve(), /wajib diisi karena ada 2 tenant/);
    assert.equal(s.reg.resolve("PT-A ").tenant.id, "pt-a", "id tidak peka huruf besar dan spasi");
    s.reg.resolve("pt-a"); s.reg.resolve("pt-b"); s.reg.resolve("pt-a");
    assert.deepEqual(s.made, ["pt-a", "pt-b"], "satu klien per tenant");
    s.write({ tenants: [T("pt-a")] });
    assert.equal(s.reg.resolve().tenant.id, "pt-a", "satu tenant: parameter boleh kosong");
  } finally { s.done(); }
});

test("muat ulang otomatis: tenant baru, kredensial berubah, file rusak tetap pakai konfigurasi lama", () => {
  const s = setup({ tenants: [T("pt-a")] });
  try {
    assert.equal(s.reg.list().length, 1);
    s.write({ tenants: [T("pt-a"), T("pt-c")] });
    assert.deepEqual(s.reg.list().map((t) => t.id), ["pt-a", "pt-c"], "tenant baru terbaca tanpa restart");

    s.reg.resolve("pt-a");
    s.write({ tenants: [T("pt-a", { token: "tok-baru" }), T("pt-c")] });
    assert.equal(s.reg.resolve("pt-a").client.token, "tok-baru", "klien dibuat ulang saat token berubah");

    s.write("{ ini bukan json");
    assert.deepEqual(s.reg.list().map((t) => t.id), ["pt-a", "pt-c"], "file rusak: konfigurasi lama tetap jalan");
    assert.match(s.reg.status().error, /tidak valid, konfigurasi sebelumnya tetap dipakai/);

    s.write({ tenants: [T("pt-c")] });
    assert.equal(s.reg.status().error, null);
    assert.throws(() => s.reg.resolve("pt-a"), /tidak ditemukan/, "tenant yang dihapus tidak bisa dipakai lagi");
  } finally { s.done(); }
});

test("file tidak ada: pesan jelas", () => {
  const s = setup();
  try {
    assert.equal(s.reg.list().length, 0);
    assert.throws(() => s.reg.resolve("x"), /File tenant tidak ditemukan/);
  } finally { s.done(); }
});

test("admin: tambah, ubah (token kosong = tetap), ganti id, hapus; file ditulis atomik dan disamarkan di daftar", () => {
  const s = setup({ tenants: [T("pt-a")] });
  try {
    assert.throws(() => s.reg.save({ id: "pt-b", name: "B", token: "", secret: "x" }), /token kosong/);
    assert.equal(s.reg.save({ id: "pt-b", name: "PT B", token: "tok-b-123456", secret: "sec-b-abcdef", allowWrite: true }), "pt-b");
    assert.throws(() => s.reg.save({ id: "pt-a", name: "dup", token: "x", secret: "y" }), /sudah dipakai/);
    const b = s.reg.adminList().find((t) => t.id === "pt-b");
    assert.deepEqual([b.token, b.secret, b.allowWrite], ["••••3456", "••••cdef", true]);
    assert.ok(!JSON.stringify(s.reg.adminList()).includes("tok-b-123456"));

    s.reg.save({ id: "pt-b", name: "PT B Baru", token: "", secret: "", allowWrite: false }, "pt-b");
    const raw = JSON.parse(fs.readFileSync(s.file, "utf8")).tenants.find((t) => t.id === "pt-b");
    assert.deepEqual([raw.name, raw.token, raw.secret, raw.allowWrite], ["PT B Baru", "tok-b-123456", "sec-b-abcdef", false]);

    s.reg.save({ id: "pt-b2", name: "PT B2" }, "pt-b");
    assert.deepEqual(s.reg.adminList().map((t) => t.id), ["pt-a", "pt-b2"], "ganti id mempertahankan kredensial");
    assert.equal(s.reg.resolve("pt-b2").tenant.token, "tok-b-123456");

    s.reg.remove("pt-b2");
    assert.deepEqual(s.reg.adminList().map((t) => t.id), ["pt-a"]);
    assert.throws(() => s.reg.remove("pt-b2"), /tidak ditemukan/);
    assert.deepEqual(fs.readdirSync(s.dir).filter((f) => f.endsWith(".tmp")), [], "tidak ada file sementara tertinggal");
  } finally { s.done(); }
});

test("izin tulis berubah -> klien dibuat ulang dengan allowWrite baru", () => {
  const s = setup({ tenants: [T("pt-a")] });
  try {
    s.reg.resolve("pt-a");
    s.reg.save({ id: "pt-a", name: "PT A", allowWrite: true }, "pt-a");
    s.reg.resolve("pt-a");
    assert.deepEqual(s.made, ["pt-a", "pt-a"]);
  } finally { s.done(); }
});
