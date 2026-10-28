// Daftar tenant (satu tenant = satu database Accurate = satu API token + signature secret).
// Dibaca dari file JSON dan dimuat ulang otomatis bila file berubah (dicek per permintaan lewat waktu ubah file,
// sehingga juga bekerja di dalam Docker). Bila file baru tidak valid, konfigurasi lama yang valid tetap dipakai.
import fs from "node:fs";
import crypto from "node:crypto";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Validasi isi file tenants.json. Mengembalikan array tenant yang sudah dinormalisasi, atau melempar error. */
export function parseTenants(json) {
  const list = Array.isArray(json) ? json : json?.tenants;
  if (!Array.isArray(list)) throw new Error('Format tidak dikenali: harus berisi { "tenants": [ ... ] }.');
  const seen = new Set();
  return list.map((t, i) => {
    const where = `tenants[${i}]`;
    if (!t || typeof t !== "object") throw new Error(`${where} harus berupa objek.`);
    const id = String(t.id ?? "").trim();
    if (!ID_RE.test(id)) throw new Error(`${where}.id '${id}' tidak valid: huruf kecil/angka/tanda minus, maks. 40 karakter.`);
    if (seen.has(id)) throw new Error(`id tenant ganda: '${id}'.`);
    seen.add(id);
    const token = String(t.token ?? "").trim();
    const secret = String(t.secret ?? "").trim();
    if (!token) throw new Error(`Tenant '${id}': token kosong.`);
    if (!secret) throw new Error(`Tenant '${id}': secret kosong.`);
    const sigEncoding = t.sigEncoding ?? "base64";
    if (!["base64", "hex"].includes(sigEncoding)) throw new Error(`Tenant '${id}': sigEncoding harus base64 atau hex.`);
    return {
      id,
      name: String(t.name ?? id).trim() || id,
      description: t.description ? String(t.description).trim() : undefined,
      token,
      secret,
      sigEncoding,
      enabled: t.enabled !== false,
    };
  });
}

const fingerprint = (t) => crypto.createHash("sha256").update(`${t.token}\u0000${t.secret}\u0000${t.sigEncoding}`).digest("hex");

/**
 * Registry tenant dengan muat-ulang otomatis.
 * createClient(tenant) dipanggil sekali per tenant dan dibuat ulang hanya bila kredensial tenant itu berubah.
 */
export function createTenantRegistry({ file, createClient, log = console.error }) {
  let state = { tenants: new Map(), mtimeMs: -1, size: -1, error: null };
  const clients = new Map(); // id -> { fp, client }

  function reload() {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      state = { ...state, tenants: new Map(), mtimeMs: -1, size: -1, error: `File tenant tidak ditemukan: ${file}` };
      return;
    }
    if (st.mtimeMs === state.mtimeMs && st.size === state.size) return;
    try {
      const list = parseTenants(JSON.parse(fs.readFileSync(file, "utf8")));
      state = { tenants: new Map(list.map((t) => [t.id, t])), mtimeMs: st.mtimeMs, size: st.size, error: null };
      for (const id of clients.keys()) if (!state.tenants.has(id)) clients.delete(id);
      log(`Tenant dimuat: ${list.length} (${list.map((t) => t.id).join(", ") || "-"})`);
    } catch (err) {
      // Pertahankan konfigurasi lama yang valid; catat error agar terlihat.
      state = { ...state, mtimeMs: st.mtimeMs, size: st.size, error: `File tenant tidak valid, konfigurasi sebelumnya tetap dipakai: ${err.message}` };
      log(state.error);
    }
  }

  function active() {
    reload();
    return [...state.tenants.values()].filter((t) => t.enabled);
  }

  /** Daftar tenant tanpa kredensial. */
  function list() {
    return active().map(({ id, name, description }) => ({ id, name, ...(description ? { description } : {}) }));
  }

  /** Ambil tenant + klien Accurate-nya. Tanpa id: boleh hanya bila tepat ada satu tenant aktif. */
  function resolve(id) {
    const all = active();
    if (!all.length) throw new Error(state.error ?? "Belum ada tenant aktif di file tenant.");
    let tenant;
    if (id === undefined || id === null || id === "") {
      if (all.length > 1) {
        throw new Error(`Parameter 'tenant' wajib diisi karena ada ${all.length} tenant: ${all.map((t) => t.id).join(", ")}. Lihat list_tenants.`);
      }
      tenant = all[0];
    } else {
      tenant = all.find((t) => t.id === String(id).trim().toLowerCase());
      if (!tenant) throw new Error(`Tenant '${id}' tidak ditemukan atau nonaktif. Tenant tersedia: ${all.map((t) => t.id).join(", ")}.`);
    }
    const fp = fingerprint(tenant);
    let entry = clients.get(tenant.id);
    if (!entry || entry.fp !== fp) {
      entry = { fp, client: createClient(tenant) };
      clients.set(tenant.id, entry);
    }
    return { tenant, client: entry.client };
  }

  return { list, resolve, status: () => (reload(), { jumlah: active().length, error: state.error }) };
}
