// Penghubung Claude Desktop (stdio) -> MCP server Accurate kantor (HTTP), tanpa dependensi.
// Setiap pesan JSON-RPC dari Claude diteruskan apa adanya ke server lewat HTTP POST, dan balasannya
// (JSON biasa atau SSE) diteruskan kembali ke Claude. Tidak ada data Accurate atau token Accurate di sini;
// yang dibutuhkan hanya alamat server dan token MCP kantor.
// Catatan: stdout khusus untuk protokol MCP; semua log ditulis ke stderr.

const URL_MCP = (process.env.MCP_URL || "").trim();
const TOKEN = (process.env.MCP_TOKEN || "").trim().replace(/^Bearer\s+/i, "");
const TIMEOUT_MS = 120_000;

const log = (...a) => console.error("[accurate-multi]", ...a);
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const sendError = (id, message) => {
  if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
};

function checkConfig() {
  if (!URL_MCP) return "Alamat server MCP belum diisi di pengaturan ekstensi.";
  if (!TOKEN) return "Token MCP belum diisi di pengaturan ekstensi.";
  try {
    const u = new URL(URL_MCP);
    if (!["http:", "https:"].includes(u.protocol)) return `Alamat server harus http:// atau https:// (sekarang: ${u.protocol})`;
  } catch {
    return `Alamat server tidak valid: ${URL_MCP}`;
  }
  return null;
}
const configError = checkConfig();
if (configError) log(configError);

// Ambil semua pesan dari isi SSE: event dipisah baris kosong, data ada di baris "data:".
function parseSse(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (data.trim()) {
      try { out.push(JSON.parse(data)); } catch { /* event non-JSON (mis. priming) diabaikan */ }
    }
  }
  return out;
}

function explain(err) {
  const c = err?.cause;
  const code = c?.code || c?.errors?.[0]?.code;
  if (err?.name === "TimeoutError") return `Server MCP tidak menjawab dalam ${TIMEOUT_MS / 1000} detik.`;
  if (code === "ECONNREFUSED") return `Server MCP menolak koneksi (${URL_MCP}). Pastikan 'npm start' berjalan di komputer server.`;
  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return `Komputer server tidak terjangkau (${URL_MCP}). Periksa jaringan, IP server, dan firewall port server.`;
  }
  return `Gagal menghubungi server MCP: ${err?.message ?? err}${code ? ` (${code})` : ""}`;
}

async function forward(msg) {
  const id = msg?.id;
  if (configError) return sendError(id, configError);
  let res;
  try {
    res = await fetch(URL_MCP, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    log(explain(err));
    return sendError(id, explain(err));
  }
  if (res.status === 202 || res.status === 204) return; // notifikasi: tidak ada balasan
  const text = await res.text();
  if (res.status === 401) return sendError(id, "Token MCP ditolak server (401). Periksa token di pengaturan ekstensi.");
  const type = res.headers.get("content-type") || "";
  let messages = [];
  if (type.includes("text/event-stream")) messages = parseSse(text);
  else if (text.trim()) {
    try {
      const j = JSON.parse(text);
      messages = Array.isArray(j) ? j : [j];
    } catch {
      return sendError(id, `Balasan server bukan JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
  }
  if (!messages.length) {
    return sendError(id, `Balasan server kosong (HTTP ${res.status}). Jika memakai antivirus yang memindai HTTP, tambahkan pengecualian untuk ${URL_MCP}.`);
  }
  for (const m of messages) send(m);
}

// Baca stdin per baris (satu pesan JSON-RPC per baris).
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log("Pesan dari Claude bukan JSON, diabaikan."); continue; }
    forward(msg).catch((err) => { log(err); sendError(msg?.id, explain(err)); });
  }
});
process.stdin.on("end", () => process.exit(0));
log(`Siap. Server: ${URL_MCP || "(belum diisi)"}`);
