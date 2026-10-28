import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("./server/index.js", import.meta.url));

// Server tiruan: balas SSE untuk id ganjil, JSON biasa untuk id genap, 202 untuk notifikasi.
function startMock() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      seen.push({ auth: req.headers.authorization, accept: req.headers.accept, msg });
      if (req.headers.authorization !== "Bearer rahasia") { res.statusCode = 401; return res.end("{}"); }
      if (msg.id === undefined) { res.statusCode = 202; return res.end(); }
      const reply = { jsonrpc: "2.0", id: msg.id, result: { echo: msg.method } };
      if (msg.id % 2) {
        res.setHeader("content-type", "text/event-stream");
        return res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply));
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}/mcp` })));
}

function runProxy(url, token, messages, expect) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [ENTRY], { env: { ...process.env, MCP_URL: url, MCP_TOKEN: token }, stdio: ["pipe", "pipe", "ignore"] });
    const out = [];
    let buf = "";
    const timer = setTimeout(() => { p.kill(); reject(new Error("timeout")); }, 10_000);
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        out.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
        if (out.length === expect) { clearTimeout(timer); p.kill(); resolve(out); }
      }
    });
    for (const m of messages) p.stdin.write(JSON.stringify(m) + "\n");
  });
}

test("meneruskan permintaan, membaca balasan SSE dan JSON, notifikasi tanpa balasan", async () => {
  const { srv, seen, url } = await startMock();
  try {
    const out = await runProxy(url, "Bearer rahasia", [
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ], 2);
    assert.deepEqual(out.map((m) => m.result.echo).sort(), ["initialize", "tools/list"]);
    assert.ok(seen.every((s) => s.auth === "Bearer rahasia"), "awalan 'Bearer ' tidak boleh dobel");
    assert.ok(seen.every((s) => s.accept.includes("text/event-stream")));
    assert.equal(seen.length, 3);
  } finally { srv.close(); }
});

test("token salah dan server mati menghasilkan error yang jelas untuk Claude", async () => {
  const { srv, url } = await startMock();
  try {
    const [bad] = await runProxy(url, "salah", [{ jsonrpc: "2.0", id: 7, method: "tools/list" }], 1);
    assert.equal(bad.id, 7);
    assert.match(bad.error.message, /Token MCP ditolak/);
  } finally { srv.close(); }
  const [down] = await runProxy("http://127.0.0.1:9/mcp", "x", [{ jsonrpc: "2.0", id: 8, method: "tools/list" }], 1);
  assert.match(down.error.message, /menolak koneksi|tidak terjangkau|Gagal menghubungi/);
});
