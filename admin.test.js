import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTenantRegistry } from "./tenants.js";
import { createAudit } from "./audit.js";
import { createAdminApp } from "./admin.js";

const PASSWORD = "password-admin-uji-123";

async function start({ now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-admin-"));
  const file = path.join(dir, "tenants.json");
  fs.writeFileSync(file, JSON.stringify({ tenants: [{ id: "pt-a", name: "PT A", token: "aat.TOKEN-RAHASIA-A1", secret: "SECRET-RAHASIA-A2" }] }));
  const registry = createTenantRegistry({
    file, log: () => {},
    createClient: (t) => ({ getHost: async () => ({ alias: `DB ${t.name}`, databaseId: 9, host: "https://x.accurate.id", user: "u" }) }),
  });
  const audit = createAudit(path.join(dir, "audit.log"));
  const app = createAdminApp({ registry, audit, password: PASSWORD, ...(now ? { now } : {}) });
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  let cookie = "";
  let csrf = "";
  const req = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text, headers: res.headers };
  };
  const login = async () => { const r = await req("POST", "/admin/api/login", { password: PASSWORD }); csrf = r.json.csrf; return r; };
  const authed = (method, url, body, extra = {}) => req(method, url, body, { "x-csrf-token": csrf, ...extra });
  return { req, login, authed, file, dir, audit, done: () => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("password lemah/kosong ditolak saat start", () => {
  assert.throws(() => createAdminApp({ registry: {}, audit: {}, password: "" }), /minimal 12/);
  assert.throws(() => createAdminApp({ registry: {}, audit: {}, password: "pendek" }), /minimal 12/);
});

test("tanpa login semua API ditolak; halaman bisa dibuka dengan header keamanan", async () => {
  const s = await start();
  try {
    assert.equal((await s.req("GET", "/admin/api/tenants")).status, 401);
    assert.equal((await s.req("POST", "/admin/api/tenants", { id: "x" })).status, 401);
    assert.equal((await s.req("GET", "/admin/api/audit")).status, 401);
    const page = await s.req("GET", "/admin");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal((await s.req("GET", "/admin/app.js")).status, 200);
  } finally { s.done(); }
});

test("login salah 5x mengunci IP; password benar membuka sesi dengan cookie HttpOnly", async () => {
  let t = 1_000_000;
  const s = await start({ now: () => t });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await s.req("POST", "/admin/api/login", { password: "salah" })).status, 401);
    const locked = await s.req("POST", "/admin/api/login", { password: PASSWORD });
    assert.equal(locked.status, 429, "password benar pun ditolak selama terkunci");
    t += 16 * 60 * 1000;
    const ok = await s.login();
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    assert.equal((await s.req("GET", "/admin/api/session")).json.loggedIn, true);
    t += 9 * 60 * 60 * 1000;
    assert.equal((await s.req("GET", "/admin/api/tenants")).status, 401, "sesi habis setelah 8 jam tidak aktif");
  } finally { s.done(); }
});

test("perubahan wajib CSRF dan Origin yang sama; token tidak pernah dikirim ke browser", async () => {
  const s = await start();
  try {
    await s.login();
    const list = await s.req("GET", "/admin/api/tenants");
    assert.equal(list.status, 200);
    assert.ok(!list.text.includes("TOKEN-RAHASIA") && !list.text.includes("SECRET-RAHASIA"), "token/secret tidak boleh terkirim");
    assert.equal(list.json.tenants[0].token, "••••A-A1");

    const body = { id: "pt-b", name: "PT B", token: "aat.TOKEN-B-123", secret: "SECRET-B-456" };
    assert.equal((await s.req("POST", "/admin/api/tenants", body)).status, 403, "tanpa CSRF ditolak");
    assert.equal((await s.req("POST", "/admin/api/tenants", body, { "x-csrf-token": "palsu" })).status, 403);
    assert.equal((await s.authed("POST", "/admin/api/tenants", body, { origin: "http://evil.example" })).status, 403, "origin asing ditolak");
    const created = await s.authed("POST", "/admin/api/tenants", body);
    assert.equal(created.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(s.file, "utf8")).tenants.length, 2);
  } finally { s.done(); }
});

test("ubah izin tulis, uji koneksi, hapus, dan semua tercatat di audit tanpa token", async () => {
  const s = await start();
  try {
    await s.login();
    assert.equal((await s.authed("PUT", "/admin/api/tenants/pt-a", { id: "pt-a", name: "PT A", allowWrite: true })).status, 200);
    const stored = JSON.parse(fs.readFileSync(s.file, "utf8")).tenants[0];
    assert.equal(stored.allowWrite, true);
    assert.equal(stored.token, "aat.TOKEN-RAHASIA-A1", "token kosong saat ubah = token lama dipertahankan");

    const test = await s.authed("POST", "/admin/api/tenants/pt-a/test");
    assert.deepEqual([test.status, test.json.database], [200, "DB PT A"]);

    assert.equal((await s.authed("POST", "/admin/api/tenants", { id: "bad id!", name: "x", token: "t", secret: "s" })).status, 400);
    assert.equal((await s.authed("DELETE", "/admin/api/tenants/pt-a")).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(s.file, "utf8")).tenants.length, 0);

    const audit = await s.req("GET", "/admin/api/audit");
    assert.deepEqual(audit.json.entries.map((e) => e.aksi), ["hapus_tenant", "ubah_tenant", "login"]);
    assert.ok(!audit.text.includes("RAHASIA"));
  } finally { s.done(); }
});
