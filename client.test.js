import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { createAccurateClient } from "./accurate-client.js";

function startMock({ evilHost = false } = {}) {
  const seen = [];
  let flaky = 0;
  const srv = http.createServer((req, res) => {
    const ts = req.headers["x-api-timestamp"], sig = req.headers["x-api-signature"];
    const exp = crypto.createHmac("sha256", "s3cret").update(ts ?? "").digest("base64");
    seen.push({ method: req.method, url: req.url, sigOK: sig === exp, auth: req.headers.authorization });
    const base = `http://127.0.0.1:${srv.address().port}`;
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/api-token.do")) {
      if (req.method !== "POST") { res.statusCode = 405; return res.end("{}"); }
      const host = evilHost ? "https://evil.example.com" : base;
      return res.end(JSON.stringify({ s: true, d: { "data usaha": { host, alias: "PT Uji", id: 7 }, user: { email: "u@x.id" } } }));
    }
    if (req.url.startsWith("/accurate/api/old/")) { res.statusCode = 308; res.setHeader("location", `${base}/accurate/api/glaccount/list.do`); return res.end(); }
    if (req.url.startsWith("/accurate/api/evil/")) { res.statusCode = 308; res.setHeader("location", "http://evil.example.com/steal"); return res.end(); }
    if (req.url.startsWith("/accurate/api/moved/")) { res.statusCode = 302; res.setHeader("location", `${base}/accurate/api/glaccount/list.do`); return res.end(); }
    if (req.url.startsWith("/accurate/api/flaky/list.do")) {
      if (flaky++ < 2) { res.statusCode = 429; return res.end("{}"); }
      return res.end(JSON.stringify({ s: true, d: [{ id: 9 }] }));
    }
    if (req.url.startsWith("/accurate/api/down/list.do")) { res.statusCode = 503; return res.end("{}"); }
    if (req.url.startsWith("/accurate/api/vendor/save.do")) {
      let b = ""; req.on("data", (c) => (b += c));
      return req.on("end", () => {
        seen[seen.length - 1].body = b; seen[seen.length - 1].type = req.headers["content-type"];
        if (b.includes("GAGAL503")) { res.statusCode = 503; return res.end("{}"); }
        res.end(JSON.stringify({ s: true, d: ["Data berhasil disimpan"], r: { id: 77, number: "V.00077" } }));
      });
    }
    if (req.url.startsWith("/accurate/api/glaccount/list.do")) return res.end(JSON.stringify({ s: true, d: [{ id: 1 }] }));
    if (req.url.startsWith("/accurate/api/leak/list.do")) { res.statusCode = 401; return res.end(JSON.stringify({ error: "invalid_token", error_description: `Invalid access token: ${String(req.headers.authorization).slice(7)}` })); }
    if (req.url.startsWith("/accurate/api/err/list.do")) { res.statusCode = 400; return res.end(JSON.stringify({ s: false, d: ["Header X-Api-Signature invalid"] })); }
    res.statusCode = 404; res.end("{}");
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, seen, port: srv.address().port })));
}

const make = (port) => createAccurateClient({
  token: "tok", secret: "s3cret", accountApi: `http://127.0.0.1:${port}/api`,
  allowedHostSuffixes: ["127.0.0.1"], allowInsecureHttp: true, retryBaseMs: 5,
});

test("POST api-token.do, parsing host, GET bertanda tangan benar", async () => {
  const { srv, seen, port } = await startMock();
  try {
    const c = make(port);
    const h = await c.getHost(true);
    assert.equal(h.alias, "PT Uji");
    assert.deepEqual((await c.api("glaccount/list.do", { "sp.page": 1 })).d, [{ id: 1 }]);
    assert.ok(seen.every((s) => s.sigOK && s.auth === "Bearer tok"));
    assert.equal(seen[0].method, "POST");
    assert.ok(seen.slice(1).every((s) => s.method === "GET"));
  } finally { srv.close(); }
});

test("redirect 308 ke host Accurate diikuti dengan tanda tangan baru", async () => {
  const { srv, seen, port } = await startMock();
  try {
    const r = await make(port).api("old/x.do");
    assert.deepEqual(r.d, [{ id: 1 }]);
    assert.ok(seen.every((s) => s.sigOK));
  } finally { srv.close(); }
});

test("redirect 308 ke host asing DITOLAK (token tidak bocor)", async () => {
  const { srv, port } = await startMock();
  try {
    await assert.rejects(() => make(port).api("evil/x.do"), /Diblokir: host/);
  } finally { srv.close(); }
});

