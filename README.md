# Accurate Online MCP Server — Multi-Tenant (Baca + Tulis)

MCP server untuk **beberapa database Accurate Online sekaligus** (multi-tenant) dari Claude atau klien MCP lain,
dengan **halaman admin web** untuk mengelola tenant. Satu tenant = satu database Accurate = satu API token + signature secret.

- **Baca** semua tenant aktif (endpoint resmi HTTP `GET`, scope `*_view`).
- **Tulis: tambah & ubah** (endpoint resmi HTTP `POST`, scope `*_save`) hanya pada tenant yang diizinkan admin. Bawaan: **mati**.
- **Hapus tidak pernah diizinkan**: endpoint `*_delete`, metode HTTP `DELETE`, dan penghapusan baris rincian (`_status: "delete"`) diblokir.
- **Halaman admin** untuk menambah/mengubah/menonaktifkan tenant dan mengatur izin tulis, hanya bisa dibuka dari komputer server.
- **Catatan audit** untuk setiap penulisan ke Accurate dan setiap perubahan di halaman admin.
- **Satu token MCP bersama**: semua pengguna yang terhubung bisa membaca semua tenant aktif dan menulis ke tenant yang diizinkan.

---

## Tools MCP

| Tool | Fungsi |
|---|---|
| `list_tenants` | Daftar tenant: id, nama, dan `boleh_tulis`. Tidak pernah menampilkan token/secret. |
| `check_connection` | Cek token & signature satu tenant, serta nama database yang terhubung. |
| `search_endpoints` | Cari endpoint `baca` / `tulis`. Dengan `path`: parameter (baca) atau field isi beserta yang wajib (tulis). |
| `accurate_get` | Ambil data dari satu tenant. Mendukung semua halaman sekaligus via `all_pages`. |
| `accurate_write` | Tambah/ubah data di satu tenant yang `boleh_tulis`. Wajib `dikonfirmasi: true` setelah pengguna menyetujui isinya. |

Parameter `tenant` wajib diisi bila ada lebih dari satu tenant aktif. `accurate_write` tidak ditandai read-only, sehingga
klien MCP (mis. Claude) meminta izin pengguna sebelum menjalankannya.

### Pengaman penulisan
1. Izin tulis per tenant, bawaan mati, diatur di halaman admin (dengan konfirmasi).
2. Hanya endpoint `POST` yang semua scope-nya `*_save` di spesifikasi resmi Accurate (±116 endpoint: `save.do`, `bulk-save.do`, dll.).
3. Nama operasi berbau hapus (`delete`, `remove`, `void`, ...) dan `_status: "delete"` di isi ditolak.
4. Isi dibatasi: objek JSON, maks. 256 KB, maks. 8 tingkat, tanpa kunci berbahaya (`__proto__`, `_method`, ...).
5. Penulisan **tidak pernah diulang otomatis** (mencegah data ganda bila koneksi putus).
6. Claude diinstruksikan menampilkan isi yang akan dikirim dan meminta persetujuan pengguna sebelum menulis.
7. Setiap penulisan (berhasil/gagal) dicatat di `data/audit.log` beserta isi (dipotong 4 KB) dan nomor/id hasilnya.

---

## Halaman admin

Buka **di komputer server**: <http://127.0.0.1:3032/admin>, masuk dengan `ADMIN_PASSWORD` dari `.env`.

- Tambah, ubah (termasuk ganti id), nonaktifkan, dan hapus tenant. Perubahan langsung berlaku tanpa restart.
- Saat mengubah, kosongkan token/secret untuk tetap memakai yang lama. Token/secret tidak pernah dikirim balik ke browser (hanya 4 karakter terakhir).
- **Uji koneksi** per tenant: menampilkan nama database Accurate yang terhubung.
- Saklar **Boleh TULIS** per tenant.
- **Catatan audit**: 100 entri terbaru.
- Menghapus tenant di sini hanya mencabut akses server ke database itu; data di Accurate tidak terhapus.

Keamanan halaman admin: port terpisah (`3032`) yang di Docker hanya dipetakan ke `127.0.0.1`; password min. 12 karakter;
kunci 15 menit per IP setelah 5 kali salah; cookie sesi `HttpOnly` + `SameSite=Strict`, habis setelah 8 jam tidak aktif;
token CSRF dan pemeriksaan `Origin` untuk setiap perubahan; Content-Security-Policy ketat.

