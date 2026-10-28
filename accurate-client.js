// Klien HTTP Accurate Online (API Token). Dirancang READ-ONLY di level paling bawah:
//  - tidak ada parameter "method": semua request data adalah HTTP GET ke /accurate/api/*,
//  - satu-satunya POST adalah api-token.do (cek token & cari host), URL-nya tetap dan tanpa body,
//  - semua URL (termasuk host hasil api-token.do dan target redirect 308) wajib berada di domain accurate.id,
//  - setiap path dicek bentuknya oleh readonly-guard,
//  - fungsi request internal tidak diekspor, sehingga kode lain tidak bisa mengirim request selain di atas.
import crypto from "node:crypto";
import { assertSafeShape } from "./readonly-guard.js";

const RETRY_STATUS = new Set([429, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createAccurateClient(opts) {
  const {
    token,
    secret,
    sigEncoding = "base64",
    accountApi = "https://account.accurate.id/api",
    allowedHostSuffixes = [".accurate.id"],
    allowInsecureHttp = false, // hanya untuk pengujian lokal
    timeoutMs = 20_000,
    maxParallel = 4, // batas Accurate: 8 per detik / 8 paralel
    hostTtlMs = 12 * 60 * 60 * 1000,
    retries = 3, // hanya untuk GET (aman diulang): 429/502/503/504 dan gangguan jaringan
    retryBaseMs = 1000,
  } = opts;
  if (!token || !secret) throw new Error("token dan secret wajib diisi");

  const tokenCheckUrl = `${accountApi}/api-token.do`;
  const redact = (text) => [token, secret].reduce((t, v) => (v && v.length >= 8 ? t.split(v).join("[disembunyikan]") : t), String(text));

  function assertAccurateUrl(u) {
    const url = u instanceof URL ? u : new URL(u);
    if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
      throw new Error(`Diblokir: protokol tidak diizinkan (${url.protocol})`);
    }
    const ok = allowedHostSuffixes.some((s) => url.hostname === s.replace(/^\./, "") || url.hostname.endsWith(s));
    if (!ok) throw new Error(`Diblokir: host '${url.hostname}' bukan host Accurate yang diizinkan.`);
    if (url.username || url.password) throw new Error("Diblokir: URL berisi kredensial.");
    return url;
  }

  function authHeaders() {
    const timestamp = Date.now().toString(); // epoch milidetik (format yang diterima Accurate)
    const signature = crypto.createHmac("sha256", secret).update(timestamp).digest(sigEncoding);
    return {
      Authorization: `Bearer ${token}`,
      "X-Api-Timestamp": timestamp,
      "X-Api-Signature": signature,
      Accept: "application/json",
    };
  }

  let active = 0;
  const waiters = [];
  async function withSlot(fn) {
    if (active >= maxParallel) await new Promise((resolve) => waiters.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiters.shift()?.();
    }
  }

  let cachedHost = null;

  // Internal. method hanya bisa "GET", atau "POST" khusus untuk tokenCheckUrl (dicek ulang di sini).
  async function send(url, method, query = {}) {
    if (method !== "GET" && !(method === "POST" && url === tokenCheckUrl)) {
      throw new Error("Diblokir: hanya HTTP GET yang diizinkan (server read-only).");
    }
    let target = assertAccurateUrl(url);
    for (const [k, v] of Object.entries(query)) target.searchParams.set(String(k), String(v));

    return withSlot(async () => {
      for (let attempt = 0; ; attempt++) {
        const canRetry = method === "GET" && attempt < retries;
        let res;
        try {
          for (let hop = 0; hop < 3; hop++) {
            res = await fetch(target, {
              method,
              headers: authHeaders(), // ditandatangani ulang tiap percobaan
              redirect: "manual",
              signal: AbortSignal.timeout(timeoutMs),
            });
            if (res.status === 308 && res.headers.get("location")) {
              // Host berubah. Ikuti hanya jika tujuan tetap domain Accurate (token tidak boleh bocor ke host lain).
              target = assertAccurateUrl(new URL(res.headers.get("location"), target));
              cachedHost = null;
              continue;
            }
            break;
          }
        } catch (err) {
          if (String(err?.message).startsWith("Diblokir") || !canRetry) throw err;
          await sleep(retryBaseMs * 2 ** attempt);
          continue;
        }
        if (res.status === 308) throw new Error("Terlalu banyak redirect 308 dari Accurate.");
        if (res.status >= 300 && res.status < 400) {
          throw new Error(`Diblokir: redirect HTTP ${res.status} tidak diikuti.`);
        }
        if (RETRY_STATUS.has(res.status) && canRetry) {
          await res.body?.cancel();
          await sleep(retryBaseMs * 2 ** attempt);
          continue;
        }

        const text = await res.text();
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error(`Respons bukan JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
        }
        if (!res.ok || body?.s === false) {
          // Accurate kadang menyebut ulang token di pesan error (mis. "Invalid access token: aat...."); sembunyikan
          // agar token/secret tidak pernah ikut terkirim ke AI atau log.
          const detail = redact(Array.isArray(body?.d) ? body.d.join("; ") : JSON.stringify(body).slice(0, 300));
          throw new Error(`Accurate error (HTTP ${res.status}): ${detail}`);
        }
        return body;
      }
    });
  }

  async function getHost(force = false) {
    if (cachedHost && !force && Date.now() - cachedHost.at < hostTtlMs) return cachedHost;
    const body = await send(tokenCheckUrl, "POST");
    const d = body?.d ?? {};
    // Dokumentasi menulis "data usaha"; cari juga nama lain agar tahan terhadap perbedaan penamaan.
    const usaha =
      d["data usaha"] ?? d.database ?? Object.values(d).find((v) => v && typeof v === "object" && typeof v.host === "string");
    if (!usaha?.host) {
      throw new Error(`Host tidak ditemukan di respons api-token.do. Kunci pada "d": [${Object.keys(d).join(", ")}]`);
    }
    assertAccurateUrl(usaha.host);
    cachedHost = {
      host: usaha.host,
      alias: usaha.alias ?? null,
      databaseId: usaha.id ?? null,
      user: d.user?.email ?? null,
      at: Date.now(),
    };
    return cachedHost;
  }

  /** path relatif, mis. "glaccount/list.do". Selalu GET. */
  async function api(path, query = {}) {
    assertSafeShape(path);
    const { host } = await getHost();
    return send(`${host}/accurate/api/${path}`, "GET", query);
  }

  return { getHost, api };
}
