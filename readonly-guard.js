// Pengaman READ-ONLY + katalog endpoint dari spesifikasi OpenAPI Accurate.
//
// Sebuah endpoint hanya boleh dipanggil jika SEMUA syarat ini terpenuhi:
//   1. Di spesifikasi, endpoint punya operasi HTTP "get" (bukan post/delete).
//   2. Servernya adalah API data usaha ({cloudServerCode}.accurate.id/accurate), bukan API akun/dasar.
//   3. Semua scope yang dibutuhkan berakhiran "_view" (scope tulis: *_save, *_delete).
//   4. Bentuk path aman (huruf kecil/angka/tanda minus, berakhiran .do) dan nama operasinya
//      tidak mengandung kata operasi tulis (save, delete, update, approve, dst.).
// Gagal salah satu = ditolak (fail closed).

const SAFE_PATH = /^[a-z0-9-]+(\/[a-z0-9-]+)*\.do$/;

const DENY_TOKENS = new Set([
  "save", "delete", "remove", "update", "edit", "bulk", "approve", "reject", "cancel", "post",
  "void", "import", "upload", "clone", "copy", "reopen", "close", "renew", "reset", "send",
  "execute", "create", "insert", "submit", "set", "change", "write", "merge", "pay", "lock",
  "unlock", "activate", "deactivate",
]);

/** "/api/glaccount/list.do" | "api/glaccount/list.do" | "glaccount/list.do" -> "glaccount/list.do" */
export function normalizePath(input) {
  let p = String(input ?? "").trim().replace(/^\/+/, "");
  if (p.startsWith("api/")) p = p.slice(4);
  return p;
}

export function isSafeShape(path) {
  if (!SAFE_PATH.test(path)) return false;
  const last = path.split("/").pop().replace(/\.do$/, "");
  return !last.split("-").some((t) => DENY_TOKENS.has(t));
}

export function assertSafeShape(path) {
  if (!isSafeShape(path)) {
    throw new Error(`Diblokir: '${path}' bukan endpoint baca yang valid/aman. Server ini read-only.`);
  }
}

// Parameter yang di beberapa framework web dipakai untuk mengganti metode HTTP (GET -> POST/DELETE).
const METHOD_OVERRIDE = /^(_?method|x-http-method(-override)?|x-method-override)$/i;

/** Validasi query agar hanya berisi parameter sederhana (tidak bisa menyisipkan path/header/metode). */
export function sanitizeQuery(query) {
  const out = {};
  const entries = Object.entries(query ?? {});
  if (entries.length > 60) throw new Error("Terlalu banyak parameter query (maks. 60).");
  for (const [k, v] of entries) {
    if (!/^[A-Za-z0-9_.\[\]-]{1,80}$/.test(k)) throw new Error(`Nama parameter tidak valid: '${k}'`);
    if (METHOD_OVERRIDE.test(k)) throw new Error(`Diblokir: parameter '${k}' tidak diizinkan (server read-only).`);
    if (!["string", "number", "boolean"].includes(typeof v)) throw new Error(`Nilai parameter '${k}' harus string/angka/boolean.`);
    const s = String(v);
    if (s.length > 500 || /[\u0000-\u001f]/.test(s)) throw new Error(`Nilai parameter '${k}' tidak valid.`);
    out[k] = s;
  }
  return out;
}

const trim = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** Bangun katalog endpoint baca dari spesifikasi OpenAPI Accurate. Mengembalikan Map(path -> entry). */
export function buildCatalog(spec) {
  const tagDesc = new Map((spec?.tags ?? []).map((t) => [t.name, t.description ?? ""]));
  const catalog = new Map();

  for (const [rawPath, item] of Object.entries(spec?.paths ?? {})) {
    const op = item?.get;
    if (!op) continue; // hanya operasi GET

    const m = /^\/api\/(.+)$/.exec(rawPath);
    if (!m) continue;
    const path = m[1];
    if (!isSafeShape(path)) continue;

    // API data usaha saja (bukan API akun/dasar di account.accurate.id)
    const onDataServer = (op.servers ?? []).some((s) => String(s?.url).includes("{cloudServerCode}"));
    if (!onDataServer) continue;

    // Semua scope harus *_view; tanpa info scope = ditolak
    const scopes = (op.security ?? []).flatMap((s) => Object.values(s).flat());
    if (scopes.length === 0 || !scopes.every((s) => /_view$/.test(String(s)))) continue;

    const tag = op.tags?.[0] ?? "";
    catalog.set(path, {
      path,
      modul: tag.replace(/^\/api\//, ""),
      modulNama: tagDesc.get(tag) ?? "",
      deskripsi: op.description ?? op.summary ?? "",
      scopes: [...new Set(scopes)],
      params: (op.parameters ?? [])
        .filter((p) => p.in === "query")
        .map((p) => ({
          name: p.name,
          wajib: Boolean(p.required),
          tipe: p.schema?.type === "array" ? `array<${p.schema.items?.type ?? "?"}>` : p.schema?.type,
          pilihan: p.schema?.enum ?? p.schema?.items?.enum,
          deprecated: Boolean(p.deprecated),
          deskripsi: p.description ?? "",
        })),
    });
  }
  return catalog;
}

export function assertAllowed(input, catalog) {
  const norm = normalizePath(input);
  assertSafeShape(norm);
  if (!catalog.has(norm)) {
    throw new Error(
      `Diblokir: '${norm}' tidak ada dalam daftar endpoint BACA yang diizinkan. Gunakan search_endpoints untuk mencari endpoint yang tersedia.`
    );
  }
  return norm;
}

export function listModules(catalog) {
  const mods = new Map();
  for (const e of catalog.values()) {
    if (!mods.has(e.modul)) mods.set(e.modul, { modul: e.modul, nama: e.modulNama, endpoint: [] });
    mods.get(e.modul).endpoint.push(e.path.slice(e.modul.length + 1));
  }
  return [...mods.values()].sort((a, b) => a.modul.localeCompare(b.modul));
}

export function searchCatalog(catalog, query, limit = 15) {
  const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const e of catalog.values()) {
    const hay = `${e.path} ${e.modul} ${e.modulNama} ${e.deskripsi}`.toLowerCase();
    const score = tokens.filter((t) => hay.includes(t)).length;
    if (score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.path.length - b.e.path.length || a.e.path.localeCompare(b.e.path));
  return {
    jumlah_ditemukan: scored.length,
    hasil: scored.slice(0, limit).map(({ e }) => ({
      path: e.path,
      modul: e.modulNama || e.modul,
      deskripsi: trim(e.deskripsi, 200),
      parameter_wajib: e.params.filter((p) => p.wajib).map((p) => p.name),
      scope: e.scopes,
    })),
    petunjuk: "Untuk parameter lengkap sebuah endpoint, panggil search_endpoints dengan argumen path.",
  };
}

export function describeEndpoint(e) {
  return {
    path: e.path,
    modul: e.modulNama || e.modul,
    deskripsi: trim(e.deskripsi, 400),
    scope: e.scopes,
    parameter: e.params.slice(0, 80).map((p) => ({
      nama: p.name,
      wajib: p.wajib,
      tipe: p.tipe,
      ...(p.pilihan ? { pilihan: p.pilihan } : {}),
      ...(p.deprecated ? { deprecated: true } : {}),
      deskripsi: trim(p.deskripsi, 240),
    })),
    ...(e.params.length > 80 ? { catatan: `${e.params.length - 80} parameter lain tidak ditampilkan.` } : {}),
  };
}
