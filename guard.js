// Pengaman akses + katalog endpoint dari spesifikasi OpenAPI resmi Accurate.
//
// Dua jenis endpoint yang boleh dipanggil (semua lainnya ditolak, fail closed):
//
//   BACA  ("read")  : operasi HTTP GET, semua scope berakhiran "_view", nama operasi tidak mengandung kata tulis.
//   TULIS ("write") : operasi HTTP POST, semua scope berakhiran "_save" (tambah/ubah), nama operasi tidak mengandung
//                     kata hapus. Endpoint ber-scope "_delete" dan metode HTTP DELETE TIDAK PERNAH diizinkan.
//
// Keduanya wajib berada di server data usaha ({cloudServerCode}.accurate.id/accurate) dan berbentuk path aman.

const SAFE_PATH = /^[a-z0-9-]+(\/[a-z0-9-]+)*\.do$/;

// Kata yang membuat sebuah endpoint BUKAN endpoint baca.
const READ_DENY = new Set([
  "save", "delete", "remove", "update", "edit", "bulk", "approve", "reject", "cancel", "post",
  "void", "import", "upload", "clone", "copy", "reopen", "close", "renew", "reset", "send",
  "execute", "create", "insert", "submit", "set", "change", "write", "merge", "pay", "lock",
  "unlock", "activate", "deactivate",
]);
// Kata yang membuat sebuah endpoint tulis dianggap menghapus (tidak diizinkan).
const WRITE_DENY = new Set(["delete", "remove", "void", "purge", "destroy", "erase"]);

/** "/api/glaccount/list.do" | "api/glaccount/list.do" | "glaccount/list.do" -> "glaccount/list.do" */
export function normalizePath(input) {
  let p = String(input ?? "").trim().replace(/^\/+/, "");
  if (p.startsWith("api/")) p = p.slice(4);
  return p;
}

const opTokens = (path) => path.split("/").pop().replace(/\.do$/, "").split("-");

export function isSafeShape(path, kind = "read") {
  if (!SAFE_PATH.test(path)) return false;
  const deny = kind === "write" ? WRITE_DENY : READ_DENY;
  return !opTokens(path).some((t) => deny.has(t));
}

export function assertSafeShape(path, kind = "read") {
  if (!isSafeShape(path, kind)) {
    throw new Error(
      kind === "write"
        ? `Diblokir: '${path}' bukan endpoint tulis yang diizinkan (hanya tambah/ubah; hapus tidak diizinkan).`
        : `Diblokir: '${path}' bukan endpoint baca yang valid/aman.`
    );
  }
}

// Parameter yang di beberapa framework web dipakai untuk mengganti metode HTTP (GET -> POST/DELETE).
const METHOD_OVERRIDE = /^(_?method|x-http-method(-override)?|x-method-override)$/i;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Validasi query agar hanya berisi parameter sederhana (tidak bisa menyisipkan path/header/metode). */
export function sanitizeQuery(query) {
  const out = {};
  const entries = Object.entries(query ?? {});
  if (entries.length > 60) throw new Error("Terlalu banyak parameter query (maks. 60).");
  for (const [k, v] of entries) {
    if (!/^[A-Za-z0-9_.\[\]-]{1,80}$/.test(k)) throw new Error(`Nama parameter tidak valid: '${k}'`);
    if (METHOD_OVERRIDE.test(k)) throw new Error(`Diblokir: parameter '${k}' tidak diizinkan.`);
    if (!["string", "number", "boolean"].includes(typeof v)) throw new Error(`Nilai parameter '${k}' harus string/angka/boolean.`);
    const s = String(v);
    if (s.length > 500 || /[\u0000-\u001f]/.test(s)) throw new Error(`Nilai parameter '${k}' tidak valid.`);
    out[k] = s;
  }
  return out;
}

const MAX_BODY_BYTES = 256 * 1024;
const MAX_DEPTH = 8;

/**
 * Validasi isi (body JSON) untuk endpoint tulis. Menolak:
 *  - bukan objek, terlalu besar, terlalu dalam, kunci berbahaya, kunci pengganti metode,
 *  - penghapusan baris rincian ("_status": "delete"), karena kebijakan server ini: tidak ada penghapusan.
 */
export function sanitizeBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Isi (body) harus berupa objek JSON, mis. {\"name\":\"PT X\",\"transDate\":\"31/12/2025\"}.");
  }
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error(`Isi terlalu besar (maks. ${MAX_BODY_BYTES / 1024} KB).`);
  const walk = (v, depth, where) => {
    if (depth > MAX_DEPTH) throw new Error(`Isi terlalu bertingkat (maks. ${MAX_DEPTH} tingkat).`);
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, depth + 1, `${where}[${i}]`));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_KEYS.has(k) || METHOD_OVERRIDE.test(k)) throw new Error(`Diblokir: kunci '${k}' tidak diizinkan.`);
        if (k === "_status" && String(x).toLowerCase() === "delete") {
          throw new Error(`Diblokir: penghapusan (${where}._status = "delete") tidak diizinkan di server ini.`);
        }
        walk(x, depth + 1, where ? `${where}.${k}` : k);
      }
      return;
    }
    if (typeof v === "string" && v.length > 10_000) throw new Error(`Nilai '${where}' terlalu panjang.`);
  };
  walk(body, 0, "");
  return JSON.parse(text); // salinan bersih (tanpa prototipe aneh)
}

const trim = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

