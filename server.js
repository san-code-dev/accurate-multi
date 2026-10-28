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
} from "./readonly-guard.js";
import { collectRows } from "./fetch-all.js";
import { createTenantRegistry } from "./tenants.js";

// ---------------------------------------------------------------------------
// Konfigurasi
// ---------------------------------------------------------------------------
// Mode stdio: server dijalankan langsung oleh Claude Desktop/Claude Code (tanpa port jaringan).
// Di mode ini JANGAN menulis ke stdout; semua log lewat console.error.
const STDIO = process.argv.includes("--stdio");

const {
  TENANTS_FILE = "config/tenants.json",
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
  createClient: (t) => createAccurateClient({ token: t.token, secret: t.secret, sigEncoding: t.sigEncoding }),
});
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
Server ini memberi akses BACA-SAJA ke data BEBERAPA database Accurate Online (tenant). Satu tenant = satu database.
Tidak ada tool untuk menambah, mengubah, atau menghapus data, dan hal itu memang tidak mungkin dilakukan lewat server ini.
Jika pengguna meminta menulis/mengubah/menghapus data di Accurate, tolak dan jelaskan bahwa server ini read-only.

Server ini hanya PENGHUBUNG: ia mengambil data apa adanya dan memastikan data itu utuh. Server TIDAK menghitung apa pun;
semua perhitungan (total, rekap, laba rugi, selisih, persentase) adalah tugas Anda.

Tenant:
- Panggil list_tenants lebih dulu untuk melihat database yang tersedia. Semua tool data membutuhkan parameter "tenant"
  (id dari list_tenants), kecuali hanya ada satu tenant.
- Bila pengguna tidak menyebut perusahaan/database dan ada lebih dari satu tenant, TANYAKAN tenant mana; jangan menebak.
- Jangan pernah mencampur data antar tenant dalam satu total, kecuali pengguna memintanya (mis. konsolidasi); dalam hal itu
  tampilkan angka per tenant lalu totalnya, dan sebutkan nama tenant di setiap tabel/laporan.
- id dokumen, pelanggan, vendor, barang, dan akun hanya berlaku di tenant asalnya.

Cara bekerja:
1. Cari endpoint dengan search_endpoints (kata kunci bebas, mis. "faktur pembelian", "stok barang", "akun perkiraan").
   Tanpa argumen: daftar modul. Dengan argumen path: parameter lengkap endpoint itu.
2. Ambil data dengan accurate_get. Selalu gunakan "fields" berisi hanya kolom yang dibutuhkan (plus "id") agar ringkas.
   Untuk daftar lebih dari 100 baris gunakan all_pages=true.
3. Bila respons ditolak karena terlalu besar, pecah per periode (mis. per bulan) dan gabungkan hasilnya.
4. Untuk menjumlahkan banyak angka, hitung DENGAN KODE bila Anda bisa menjalankan kode. Jangan menjumlahkan
   puluhan angka atau lebih di kepala; bila tidak bisa menjalankan kode, katakan bahwa total berisiko salah.
5. Format tanggal Accurate: dd/MM/yyyy. Filter biasanya filter.<field>.op / filter.<field>.val (lihat parameter endpoint).

Aturan keutuhan data:
- Sertakan "id" di fields agar duplikat bisa terdeteksi.
- Jangan pernah menghitung total dari data parsial (ada PERINGATAN, CATATAN, atau lengkap = false).
- Selalu cocokkan jumlah baris yang Anda hitung dengan "baris_menurut_accurate" dan sebutkan ke pengguna.
- Perhatikan dokumen batal/draft dan mata uang asing (field status/currency/rate) sebelum menjumlahkan.

Laba rugi: accurate_get path "glaccount/get-pl-account-amount.do", query {"fromDate":"01/01/2021","toDate":"31/12/2021"}.
- Jumlahkan HANYA baris dengan isParent = false (akun induk sudah berisi jumlah anak-anaknya; kalau ikut dijumlah, angka ganda).
- Kelompokkan per accountType: REVENUE, COST_OF_GOOD_SOLD, EXPENSE, OTHER_INCOME, OTHER_EXPENSE.
  Laba kotor = REVENUE - COST_OF_GOOD_SOLD; laba usaha = laba kotor - EXPENSE;
  laba bersih = laba usaha + OTHER_INCOME - OTHER_EXPENSE.
- Tanda angka untuk pendapatan dan HPP sudah terbukti sesuai asumsi, tetapi untuk beban operasional, retur/diskon penjualan,
  dan pos di luar usaha BELUM diverifikasi terhadap laporan resmi Accurate. Katakan itu kepada pengguna dan sarankan
  mencocokkan laba bersih dengan laporan Laba Rugi di Accurate.
`.trim();

// ---------------------------------------------------------------------------
// Definisi MCP server + tools
// ---------------------------------------------------------------------------
function createMcpServer() {
  const server = new McpServer({ name: "accurate-multi-mcp", version: "1.0.0" }, { instructions: INSTRUCTIONS });

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
        "Mencari endpoint API Accurate yang boleh dipanggil (hanya endpoint baca). " +
        "Tanpa argumen: daftar modul. Dengan 'query': pencarian kata kunci (Indonesia/Inggris). " +
        "Dengan 'path': parameter lengkap satu endpoint (mis. 'sales-invoice/list.do').",
      inputSchema: {
        query: z.string().max(200).optional().describe("Kata kunci, mis. 'faktur penjualan' atau 'stok'"),
        path: z.string().max(200).optional().describe("Path endpoint untuk melihat parameter lengkapnya"),
        limit: z.number().int().min(1).max(30).default(15).describe("Jumlah hasil maksimum"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, path, limit }) => {
      try {
        const catalog = await getCatalog();
        if (path) {
          const entry = catalog.get(normalizePath(path));
          if (!entry) throw new Error(`Endpoint '${path}' tidak ada di daftar endpoint baca.`);
          return ok(describeEndpoint(entry));
        }
        if (!query) return ok({ jumlah_endpoint_baca: catalog.size, modul: listModules(catalog) });
        return ok(searchCatalog(catalog, query, limit));
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
        const norm = assertAllowed(path, catalog);
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

  return server;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
if (STDIO) {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error("Accurate Multi-Tenant MCP (stdio, read-only) siap.");
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
    console.log(`Accurate Multi-Tenant MCP (read-only) berjalan di http://${HOST}:${PORT}/mcp`);
  });
}