test("klien tidak punya jalur kirim selain GET data + POST cek token", async () => {
  const { srv, seen, port } = await startMock();
  try {
    const c = make(port);
    assert.deepEqual(Object.keys(c).sort(), ["allowWrite", "api", "getHost", "write"], "fungsi request mentah tidak boleh diekspor");
    assert.equal(c.allowWrite, false);
    await assert.rejects(() => c.write("vendor/save.do", { name: "x" }), /tulis tidak diizinkan/);
    await c.getHost(true);
    await c.api("glaccount/list.do");
    assert.deepEqual(seen.map((s) => s.method), ["POST", "GET"]);
    assert.ok(seen[0].url.startsWith("/api/api-token.do"));
  } finally { srv.close(); }
});

test("redirect selain 308 tidak diikuti", async () => {
  const { srv, seen, port } = await startMock();
  try {
    await assert.rejects(() => make(port).api("moved/list.do"), /redirect HTTP 302/);
    assert.equal(seen.filter((s) => s.url.includes("glaccount")).length, 0);
  } finally { srv.close(); }
});

test("GET diulang saat 429, menyerah setelah batas retry", async () => {
  const { srv, seen, port } = await startMock();
  try {
    const c = make(port);
    assert.deepEqual((await c.api("flaky/list.do")).d, [{ id: 9 }]);
    assert.equal(seen.filter((s) => s.url.includes("flaky")).length, 3);
    await assert.rejects(() => c.api("down/list.do"), /HTTP 503/);
    assert.equal(seen.filter((s) => s.url.includes("down")).length, 4);
    assert.equal(seen.filter((s) => s.method === "POST").length, 1, "POST cek token tidak diulang-ulang");
  } finally { srv.close(); }
});

test("path tulis ditolak sebelum request dikirim", async () => {
  const { srv, seen, port } = await startMock();
  try {
    const c = make(port);
    for (const p of ["glaccount/save.do", "glaccount/delete.do", "x/bulk-save.do"]) {
      await assert.rejects(() => c.api(p), /Diblokir/);
    }
    assert.equal(seen.length, 0);
  } finally { srv.close(); }
});

test("error dari Accurate diteruskan dengan pesan jelas", async () => {
  const { srv, port } = await startMock();
  try {
    await assert.rejects(() => make(port).api("err/list.do"), /Signature invalid/);
  } finally { srv.close(); }
});

test("host dari api-token.do di luar domain yang diizinkan ditolak", async () => {
  const { srv, seen, port } = await startMock({ evilHost: true });
  try {
    await assert.rejects(() => make(port).api("glaccount/list.do"), /Diblokir: host 'evil.example.com'/);
    assert.equal(seen.length, 1, "token tidak dikirim ke host asing");
  } finally { srv.close(); }
});

test("token yang disebut ulang di pesan error Accurate disembunyikan", async () => {
  const { srv, port } = await startMock();
  try {
    const c = createAccurateClient({
      token: "aat.RAHASIA-123456", secret: "s3cret", accountApi: `http://127.0.0.1:${port}/api`,
      allowedHostSuffixes: ["127.0.0.1"], allowInsecureHttp: true, retryBaseMs: 5,
    });
    await assert.rejects(() => c.api("leak/list.do"), (e) => {
      assert.match(e.message, /Invalid access token: \[disembunyikan\]/);
      assert.ok(!e.message.includes("RAHASIA"), "token tidak boleh muncul di pesan error");
      return true;
    });
  } finally { srv.close(); }
});

test("tulis: POST JSON hanya bila allowWrite, path tulis divalidasi, tidak pernah diulang otomatis", async () => {
  const { srv, seen, port } = await startMock();
  try {
    const c = createAccurateClient({
      token: "tok", secret: "s3cret", accountApi: `http://127.0.0.1:${port}/api`,
      allowedHostSuffixes: ["127.0.0.1"], allowInsecureHttp: true, retryBaseMs: 5, allowWrite: true,
    });
    const r = await c.write("vendor/save.do", { name: "PT Uji" });
    assert.deepEqual(r.r, { id: 77, number: "V.00077" });
    const w = seen.find((s) => s.url.includes("vendor/save.do"));
    assert.equal(w.method, "POST");
    assert.equal(w.type, "application/json");
    assert.deepEqual(JSON.parse(w.body), { name: "PT Uji" });
    assert.ok(w.sigOK);

    for (const p of ["vendor/delete.do", "vendor/void.do", "../x/save.do"]) {
      await assert.rejects(() => c.write(p, {}), /Diblokir/, p);
    }
    const before = seen.filter((s) => s.url.includes("vendor/save.do")).length;
    await assert.rejects(() => c.write("vendor/save.do", { name: "GAGAL503" }), /HTTP 503/);
    assert.equal(seen.filter((s) => s.url.includes("vendor/save.do")).length, before + 1, "POST gagal tidak boleh diulang");
    assert.ok(seen.every((s) => ["GET", "POST"].includes(s.method)), "DELETE/PUT/PATCH tidak pernah dikirim");
  } finally { srv.close(); }
});
