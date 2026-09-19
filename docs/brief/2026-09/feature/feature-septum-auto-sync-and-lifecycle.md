# Brief: Septum Lifecycle Automation (In-Process Auto-Sync & Standalone Refinement)

> **Kategori**: feature  
> **Status**: Completed  
> **Tanggal**: 2026-09-19  

---

## Overview & Problem Statement
- **Konteks & Alasan**: `septum` menyediakan deterministik Bounded-Context, Domain Catalog, dan Vertical Slice Tracing untuk mencegah *Context Poisoning* pada AI Coding Agent. Saat ini, `septum init` sudah men-generate template ke direktori `.agents/` dan menjalankan ingest awal. Namun, proses sinkronisasi perubahan file berikutnya masih bergantung pada pemanggilan manual CLI (`bun run bin/septum.ts ingest`), yang berisiko membuat basis data graph SQLite (`.septum/septum.db`) usang (*stale*) jika agent melakukan modifikasi kode di tengah sesi kerja.
- **Tujuan Utama**:
  1. Mengaktifkan **In-Process Auto-Sync (Background File Watcher)** saat MCP Server `septum serve` berjalan, sehingga setiap modifikasi atau penambahan file pada bounded-context otomatis ter-ingest secara inkremental ke SQLite SSOT.
  2. Menambahkan sub-command CLI eksplisit `septum sync` sebagai alias inkremental yang cepat untuk `ingest`.
  3. Memastikan output template generator `init` konsisten pada `.agents/` dan 100% **Standalone** tanpa ketergantungan pada `strata-mcp` atau tool eksternal lainnya saat di-publish ke npmjs.

---

## Scope & Boundaries
### In-Scope
- [ ] Implementasi in-process file watcher pada `src/mcp/server.ts` (atau wrapper `handleServeCommand`) untuk memantau perubahan file kode sumber dan memicu `IngestPipeline.processFile` secara debounced.
- [ ] Penambahan sub-command `septum sync` pada `bin/septum.ts` dan `src/cli/commands/sync.ts`.
- [ ] Penyempurnaan template `.agents/rules/septum-boundary.md` dan `.agents/hooks/septum-pre-write.sh` agar self-contained, idempotent, dan tahan terhadap konflik lingkungan.
- [ ] Penambahan post-write hook template (`.agents/hooks/septum-post-write.sh`) untuk trigger sync otomatis di lingkungan harness yang mendukung hook event.

### Out-of-Scope
- Mengubah skema basis data SQLite yang ada di `.septum/septum.db`.
- Memasukkan dependensi langsung terhadap `@dimassetoid/strata-mcp`.

---

## Spesifikasi Detail Pekerjaan

### 1. Daftar File yang Terlibat
1. `bin/septum.ts` (L15-L60): Pendaftaran perintah `sync` dan opsi flag `--watch` pada `serve`.
2. `src/cli/commands/sync.ts` (File Baru): Handler untuk sinkronisasi inkremental file yang berubah berdasarkan mtime/hash.
3. `src/mcp/server.ts` (L20-L80): Integrasi background watcher saat MCP Server stdio diaktifkan.
4. `src/cli/templates/hooks.ts` (L10-L50): Penambahan template `septum-post-write.sh`.
5. `src/cli/commands/init.ts` (L40-L90): Registrasi template post-write hook ke dalam folder `.agents/hooks/`.

### 2. Line Range Mapping (Presisi Target)
- `bin/septum.ts:L30-L75`: Penambahan branch CLI `case "sync":` dan help text.
- `src/mcp/server.ts:L35-L85`: Inisialisasi lifecycle watcher saat transport stdio aktif.
- `src/cli/commands/init.ts:L70-L115`: Penyimpanan template hook tambahan ke `.agents/hooks/`.

### 3. Urutan Pengerjaan
1. Buat modul `src/cli/commands/sync.ts` untuk eksekusi delta ingest file yang dimodifikasi.
2. Daftarkan perintah `sync` pada `bin/septum.ts`.
3. Pasang watcher non-blocking pada server MCP di `src/mcp/server.ts` yang memicu pembaruan graph SQLite saat berkas domain berubah.
4. Perbarui template generator pada `src/cli/templates/hooks.ts` dan `src/cli/commands/init.ts`.
5. Validasi integritas pengujian `bun test` untuk memastikan zero breaking changes pada MCP tool definitions.

### 4. Dampak & Risiko
- **Dampak Positif:** AI Agent selalu menerima data `septum_get_feature_context` dan `septum_trace_vertical_slice` yang mutakhir tanpa perlu memanggil ingest ulang secara manual.
- **Risiko Disk I/O:** Watcher harus mengecualikan direktori besar (`node_modules`, `.git`, `.septum`, `dist`, `.strata`) agar tidak membebani performa CPU/RAM saat agent bekerja.

---

## Acceptance Criteria (Given-When-Then)

- [ ] **Scenario 1 (CLI Inkremental Sync)**:
  - **Given**: Proyek sudah di-init dengan `septum init`.
  - **When**: Pengguna menjalankan `bun run bin/septum.ts sync`.
  - **Then**: Sistem memindai file yang berubah sejak ingest terakhir dan memperbarui tabel SQLite tanpa memproses ulang seluruh repositori.

- [ ] **Scenario 2 (Automated In-Process Sync via MCP Server)**:
  - **Given**: MCP server `septum serve` sedang berjalan.
  - **When**: Pengguna atau AI Agent mengedit berkas kode dalam sebuah domain terdaftar.
  - **Then**: Background watcher mendeteksi modifikasi dan memperbarui simbol di database SQLite secara transparan tanpa mengganggu respons stdio MCP.

- [ ] **Scenario 3 (Standalone & Zero Dependency Coupling)**:
  - **Given**: Paket `septum` diinstal secara terpisah di repositori tanpa `strata-mcp`.
  - **When**: Pengguna menjalankan `septum init`, `septum sync`, dan query MCP tools.
  - **Then**: Seluruh fungsionalitas berjalan normal dan tidak ada error modul yang hilang.

---

## Definition of Done (DoD) Checklist
- [ ] Sub-command `septum sync` terdaftar dan fungsional.
- [ ] In-process watcher pada `septum serve` berjalan non-blocking dan hemat resource.
- [ ] Generator `init` konsisten menulis ke `.agents/`.
- [ ] Seluruh test eksisting tetap lulus (`bun test`).
