import test from "node:test";
import assert from "node:assert/strict";
import { collectRows } from "./fetch-all.js";

const pager = (total, pageSize, { dup = false, rowCountOff = 0 } = {}) => {
  const calls = [];
  const all = Array.from({ length: total }, (_, i) => ({ id: i + 1, v: 1 }));
  const fetchPage = async (path, q) => {
    calls.push({ path, q });
    const page = Number(q["sp.page"] ?? 1), size = Number(q["sp.pageSize"] ?? pageSize);
    let d = all.slice((page - 1) * size, page * size);
    if (dup && page === 2) d = [all[0], ...d.slice(1)];
    return { s: true, d, sp: { page, pageSize: size, pageCount: Math.ceil(total / size), rowCount: total + rowCountOff } };
  };
  return { fetchPage, calls };
};

test("collectRows mengambil semua halaman", async () => {
  const { fetchPage, calls } = pager(250, 100);
  const { rows, info } = await collectRows(fetchPage, "x/list.do", { fields: "id,v" });
  assert.equal(rows.length, 250); assert.equal(info.lengkap, true); assert.equal(info.halaman_diambil, 3);
  assert.equal(calls[0].q["sp.pageSize"], 100);
});
test("collectRows menolak data tidak lengkap kecuali allowPartial", async () => {
  await assert.rejects(() => collectRows(pager(250, 100).fetchPage, "x/list.do", {}, { maxPages: 2 }), /Data tidak lengkap: hanya 2 dari 3 halaman/);
  const { rows, info } = await collectRows(pager(250, 100).fetchPage, "x/list.do", {}, { maxPages: 2, allowPartial: true });
  assert.equal(rows.length, 200); assert.equal(info.lengkap, false);
});
test("collectRows menolak duplikat dan jumlah baris tidak cocok", async () => {
  await assert.rejects(() => collectRows(pager(250, 100, { dup: true }).fetchPage, "x/list.do", {}), /duplikat/);
  await assert.rejects(() => collectRows(pager(50, 100, { rowCountOff: 3 }).fetchPage, "x/list.do", {}), /tidak cocok/);
});
test("collectRows: endpoint non-list dipanggil sekali; bukan array ditolak", async () => {
  let n = 0;
  const one = async () => { n++; return { s: true, d: [{ a: 1 }, { a: 2 }] }; };
  const { rows, info } = await collectRows(one, "glaccount/get-pl-account-amount.do", { fromDate: "01/01/2021" });
  assert.equal(n, 1); assert.equal(rows.length, 2); assert.equal(info.lengkap, true);
  await assert.rejects(() => collectRows(async () => ({ s: true, d: { x: 1 } }), "x/detail.do", {}), /bukan array/);
});
