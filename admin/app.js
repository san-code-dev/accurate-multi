// Logika halaman admin. Semua data ditampilkan lewat textContent (tidak pernah sebagai HTML).
(() => {
  const $ = (id) => document.getElementById(id);
  let csrf = null;
  let editing = null; // id tenant yang sedang diubah, null = tambah baru

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : String(c));
    return e;
  }

  function flash(text, kind = "ok") {
    const box = $("flash");
    box.replaceChildren(el("div", { class: `msg ${kind}` }, text));
    if (kind === "ok") setTimeout(() => box.replaceChildren(), 5000);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !url.endsWith("/login")) { showLogin(); throw new Error("Sesi habis, silakan masuk lagi."); }
    if (!res.ok) throw new Error(data.error || `Gagal (HTTP ${res.status})`);
    return data;
  }

  function showLogin() {
    csrf = null;
    $("app-view").classList.add("hidden");
    $("logout").classList.add("hidden");
    $("login-view").classList.remove("hidden");
    $("password").focus();
  }

  async function showApp() {
    $("login-view").classList.add("hidden");
    $("app-view").classList.remove("hidden");
    $("logout").classList.remove("hidden");
    await Promise.all([loadTenants(), loadAudit()]);
  }

  const badge = (text, cls) => el("span", { class: `badge ${cls}` }, text);

  async function loadTenants() {
    const { tenants, status } = await api("GET", "/admin/api/tenants");
    $("file-status").replaceChildren(status.error ? el("div", { class: "msg warn" }, status.error) : "");
    const body = $("tenants");
    body.replaceChildren();
    $("empty").classList.toggle("hidden", tenants.length > 0);
    for (const t of tenants) {
      const result = el("div", { class: "hint" });
      body.append(el("tr", {},
        el("td", {}, el("strong", {}, t.name), el("div", { class: "mono muted" }, t.id), t.description ? el("div", { class: "hint" }, t.description) : null),
        el("td", {},
          t.enabled ? badge("Aktif", "b-ok") : badge("Nonaktif", "b-off"),
          t.allowWrite ? badge("Baca + Tulis", "b-warn") : badge("Baca saja", "b-off")),
        el("td", { class: "mono" }, el("div", {}, `token ${t.token}`), el("div", {}, `secret ${t.secret}`), el("div", { class: "muted" }, t.sigEncoding)),
        el("td", { class: "actions" },
          el("button", { onclick: () => testTenant(t, result) }, "Uji koneksi"),
          el("button", { onclick: () => openForm(t) }, "Ubah"),
          el("button", { class: "danger", onclick: () => removeTenant(t) }, "Hapus"),
          result)));
    }
  }

  async function testTenant(t, out) {
    out.textContent = "Menguji…";
    try {
      const r = await api("POST", `/admin/api/tenants/${encodeURIComponent(t.id)}/test`);
      out.textContent = `Terhubung: ${r.database} (id ${r.database_id})`;
    } catch (err) {
      out.textContent = `Gagal: ${err.message}`;
    }
  }

  async function removeTenant(t) {
    if (!confirm(`Hapus tenant "${t.name}" (${t.id}) dari server ini?\n\nData di Accurate TIDAK ikut terhapus; hanya akses Claude ke database ini yang dicabut.`)) return;
    try {
      await api("DELETE", `/admin/api/tenants/${encodeURIComponent(t.id)}`);
      flash(`Tenant ${t.id} dihapus.`);
      await Promise.all([loadTenants(), loadAudit()]);
    } catch (err) { flash(err.message, "err"); }
  }

  function openForm(t) {
    editing = t ? t.id : null;
    $("form-title").textContent = t ? `Ubah tenant: ${t.name}` : "Tambah tenant";
    $("f-id").value = t?.id ?? "";
    $("f-name").value = t?.name ?? "";
    $("f-desc").value = t?.description ?? "";
    $("f-token").value = "";
    $("f-secret").value = "";
    $("f-token").required = !t;
    $("f-secret").required = !t;
    $("token-hint").textContent = t ? `(kosongkan = tetap ${t.token})` : "";
    $("secret-hint").textContent = t ? `(kosongkan = tetap ${t.secret})` : "";
    $("f-enc").value = t?.sigEncoding ?? "base64";
    $("f-enabled").checked = t ? t.enabled : true;
    $("f-write").checked = t ? t.allowWrite : false;
    $("form-card").classList.remove("hidden");
    $("form-card").scrollIntoView({ behavior: "smooth" });
    $("f-id").focus();
  }

  function closeForm() {
    editing = null;
    $("tenant-form").reset();
    $("form-card").classList.add("hidden");
  }

  async function submitForm(ev) {
    ev.preventDefault();
    const wantWrite = $("f-write").checked;
    if (wantWrite && !confirm("Izinkan Claude MENAMBAH dan MENGUBAH data di database Accurate ini?\n\nPerubahan langsung masuk ke data asli Accurate.")) return;
    const body = {
      id: $("f-id").value.trim(), name: $("f-name").value.trim(), description: $("f-desc").value.trim(),
      token: $("f-token").value, secret: $("f-secret").value, sigEncoding: $("f-enc").value,
      enabled: $("f-enabled").checked, allowWrite: wantWrite,
    };
    try {
      const r = editing
        ? await api("PUT", `/admin/api/tenants/${encodeURIComponent(editing)}`, body)
        : await api("POST", "/admin/api/tenants", body);
      flash(`Tenant ${r.id} disimpan. Langsung berlaku tanpa restart.`);
      closeForm();
      await Promise.all([loadTenants(), loadAudit()]);
    } catch (err) { flash(err.message, "err"); }
  }

  function describe(e) {
    if (e.jenis === "tulis") {
      const r = e.hasil ? ` → ${e.hasil}` : "";
      return `${e.ok ? "Berhasil" : "Gagal"}: ${e.path}${r}${e.error ? ` (${e.error})` : ""}`;
    }
    const parts = [e.aksi];
    if (e.id_lama) parts.push(`dari ${e.id_lama}`);
    if (e.boleh_tulis !== undefined) parts.push(e.boleh_tulis ? "boleh tulis" : "baca saja");
    if (e.aktif === false) parts.push("nonaktif");
    if (e.ganti_token) parts.push("token diganti");
    if (e.ganti_secret) parts.push("secret diganti");
    if (e.ip) parts.push(`ip ${e.ip}`);
    return parts.join(" · ");
  }

  async function loadAudit() {
    const { entries } = await api("GET", "/admin/api/audit?limit=100");
    const body = $("audit");
    body.replaceChildren();
    if (!entries.length) body.append(el("tr", {}, el("td", { colspan: "4", class: "muted" }, "Belum ada catatan.")));
    for (const e of entries) {
      body.append(el("tr", {},
        el("td", { class: "mono" }, e.waktu ? new Date(e.waktu).toLocaleString("id-ID") : "-"),
        el("td", {}, e.jenis === "tulis" ? badge("Tulis", e.ok ? "b-warn" : "b-off") : badge("Admin", "b-off")),
        el("td", { class: "mono" }, e.tenant ?? "-"),
        el("td", {}, describe(e))));
    }
  }

  $("login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const r = await api("POST", "/admin/api/login", { password: $("password").value });
      csrf = r.csrf;
      $("password").value = "";
      $("flash").replaceChildren();
      await showApp();
    } catch (err) { flash(err.message, "err"); }
  });
  $("logout").addEventListener("click", async () => { try { await api("POST", "/admin/api/logout"); } catch {} showLogin(); });
  $("add").addEventListener("click", () => openForm(null));
  $("cancel").addEventListener("click", closeForm);
  $("tenant-form").addEventListener("submit", submitForm);
  $("reload-audit").addEventListener("click", () => loadAudit().catch((err) => flash(err.message, "err")));

  api("GET", "/admin/api/session")
    .then((s) => { if (s.loggedIn) { csrf = s.csrf; return showApp(); } showLogin(); })
    .catch(() => showLogin());
})();
