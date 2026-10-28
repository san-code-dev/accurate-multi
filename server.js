import crypto from "node:crypto";
import fs from "node:fs";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAccurateClient } from "./accurate-client.js";
import {
  buildCatalog,
  assertAllowed,
  normalizePath,
  sanitizeQuery,
  listModules,
  searchCatalog,
  describeEndpoint,
  sanitizeBody,
} from "./guard.js";
import { collectRows } from "./fetch-all.js";
import { createTenantRegistry } from "./tenants.js";
import { createAudit } from "./audit.js";
import { createAdminApp } from "./admin.js";

// ---------------------------------------------------------------------------
// Konfigurasi
// ---------------------------------------------------------------------------
// Mode stdio: server dijalankan langsung oleh Claude Desktop/Claude Code (tanpa port jaringan).
// Di mode ini JANGAN menulis ke stdout; semua log lewat console.error.
const STDIO = process.argv.includes("--stdio");

const {
  TENANTS_FILE = "data/tenants.json",
  AUDIT_FILE = "data/audit.log",
  ADMIN_PASSWORD,
  ADMIN_PORT = "3032",
  ADMIN_HOST = "127.0.0.1",
  ACCURATE_SPEC_URL = "https://account.accurate.id/open-api/json.do",
  ACCURATE_SPEC_FILE,
  MCP_AUTH_TOKEN,
  PORT = "3031",
  HOST = "127.0.0.1",
} = process.env;

if (!STDIO && !MCP_AUTH_TOKEN) {
  console.error("Env MCP_AUTH_TOKEN belum diisi. Lihat .env.example");
  process.exit(1);
}

const MAX_OUTPUT_CHARS = 100_000; // respons lebih besar dari ini DITOLAK (bukan dipotong diam-diam)
const SPEC_TTL_MS = 24 * 60 * 60 * 1000;

// Satu klien Accurate per tenant (masing-masing punya batas paralel sendiri, sesuai kuota Accurate per token).
const tenants = createTenantRegistry({
  file: TENANTS_FILE,
  createClient: (t) => createAccurateClient({ token: t.token, secret: t.secret, sigEncoding: t.sigEncoding, allowWrite: t.allowWrite }),
});
const audit = createAudit(AUDIT_FILE);
{
  const st = tenants.status();
  if (st.error) console.error(st.error);
  else if (!st.jumlah) console.error(`Belum ada tenant aktif di ${TENANTS_FILE}.`);
}

