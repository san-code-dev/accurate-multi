# Accurate Online MCP Server — Multi-Tenant (Read-Only)

MCP server untuk membaca data **beberapa database Accurate Online sekaligus** (multi-tenant) dari Claude atau klien MCP lain.
Satu tenant = satu database Accurate = satu API token + signature secret.

- **Read-only mutlak**: hanya endpoint baca resmi (HTTP `GET`, scope `*_view`). Tidak ada jalur untuk menambah, mengubah, atau menghapus data.
- **Penghubung murni**: server tidak menghitung dan tidak menulis file. Semua perhitungan dilakukan oleh AI.
- **Tenant dikelola lewat satu file JSON**, dimuat ulang otomatis saat diubah (tanpa restart).
- **Satu token MCP bersama**: semua pengguna yang terhubung bisa membaca semua tenant aktif.

---

## Tools MCP

| Tool | Fungsi |
|---|---|
| `list_tenants` | Daftar tenant (id dan nama). Tidak pernah menampilkan token/secret. |
| `check_connection` | Cek token & signature satu tenant, serta nama database yang terhubung. |
| `search_endpoints` | Cari endpoint baca Accurate (berlaku untuk semua tenant). |
| `accurate_get` | Ambil data dari satu tenant. Mendukung semua halaman sekaligus via `all_pages`. |

Parameter `tenant` wajib diisi bila ada lebih dari satu tenant aktif; bila hanya satu, boleh dikosongkan.
Setiap hasil `accurate_get` mencantumkan `tenant` asalnya.

---

## Mengatur tenant (`config/tenants.json`)

Salin `config/tenants.example.json` menjadi `config/tenants.json`, lalu isi:

```json
{
  "tenants": [
    { "id": "pt-contoh", "name": "PT Contoh Sejahtera", "token": "API_TOKEN", "secret": "SIGNATURE_SECRET" },
    { "id": "cv-cabang", "name": "CV Cabang Makmur", "token": "API_TOKEN_LAIN", "secret": "SIGNATURE_SECRET", "enabled": false }
  ]
}
```

| Kolom | Keterangan |
|---|---|
| `id` | Huruf kecil, angka, tanda minus (maks. 40). Dipakai sebagai parameter `tenant`. |
| `name`, `description` | Nama tampilan dan deskripsi (opsional). |
| `token` | API Token Accurate untuk database tersebut. |
| `secret` | Signature Secret aplikasi di Accurate Developer. |
| `sigEncoding` | `base64` (default) atau `hex`. |
| `enabled` | `false` untuk menonaktifkan tanpa menghapus. |

- File dibaca ulang otomatis saat berubah. Bila isinya tidak valid (JSON rusak, id ganda, token kosong), **konfigurasi lama yang valid tetap dipakai** dan errornya tampil di log serta di `list_tenants`.
- `config/tenants.json` berisi kredensial: sudah di-`.gitignore`, **jangan di-commit atau dibagikan**.

### Mendapatkan API Token per database
API Token Accurate selalu terikat pada **satu** database. Untuk setiap database yang ingin ditambahkan:
1. Di [Accurate Developer](https://account.accurate.id/developer): buat/pilih aplikasi, aktifkan API Token, catat **Signature Secret**.
2. Buka database tersebut sebagai Administrator → **Pengaturan → Accurate Store → Aplikasi Saya → Install Aplikasi** (isi App Key).
3. **Accurate Store → API Token → Buat API Token**, sebaiknya dari user dengan hak akses lihat saja dan **hanya scope `*_view`**.

---

## Menjalankan

### Docker (disarankan, otomatis jalan saat komputer hidup)
```bash
docker compose up -d --build
```
- `restart: unless-stopped`: jalan lagi otomatis setiap komputer/Docker Desktop hidup, kecuali dihentikan manual.
- Folder `config/` dipasang read-only ke container, jadi perubahan `tenants.json` langsung terbaca tanpa restart.
- Kredensial tidak masuk ke image. `.env` dibaca dengan `format: raw` agar nilai yang mengandung `$` tidak terpotong.

| Perintah | Fungsi |
|---|---|
| `docker compose stop` / `start` | Hentikan / jalankan lagi |
| `docker compose up -d --build` | Bangun ulang setelah kode atau `.env` diubah |
| `docker compose logs -f` | Lihat log (termasuk tenant yang dimuat) |

### Tanpa Docker
```bash
npm install
cp .env.example .env                                  # isi MCP_AUTH_TOKEN
cp config/tenants.example.json config/tenants.json    # isi tenant
npm start                                             # HTTP, port dari .env (default 3031)
npm run start:stdio                                   # stdio, untuk satu komputer
```

`.env`: `MCP_AUTH_TOKEN` (wajib di mode HTTP), `PORT` (default `3031`), `HOST`, `TENANTS_FILE` (default `config/tenants.json`).
Untuk akses dari komputer lain: `HOST=0.0.0.0` (Docker sudah otomatis) dan buka port di Windows Firewall.

---

## Menghubungkan Claude

**Komputer lain (tanpa instal Node.js)**: buat paket ekstensi lalu bagikan file `.mcpb`-nya.
```bash
npx @anthropic-ai/mcpb pack extension extension/dist/accurate-multi.mcpb
```
Di Claude Desktop: klik dua kali file tersebut → **Install** → isi alamat server (mis. `http://192.168.10.65:3031/mcp`) dan token MCP.

**Atau lewat mcp-remote** (`claude_desktop_config.json`, perlu Node.js):
```json
"accurate-multi": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "http://192.168.10.65:3031/mcp", "--allow-http", "--header", "Authorization:${AUTH_HEADER}"],
  "env": { "AUTH_HEADER": "Bearer TOKEN_MCP" }
}
```

---

## Keamanan

1. Klien HTTP tidak punya jalur tulis: semua request data `GET`; satu-satunya `POST` adalah cek token `api-token.do`.
2. Endpoint harus terdaftar di spesifikasi OpenAPI resmi Accurate sebagai `GET` dengan scope `*_view` saja.
3. Nama operasi tulis (`save`, `delete`, `update`, `approve`, ...) dan parameter pengganti metode (`_method`, ...) ditolak.
4. Host dikunci ke `*.accurate.id` (HTTPS); redirect ke host lain ditolak.
5. Token/secret tidak pernah ditampilkan: `list_tenants` hanya id dan nama, dan token yang disebut ulang di pesan error Accurate disamarkan.
6. Batas paralel dihitung per tenant (sesuai kuota Accurate per token).
7. **Wajib dari sisi Anda**: API Token dari user hak akses lihat saja dengan scope `*_view`, dan `MCP_AUTH_TOKEN` yang panjang dan acak.

Karena memakai satu token MCP bersama, siapa pun yang memegang token itu bisa membaca **semua** tenant. Ganti `MCP_AUTH_TOKEN` bila ada yang tidak lagi berhak.

## Batasan
- Respons di atas 100.000 karakter ditolak (bukan dipotong); pakai `fields` seperlunya dan persempit periode.
- `all_pages` maks. 50 halaman (±5.000 baris) per panggilan; data lebih besar diambil per periode.
- Hasil perhitungan AI (rekap, laba rugi) harus dicocokkan dengan laporan resmi Accurate sebelum dipakai untuk keputusan bisnis, audit, atau pajak.

## Disclaimer
Proyek independen, tidak berafiliasi dengan PT Cipta Piranti Sejahtera (CPSSoft) / Accurate Online. Disediakan "sebagaimana adanya" tanpa jaminan.