Tenant juga bisa diatur manual di `data/tenants.json` (format: `tenants.example.json`); file dibaca ulang otomatis.
Bila isinya tidak valid, konfigurasi lama yang valid tetap dipakai dan errornya tampil di halaman admin.

### Mendapatkan API Token per database
API Token Accurate selalu terikat pada **satu** database. Untuk setiap database:
1. Di [Accurate Developer](https://account.accurate.id/developer): buat/pilih aplikasi, aktifkan API Token, catat **Signature Secret**.
2. Buka database tersebut sebagai Administrator → **Pengaturan → Accurate Store → Aplikasi Saya → Install Aplikasi** (isi App Key).
3. **Accurate Store → API Token → Buat API Token**. Untuk tenant baca saja: pilih hanya scope `*_view`. Untuk tenant yang
   boleh tulis: tambahkan scope `*_save` modul yang diperlukan saja, dan **jangan pilih scope `*_delete`**.

---

## Menjalankan

### Docker (disarankan, otomatis jalan saat komputer hidup)
```bash
docker compose up -d --build
```
- `restart: unless-stopped`: jalan lagi otomatis setiap komputer/Docker Desktop hidup, kecuali dihentikan manual.
- Folder `data/` (tenant + audit) dipasang dari komputer server; kredensial tidak masuk ke image.
- Port MCP `3031` terbuka untuk jaringan kantor; port admin `3032` hanya `127.0.0.1`.
- `.env` dibaca dengan `format: raw` agar nilai yang mengandung `$` tidak terpotong.

| Perintah | Fungsi |
|---|---|
| `docker compose stop` / `start` | Hentikan / jalankan lagi |
| `docker compose up -d --build` | Bangun ulang setelah kode atau `.env` diubah |
| `docker compose logs -f` | Lihat log |

### Tanpa Docker
```bash
npm install
cp .env.example .env     # isi MCP_AUTH_TOKEN dan ADMIN_PASSWORD
npm start                # MCP di port 3031, admin di 127.0.0.1:3032
npm run start:stdio      # stdio untuk satu komputer (tanpa halaman admin)
```

| Variabel `.env` | Keterangan |
|---|---|
| `MCP_AUTH_TOKEN` | Wajib di mode HTTP. Token Bearer untuk klien MCP. |
| `ADMIN_PASSWORD` | Wajib untuk halaman admin, min. 12 karakter. Tanpa ini admin tidak dijalankan. |
| `PORT`, `HOST` | MCP (default `3031`, `127.0.0.1`; Docker otomatis `0.0.0.0`). |
| `ADMIN_PORT`, `ADMIN_HOST` | Admin (default `3032`, `127.0.0.1`). |
| `TENANTS_FILE`, `AUDIT_FILE` | Default `data/tenants.json`, `data/audit.log`. |

Untuk akses MCP dari komputer lain: buka port `3031` di Windows Firewall. **Jangan** buka port `3032`.

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

## Keamanan lain
1. Klien HTTP hanya mengirim `GET` (baca), `POST` JSON (tulis, bila diizinkan), dan `POST` cek token `api-token.do`. Tidak pernah `DELETE`/`PUT`/`PATCH`.
2. Host dikunci ke `*.accurate.id` (HTTPS); redirect ke host lain ditolak.
3. Token/secret yang disebut ulang di pesan error Accurate disamarkan.
4. Batas paralel dihitung per tenant (sesuai kuota Accurate per token).
5. **Wajib dari sisi Anda**: `MCP_AUTH_TOKEN` dan `ADMIN_PASSWORD` yang panjang dan acak; folder `data/` dan `.env` tidak dibagikan.

Karena memakai satu token MCP bersama, siapa pun yang memegang token itu bisa membaca **semua** tenant dan menulis ke tenant yang
diizinkan. Ganti `MCP_AUTH_TOKEN` bila ada yang tidak lagi berhak.

## Batasan
- Respons di atas 100.000 karakter ditolak (bukan dipotong); pakai `fields` seperlunya dan persempit periode.
- `all_pages` maks. 50 halaman (±5.000 baris) per panggilan.
- Penulisan tidak bisa dibatalkan dari server ini; koreksi dilakukan dengan penulisan baru atau langsung di Accurate.
- Hasil perhitungan AI harus dicocokkan dengan laporan resmi Accurate sebelum dipakai untuk keputusan bisnis, audit, atau pajak.

## Disclaimer
Proyek independen, tidak berafiliasi dengan PT Cipta Piranti Sejahtera (CPSSoft) / Accurate Online. Disediakan "sebagaimana adanya" tanpa jaminan.
