// Catatan audit (JSON per baris): setiap penulisan ke Accurate dan setiap perubahan di halaman admin.
// Tidak pernah memuat token/secret. Isi body tulis disimpan terpotong (maks. 4 KB) untuk penelusuran.
import fs from "node:fs";
import path from "node:path";

const MAX_BODY_CHARS = 4000;
const TAIL_BYTES = 512 * 1024;

export function createAudit(file) {
  function log(entry) {
    const rec = { waktu: new Date().toISOString(), ...entry };
    if (rec.body !== undefined) {
      const s = JSON.stringify(rec.body);
      rec.body = s.length > MAX_BODY_CHARS ? `${s.slice(0, MAX_BODY_CHARS)}…(dipotong)` : rec.body;
    }
    try {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(rec) + "\n", { mode: 0o600 });
    } catch (err) {
      console.error("Gagal menulis audit log:", err.message);
    }
  }

  /** Entri terbaru dulu. */
  function recent(limit = 100) {
    let text;
    try {
      const st = fs.statSync(file);
      const fd = fs.openSync(file, "r");
      const start = Math.max(0, st.size - TAIL_BYTES);
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      text = buf.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    } catch {
      return [];
    }
    return text.split("\n").filter(Boolean).slice(-limit).reverse().map((l) => {
      try { return JSON.parse(l); } catch { return { rusak: l.slice(0, 200) }; }
    });
  }

  return { log, recent };
}
