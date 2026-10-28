// Pengambilan data lengkap (semua halaman) dari satu endpoint baca Accurate.
// Server ini TIDAK menghitung apa pun; tugasnya memastikan data yang diserahkan ke Claude utuh:
// data yang tidak lengkap, jumlah barisnya tidak cocok, atau berisi duplikat TIDAK pernah diserahkan diam-diam.

/**
 * Ambil semua baris dari sebuah endpoint (semua halaman). fetchPage(path, query) -> respons Accurate.
 * Menolak (error) data yang tidak lengkap, jumlah baris tidak cocok, atau duplikat, kecuali allowPartial = true.
 */
export async function collectRows(fetchPage, path, query, { maxPages = 20, allowPartial = false } = {}) {
  const isList = path.endsWith("/list.do");
  const first = await fetchPage(path, isList ? { ...query, "sp.page": 1, "sp.pageSize": 100 } : query);
  if (!Array.isArray(first?.d)) throw new Error("Endpoint ini tidak mengembalikan daftar (d bukan array).");
  const rows = [...first.d];
  const sp = first.sp ?? null;
  const pageCount = sp?.pageCount ?? 1;
  const pageSize = sp?.pageSize ?? 100;
  let fetched = 1;
  for (let p = 2; p <= Math.min(pageCount, maxPages); p++) {
    const body = await fetchPage(path, { ...query, "sp.page": p, "sp.pageSize": pageSize });
    if (!Array.isArray(body?.d)) throw new Error(`Halaman ${p} tidak mengembalikan daftar.`);
    rows.push(...body.d);
    fetched = p;
  }
  const expected = sp?.rowCount ?? null;
  const complete = fetched >= pageCount;
  const countOk = expected === null || rows.length === expected;
  let duplicates = 0;
  if (rows.length && rows.every((r) => r && r.id !== undefined && r.id !== null)) {
    duplicates = rows.length - new Set(rows.map((r) => r.id)).size;
  }
  const info = {
    halaman_diambil: fetched,
    halaman_total: pageCount,
    baris_diambil: rows.length,
    baris_menurut_accurate: expected,
    lengkap: complete && countOk && duplicates === 0,
    ...(duplicates ? { id_duplikat: duplicates } : {}),
  };
  if (!allowPartial) {
    if (!complete) {
      throw new Error(
        `Data tidak lengkap: hanya ${fetched} dari ${pageCount} halaman (${rows.length} dari ${expected ?? "?"} baris). ` +
          "Naikkan max_pages atau persempit filter (mis. per bulan). Data parsial tidak boleh dipakai untuk total."
      );
    }
    if (!countOk) throw new Error(`Jumlah baris tidak cocok (diambil ${rows.length}, menurut Accurate ${expected}). Data mungkin berubah saat diambil, ulangi.`);
    if (duplicates) throw new Error(`Terdeteksi ${duplicates} baris duplikat (data berubah saat diambil). Ulangi permintaan.`);
  }
  return { rows, info };
}