const scopesOf = (op) => (op.security ?? []).flatMap((s) => Object.values(s).flat()).map(String);
const onDataServer = (op) => (op.servers ?? []).some((s) => String(s?.url).includes("{cloudServerCode}"));

function summarizeSchema(schema, depth = 0) {
  if (!schema || depth > 2) return undefined;
  const props = schema.properties ?? schema.items?.properties;
  if (!props) return undefined;
  const required = new Set(schema.required ?? schema.items?.required ?? []);
  return Object.entries(props).map(([name, p]) => ({
    nama: name,
    wajib: required.has(name),
    tipe: p.type === "array" ? `array<${p.items?.type ?? "object"}>` : p.type,
    ...(p.enum ? { pilihan: p.enum } : {}),
    deskripsi: trim(p.description, 160),
    ...(p.type === "array" && p.items?.properties ? { isi: summarizeSchema(p.items, depth + 1) } : {}),
  }));
}

/**
 * Bangun katalog dari spesifikasi OpenAPI Accurate.
 * Mengembalikan Map(path -> entry) dengan entry.kind = "read" | "write".
 */
export function buildCatalog(spec) {
  const tagDesc = new Map((spec?.tags ?? []).map((t) => [t.name, t.description ?? ""]));
  const catalog = new Map();

  for (const [rawPath, item] of Object.entries(spec?.paths ?? {})) {
    const m = /^\/api\/(.+)$/.exec(rawPath);
    if (!m) continue;
    const path = m[1];

    for (const [method, kind, scopeRe] of [["get", "read", /_view$/], ["post", "write", /_save$/]]) {
      const op = item?.[method];
      if (!op || !onDataServer(op) || !isSafeShape(path, kind)) continue;
      const scopes = scopesOf(op);
      if (scopes.length === 0 || !scopes.every((s) => scopeRe.test(s))) continue;
      if (catalog.has(path)) continue; // satu path satu jenis; GET didahulukan
      const tag = op.tags?.[0] ?? "";
      const body = op.requestBody?.content?.["application/json"]?.schema;
      catalog.set(path, {
        path,
        kind,
        method: method.toUpperCase(),
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
        ...(kind === "write" ? { body: summarizeSchema(body) ?? [] } : {}),
      });
    }
  }
  return catalog;
}

export function assertAllowed(input, catalog, kind = "read") {
  const norm = normalizePath(input);
  assertSafeShape(norm, kind);
  const e = catalog.get(norm);
  if (!e || e.kind !== kind) {
    const what = kind === "write" ? "TULIS (tambah/ubah)" : "BACA";
    throw new Error(`Diblokir: '${norm}' tidak ada dalam daftar endpoint ${what} yang diizinkan. Gunakan search_endpoints.`);
  }
  return norm;
}

const kindLabel = (k) => (k === "write" ? "tulis" : "baca");

export function listModules(catalog, kind) {
  const mods = new Map();
  for (const e of catalog.values()) {
    if (kind && e.kind !== kind) continue;
    if (!mods.has(e.modul)) mods.set(e.modul, { modul: e.modul, nama: e.modulNama, baca: [], tulis: [] });
    mods.get(e.modul)[kindLabel(e.kind)].push(e.path.slice(e.modul.length + 1));
  }
  return [...mods.values()].sort((a, b) => a.modul.localeCompare(b.modul));
}

export function searchCatalog(catalog, query, limit = 15, kind) {
  const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const e of catalog.values()) {
    if (kind && e.kind !== kind) continue;
    const hay = `${e.path} ${e.modul} ${e.modulNama} ${e.deskripsi}`.toLowerCase();
    const score = tokens.filter((t) => hay.includes(t)).length;
    if (score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.path.length - b.e.path.length || a.e.path.localeCompare(b.e.path));
  return {
    jumlah_ditemukan: scored.length,
    hasil: scored.slice(0, limit).map(({ e }) => ({
      path: e.path,
      jenis: kindLabel(e.kind),
      modul: e.modulNama || e.modul,
      deskripsi: trim(e.deskripsi, 200),
      ...(e.kind === "write"
        ? { isi_wajib: (e.body ?? []).filter((p) => p.wajib).map((p) => p.nama) }
        : { parameter_wajib: e.params.filter((p) => p.wajib).map((p) => p.name) }),
      scope: e.scopes,
    })),
    petunjuk: "Untuk detail parameter/isi sebuah endpoint, panggil search_endpoints dengan argumen path.",
  };
}

export function describeEndpoint(e) {
  return {
    path: e.path,
    jenis: kindLabel(e.kind),
    metode: e.method,
    modul: e.modulNama || e.modul,
    deskripsi: trim(e.deskripsi, 400),
    scope: e.scopes,
    ...(e.kind === "write"
      ? {
          isi: (e.body ?? []).slice(0, 120),
          ...((e.body ?? []).length > 120 ? { catatan: `${e.body.length - 120} field lain tidak ditampilkan.` } : {}),
          petunjuk: "Kirim lewat accurate_write dengan 'body' berisi field di atas. Untuk MENGUBAH data, sertakan 'id' dokumen yang ada.",
        }
      : {
          parameter: e.params.slice(0, 80).map((p) => ({
            nama: p.name,
            wajib: p.wajib,
            tipe: p.tipe,
            ...(p.pilihan ? { pilihan: p.pilihan } : {}),
            ...(p.deprecated ? { deprecated: true } : {}),
            deskripsi: trim(p.deskripsi, 240),
          })),
          ...(e.params.length > 80 ? { catatan: `${e.params.length - 80} parameter lain tidak ditampilkan.` } : {}),
        }),
  };
}