// ---------------------------------------------------------------------------
// Katalog endpoint BACA (diturunkan dari spesifikasi OpenAPI resmi Accurate)
// ---------------------------------------------------------------------------
let catalogCache = null;
async function getCatalog() {
  if (catalogCache && Date.now() - catalogCache.at < SPEC_TTL_MS) return catalogCache.catalog;
  let spec;
  if (ACCURATE_SPEC_FILE) {
    spec = JSON.parse(await fs.promises.readFile(ACCURATE_SPEC_FILE, "utf8"));
  } else {
    // Spesifikasi bersifat publik; token TIDAK dikirim ke URL ini.
    const res = await fetch(ACCURATE_SPEC_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Gagal mengunduh spesifikasi API Accurate (HTTP ${res.status}). Anda dapat memakai ACCURATE_SPEC_FILE.`);
    }
    spec = await res.json();
  }
  const catalog = buildCatalog(spec);
  if (catalog.size === 0) throw new Error("Katalog endpoint kosong: format spesifikasi API tidak dikenali.");
  catalogCache = { catalog, at: Date.now() };
  return catalog;
}

// ---------------------------------------------------------------------------
// Utilitas
// ---------------------------------------------------------------------------
// Data yang terpotong bisa membuat Claude menghitung dari setengah data tanpa sadar, jadi respons besar ditolak utuh.
const toText = (data) => {
  const s = typeof data === "string" ? data : JSON.stringify(data); // ringkas (tanpa spasi) agar lebih banyak baris muat
  if (s.length > MAX_OUTPUT_CHARS) {
    throw new Error(
      `Respons terlalu besar (${s.length} karakter, batas ${MAX_OUTPUT_CHARS}) dan TIDAK ditampilkan agar tidak terbaca sebagian. ` +
        "Gunakan 'fields' agar ringkas, atau persempit filter/periode (mis. per bulan) lalu gabungkan hasilnya."
    );
  }
  return s;
};
const ok = (data) => ({ content: [{ type: "text", text: toText(data) }] });

// Node menulis "fetch failed" tanpa sebab. Sebab sebenarnya (ENOTFOUND, ETIMEDOUT, sertifikat, dll.) ada di err.cause.
function describeError(err) {
  const c = err?.cause;
  if (!c) return err.message;
  const parts = [c.code, c.message, ...(c.errors ?? []).map((e) => e.code ?? e.message)].filter(Boolean);
  return `${err.message} (penyebab: ${[...new Set(parts)].join("; ")})`;
}
const fail = (err) => ({ isError: true, content: [{ type: "text", text: `Gagal: ${describeError(err)}` }] });

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const querySchema = z.record(scalar).default({});
const tenantSchema = z.string().max(40).optional().describe("id tenant dari list_tenants (wajib bila ada lebih dari satu tenant)");

const INSTRUCTIONS = `
Server ini memberi akses ke BEBERAPA database Accurate Online (tenant). Satu tenant = satu database.
Semua tenant bisa DIBACA. Tenant dengan boleh_tulis = true juga bisa DITULIS (tambah/ubah) lewat accurate_write.
Penghapusan data TIDAK PERNAH bisa dilakukan lewat server ini; bila diminta menghapus, tolak dan sarankan dilakukan di Accurate.

Tenant:
- Panggil list_tenants lebih dulu. Semua tool data membutuhkan parameter "tenant" (id dari list_tenants), kecuali hanya ada satu tenant.
- Bila pengguna tidak menyebut perusahaan/database dan ada lebih dari satu tenant, TANYAKAN tenant mana; jangan menebak.
- Jangan mencampur data antar tenant dalam satu total kecuali diminta (konsolidasi); tampilkan per tenant lalu totalnya.
- id dokumen, pelanggan, vendor, barang, dan akun hanya berlaku di tenant asalnya.

Membaca:
1. Cari endpoint dengan search_endpoints (jenis "baca"). Dengan argumen path: parameter lengkapnya.
2. Ambil data dengan accurate_get. Gunakan "fields" seperlunya (plus "id"). Untuk daftar >100 baris gunakan all_pages=true.
3. Bila respons ditolak karena terlalu besar, pecah per periode lalu gabungkan.
4. Hitung banyak angka DENGAN KODE bila bisa; jangan di kepala. Format tanggal Accurate: dd/MM/yyyy.

Menulis (tambah/ubah) - data keuangan asli, tidak bisa dibatalkan otomatis:
1. Hanya bila pengguna jelas meminta perubahan itu, dan hanya di tenant yang ia sebut.
2. Cari endpoint dengan search_endpoints (jenis "tulis"), lalu lihat field-nya dengan argumen path.
3. Untuk MENGUBAH data, ambil dulu datanya (accurate_get detail.do) agar tahu id dan nilai saat ini; sertakan "id" di body.
   Tanpa "id", Accurate MEMBUAT data baru.
4. SEBELUM memanggil accurate_write, tampilkan ke pengguna: tenant, endpoint, dan isi yang akan dikirim (tabel ringkas),
   lalu minta konfirmasi eksplisit ("ya"/"lanjut"). Baru panggil accurate_write dengan dikonfirmasi = true.
5. Satu panggilan untuk satu perubahan yang sudah disetujui. Jangan mengulang panggilan yang gagal tanpa bertanya;
   periksa dulu dengan accurate_get apakah data sudah tersimpan, agar tidak tercipta data ganda.
6. Setelah berhasil, laporkan id/nomor dokumen yang dikembalikan Accurate.

Aturan keutuhan data:
- Sertakan "id" di fields agar duplikat bisa terdeteksi.
- Jangan menghitung total dari data parsial (ada PERINGATAN, CATATAN, atau lengkap = false).
- Cocokkan jumlah baris yang dihitung dengan "baris_menurut_accurate" dan sebutkan ke pengguna.
- Perhatikan dokumen batal/draft dan mata uang asing (field status/currency/rate) sebelum menjumlahkan.

Laba rugi: accurate_get path "glaccount/get-pl-account-amount.do", query {"fromDate":"01/01/2021","toDate":"31/12/2021"}.
- Jumlahkan HANYA baris dengan isParent = false. Kelompokkan per accountType: REVENUE, COST_OF_GOOD_SOLD, EXPENSE,
  OTHER_INCOME, OTHER_EXPENSE. Laba kotor = REVENUE - COST_OF_GOOD_SOLD; laba usaha = laba kotor - EXPENSE;
  laba bersih = laba usaha + OTHER_INCOME - OTHER_EXPENSE.
- Tanda angka beban operasional, retur/diskon penjualan, dan pos di luar usaha BELUM diverifikasi terhadap laporan resmi
  Accurate. Katakan itu dan sarankan mencocokkan laba bersih dengan laporan Laba Rugi di Accurate.
`.trim();

// ---------------------------------------------------------------------------
// Definisi MCP server + tools
// ---------------------------------------------------------------------------
function createMcpServer() {
  const server = new McpServer({ name: "accurate-multi-mcp", version: "2.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_tenants",
    {
      title: "Daftar tenant Accurate",
      description: "Menampilkan semua tenant (database Accurate) yang bisa dibaca lewat server ini: id dan nama. Panggil ini lebih dulu.",
      inputSchema: {},
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    async () => {
      try {
        const list = tenants.list();
        const st = tenants.status();
        return ok({ jumlah: list.length, tenant: list, ...(st.error ? { peringatan: st.error } : {}) });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "check_connection",
    {
      title: "Cek koneksi Accurate",
      description: "Memastikan token & signature tenant valid, dan menampilkan host serta nama database Accurate yang terhubung.",
      inputSchema: { tenant: tenantSchema },
      annotations: READ_ONLY,
    },
    async ({ tenant }) => {
      try {
        const { tenant: t, client } = tenants.resolve(tenant);
        const h = await client.getHost(true);
        return ok({ tenant: t.id, nama_tenant: t.name, status: "terhubung", host: h.host, database: h.alias, database_id: h.databaseId, user_token: h.user });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "search_endpoints",
    {
      title: "Cari endpoint Accurate (baca)",
      description:
        "Mencari endpoint API Accurate yang boleh dipanggil: baca (accurate_get) atau tulis tambah/ubah (accurate_write). " +
        "Tanpa argumen: daftar modul. Dengan 'query': pencarian kata kunci (Indonesia/Inggris). " +
        "Dengan 'path': parameter lengkap satu endpoint (mis. 'sales-invoice/list.do').",
      inputSchema: {
        query: z.string().max(200).optional().describe("Kata kunci, mis. 'faktur penjualan' atau 'stok'"),
        path: z.string().max(200).optional().describe("Path endpoint untuk melihat parameter lengkapnya"),
        limit: z.number().int().min(1).max(30).default(15).describe("Jumlah hasil maksimum"),
        jenis: z.enum(["baca", "tulis", "semua"]).default("semua").describe("Saring endpoint baca atau tulis"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, path, limit, jenis }) => {
      try {
        const catalog = await getCatalog();
        const kind = jenis === "baca" ? "read" : jenis === "tulis" ? "write" : undefined;
        if (path) {
          const entry = catalog.get(normalizePath(path));
          if (!entry) throw new Error(`Endpoint '${path}' tidak ada di daftar endpoint baca.`);
          return ok(describeEndpoint(entry));
        }
        if (!query) {
          const all = [...catalog.values()];
          return ok({
            jumlah_endpoint_baca: all.filter((e) => e.kind === "read").length,
            jumlah_endpoint_tulis: all.filter((e) => e.kind === "write").length,
            modul: listModules(catalog, kind),
          });
        }
        return ok(searchCatalog(catalog, query, limit, kind));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "accurate_get",
    {
      title: "Lihat data dari Accurate (read-only)",
      description:
        "Memanggil satu endpoint BACA Accurate (HTTP GET), mis. 'sales-invoice/list.do' atau 'glaccount/mutation.do', untuk MELIHAT data. " +
        "Untuk daftar panjang gunakan all_pages=true dan 'fields' seperlunya. Hanya endpoint baca resmi (scope *_view) yang diizinkan. " +
        "Cari endpoint dan parameternya dulu dengan search_endpoints.",
      inputSchema: {
        tenant: tenantSchema,
        path: z.string().max(200).describe("Path endpoint, mis. 'sales-invoice/list.do'"),
        query: querySchema.describe("Query parameter, mis. {\"fields\":\"id,number\",\"filter.transDate.op\":\"BETWEEN\",...}"),
        all_pages: z.boolean().default(false).describe("Untuk endpoint list.do: ambil beberapa halaman sekaligus dan gabungkan"),
        max_pages: z.number().int().min(1).max(50).default(20).describe("Batas halaman bila all_pages=true (100 baris/halaman)"),
      },
      annotations: READ_ONLY,
    },
    async ({ tenant, path, query, all_pages, max_pages }) => {
      try {
        const { tenant: t, client } = tenants.resolve(tenant);
        const catalog = await getCatalog();
        const norm = assertAllowed(path, catalog, "read");
        const q = sanitizeQuery(query);
        if (!(all_pages && norm.endsWith("/list.do"))) {
          const body = await client.api(norm, q);
          const sp = body?.sp;
          if (sp?.pageCount > 1) {
            body.CATATAN =
              `Ini hanya halaman ${sp.page ?? 1} dari ${sp.pageCount} (${sp.rowCount ?? "?"} baris total). ` +
              "Jangan dijumlahkan sebagai total; gunakan all_pages=true.";
          }
          return ok({ tenant: t.id, ...body });
        }
        const fetchPage = (p, qq) => client.api(p, qq);
        const { rows, info } = await collectRows(fetchPage, norm, q, { maxPages: max_pages, allowPartial: true });
        return ok({
          tenant: t.id,
          s: true,
          d: rows,
          ...info,
          ...(info.lengkap ? {} : { PERINGATAN: "Data TIDAK lengkap atau bermasalah (lihat info di atas). Jangan dijumlahkan." }),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "accurate_write",
    {
      title: "Tambah/ubah data di Accurate",
      description:
        "MENAMBAH atau MENGUBAH data asli di satu tenant Accurate (HTTP POST ke endpoint tulis, mis. 'vendor/save.do'). " +
        "Hanya untuk tenant dengan boleh_tulis = true. Hapus data tidak diizinkan. Sertakan 'id' untuk mengubah data yang ada; " +
        "tanpa 'id' akan membuat data baru. WAJIB tampilkan isinya ke pengguna dan dapatkan konfirmasi sebelum memanggil.",
      inputSchema: {
        tenant: tenantSchema,
        path: z.string().max(200).describe("Path endpoint tulis, mis. 'vendor/save.do' (cari dengan search_endpoints jenis 'tulis')"),
        body: z.record(z.unknown()).describe("Isi JSON sesuai field endpoint, mis. {\"name\":\"PT X\",\"transDate\":\"31/12/2025\"}"),
        dikonfirmasi: z.boolean().describe("true HANYA bila pengguna sudah melihat isi ini dan menyetujuinya secara eksplisit"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ tenant, path, body, dikonfirmasi }) => {
      let t, norm;
      try {
        if (dikonfirmasi !== true) {
          throw new Error("Belum dikonfirmasi. Tampilkan tenant, endpoint, dan isi yang akan dikirim ke pengguna, minta persetujuan, lalu panggil lagi dengan dikonfirmasi = true.");
        }
        const r = tenants.resolve(tenant);
        t = r.tenant;
        if (!t.allowWrite) {
          throw new Error(`Tenant '${t.id}' hanya boleh dibaca. Izin tulis harus diaktifkan admin di halaman admin.`);
        }
        const catalog = await getCatalog();
        norm = assertAllowed(path, catalog, "write");
        const clean = sanitizeBody(body);
        const result = await r.client.write(norm, clean);
        const ref = result?.r ?? {};
        const hasil = [ref.number, ref.id !== undefined ? `id ${ref.id}` : null].filter(Boolean).join(", ");
        audit.log({ jenis: "tulis", tenant: t.id, path: norm, ok: true, hasil: hasil || undefined, body: clean });
        return ok({ tenant: t.id, path: norm, ...result });
      } catch (e) {
        if (t && norm) audit.log({ jenis: "tulis", tenant: t.id, path: norm, ok: false, error: describeError(e).slice(0, 500), body });
        return fail(e);
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
if (STDIO) {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error("Accurate Multi-Tenant MCP (stdio) siap. Halaman admin hanya tersedia di mode HTTP.");
} else {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const requireAuth = (req, res, next) => {
    const given = Buffer.from(req.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${MCP_AUTH_TOKEN}`);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    }
    next();
  };

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Mode stateless: server + transport baru untuk setiap request.
  app.post("/mcp", requireAuth, async (req, res) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP error:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req, res) =>
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.listen(Number(PORT), HOST, () => {
    console.log(`Accurate Multi-Tenant MCP berjalan di http://${HOST}:${PORT}/mcp`);
  });

  // Halaman admin di port terpisah. Tanpa ADMIN_PASSWORD yang cukup kuat, admin tidak dijalankan.
  let adminApp = null;
  try {
    adminApp = createAdminApp({ registry: tenants, audit, password: ADMIN_PASSWORD });
  } catch (err) {
    console.error(`Halaman admin TIDAK dijalankan: ${err.message}`);
  }
  adminApp?.listen(Number(ADMIN_PORT), ADMIN_HOST, () => {
    console.log(`Halaman admin di http://${ADMIN_HOST}:${ADMIN_PORT}/admin`);
  });
}
