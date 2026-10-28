// Halaman admin untuk mengelola tenant. Berjalan di port terpisah (default 3032) yang secara bawaan hanya
// terbuka untuk komputer server (127.0.0.1). Pengamanan:
//  - login dengan ADMIN_PASSWORD (min. 12 karakter), dibandingkan dengan waktu konstan,
//  - kunci 15 menit per IP setelah 5 kali salah,
//  - sesi di memori (cookie HttpOnly, SameSite=Strict), habis setelah 8 jam tidak aktif,
//  - setiap perubahan wajib membawa header X-CSRF-Token milik sesi, dan Origin (bila ada) harus sama dengan Host,
//  - token/secret tidak pernah dikirim balik ke browser (hanya 4 karakter terakhir).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
export const MIN_PASSWORD = 12;

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const rand = () => crypto.randomBytes(32).toString("base64url");

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * registry: dari tenants.js; audit: dari audit.js; password: ADMIN_PASSWORD.
 * testConnection(client): mengembalikan info host Accurate (dipisah agar mudah diuji).
 */
export function createAdminApp({ registry, audit, password, now = () => Date.now() }) {
  if (!password || password.length < MIN_PASSWORD) {
    throw new Error(`ADMIN_PASSWORD wajib diisi, minimal ${MIN_PASSWORD} karakter.`);
  }
  const expected = sha(password);
  const sessions = new Map(); // sid -> { csrf, seen }
  const fails = new Map(); // ip -> { n, until }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(express.json({ limit: "64kb" }));
  app.use((_req, res, next) => {
    res.set({
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
    next();
  });

  const ipOf = (req) => req.socket.remoteAddress ?? "?";

  function session(req) {
    const sid = parseCookies(req.get("cookie")).acc_admin;
    const s = sid && sessions.get(sid);
    if (!s) return null;
    if (now() - s.seen > SESSION_IDLE_MS) { sessions.delete(sid); return null; }
    s.seen = now();
    return { sid, ...s, ref: s };
  }

  function requireSession(req, res, next) {
    const s = session(req);
    if (!s) return res.status(401).json({ error: "Belum login atau sesi habis." });
    if (req.method !== "GET") {
      const origin = req.get("origin");
      if (origin && new URL(origin).host !== req.get("host")) return res.status(403).json({ error: "Origin tidak diizinkan." });
      const given = Buffer.from(String(req.get("x-csrf-token") ?? ""));
      const want = Buffer.from(s.csrf);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.status(403).json({ error: "Token CSRF tidak valid." });
    }
    req.adminSession = s;
    next();
  }

  // ---- halaman statis ----
  const page = (file, type) => (_req, res) => res.type(type).send(fs.readFileSync(path.join(HERE, "admin", file), "utf8"));
  app.get("/", (_req, res) => res.redirect("/admin"));
  app.get("/admin", page("index.html", "html"));
  app.get("/admin/app.js", page("app.js", "application/javascript"));

  // ---- sesi ----
  app.post("/admin/api/login", (req, res) => {
    const ip = ipOf(req);
    const f = fails.get(ip);
    if (f && f.until > now()) {
      return res.status(429).json({ error: `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil((f.until - now()) / 60000)} menit.` });
    }
    const ok = crypto.timingSafeEqual(sha(req.body?.password ?? ""), expected);
    if (!ok) {
      const expired = f && f.until > 0 && f.until <= now(); // kunci lama sudah lewat: hitung dari awal
      const n = (expired ? 0 : f?.n ?? 0) + 1;
      fails.set(ip, { n, until: n >= MAX_FAILS ? now() + LOCK_MS : 0 });
      audit.log({ jenis: "admin", aksi: "login_gagal", ip });
      return res.status(401).json({ error: "Password salah." });
    }
    fails.delete(ip);
    const sid = rand();
    const csrf = rand();
    sessions.set(sid, { csrf, seen: now() });
    audit.log({ jenis: "admin", aksi: "login", ip });
    res.set("Set-Cookie", `acc_admin=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_IDLE_MS / 1000}`);
    res.json({ ok: true, csrf });
  });

  app.get("/admin/api/session", (req, res) => {
    const s = session(req);
    res.json(s ? { loggedIn: true, csrf: s.csrf } : { loggedIn: false });
  });

  app.post("/admin/api/logout", requireSession, (req, res) => {
    sessions.delete(req.adminSession.sid);
    res.set("Set-Cookie", "acc_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    res.json({ ok: true });
  });

  // ---- tenant ----
  const fields = (b) => ({
    id: b?.id, name: b?.name, description: b?.description, token: b?.token, secret: b?.secret,
    sigEncoding: b?.sigEncoding || "base64", enabled: b?.enabled !== false, allowWrite: b?.allowWrite === true,
  });
  const fail = (res, err, code = 400) => res.status(code).json({ error: err.message });

  app.get("/admin/api/tenants", requireSession, (_req, res) => {
    res.json({ tenants: registry.adminList(), status: registry.status() });
  });

  app.post("/admin/api/tenants", requireSession, (req, res) => {
    try {
      const id = registry.save(fields(req.body));
      audit.log({ jenis: "admin", aksi: "tambah_tenant", tenant: id, boleh_tulis: req.body?.allowWrite === true, ip: ipOf(req) });
      res.json({ ok: true, id });
    } catch (err) { fail(res, err); }
  });

  app.put("/admin/api/tenants/:id", requireSession, (req, res) => {
    try {
      const id = registry.save(fields(req.body), req.params.id);
      audit.log({
        jenis: "admin", aksi: "ubah_tenant", tenant: id, ...(id !== req.params.id ? { id_lama: req.params.id } : {}),
        ganti_token: Boolean(String(req.body?.token ?? "").trim()), ganti_secret: Boolean(String(req.body?.secret ?? "").trim()),
        aktif: req.body?.enabled !== false, boleh_tulis: req.body?.allowWrite === true, ip: ipOf(req),
      });
      res.json({ ok: true, id });
    } catch (err) { fail(res, err); }
  });

  app.delete("/admin/api/tenants/:id", requireSession, (req, res) => {
    try {
      registry.remove(req.params.id);
      audit.log({ jenis: "admin", aksi: "hapus_tenant", tenant: req.params.id, ip: ipOf(req) });
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  app.post("/admin/api/tenants/:id/test", requireSession, async (req, res) => {
    try {
      const { client } = registry.clientFor(req.params.id);
      const h = await client.getHost(true);
      res.json({ ok: true, database: h.alias, database_id: h.databaseId, host: h.host, user: h.user });
    } catch (err) { fail(res, err, 502); }
  });

  app.get("/admin/api/audit", requireSession, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json({ entries: audit.recent(limit) });
  });

  return app;
}
