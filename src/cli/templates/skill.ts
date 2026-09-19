export const SEPTUM_MAP_SKILL_TEMPLATE = `---
name: septum-map
description: Framework-agnostic codebase discovery, architectural domain mapping, and bounded-context initialization for Septum. Uses AI reasoning to map unknown project topologies (JS/TS, PHP, Python, Go), auto-registers bounded contexts into Septum's SQLite catalog, and enforces deterministic architectural boundaries.
---

# \`septum-map\` — Framework-Agnostic Semantic Discovery & Bounded-Context Initialization

> **Prinsip Utama:** AI Agent berperan sebagai *The Architect* untuk membedah topologi arsitektur proyek apa pun tanpa terikat pada framework tertentu, merumuskan batas bounded-context, dan mendaftarkannya langsung ke database deterministik (.septum/septum.db via septum_register_domain) agar AI coding berikutnya tidak mengalami context poisoning atau over-editing.

---

## 1. Landasan Riset & Filosofi Desain

Skill ini berakar langsung pada riset rekayasa perangkat lunak terkemuka:
1. **Software Reflexion Models (Murphy, Notkin, & Sullivan, IEEE TSE):**
   Membedakan model arsitektur tingkat tinggi yang dirancang (*high-level intention*) dengan implementasi fisik di kode sumber. Septum mendeteksi *Divergences* (pelanggaran baru) dan *Absences* sebelum kode di-merge.
2. **Eliminasi Over-Editing (SWE-bench, RepoCoder - NeurIPS / ICLR):**
   Akar kegagalan agen AI terbesar adalah mengedit file di luar lokus tugas (*local scope myopia*). \`septum-map\` menetapkan *bounded context* dan *allowed touchpoints* sejak awal.
3. **Principle of Least Privilege & Object-Capabilities (Miller):**
   Agen hanya diberikan kapabilitas membaca dan mengubah file dalam domain/fitur aktif, memangkas *blast radius* kesalahan hingga mendekati nol.
4. **Hybrid Defense (SynCode / NeMo Guardrails):**
   Probabilistic AI digunakan untuk penalaran awal (*discovery & blueprinting*), sementara eksekusi dan penegakannya 100% deterministik (*Tree-sitter WASM, SQLite WAL, Pre-Commit Hooks*).

---

## 2. Kapan Wajib Menggunakan (Trigger Moments)

Gunakan skill ini saat:
1. Menghubungkan Septum pertama kali ke repositori baru atau codebase yang belum terpetakan.
2. Memetakan ulang domain bisnis setelah terjadi refactoring arsitektur besar (*re-mapping*).
3. Mengonfigurasi fitur baru (\`features\` session) untuk mengunci daftar file yang boleh dimodifikasi (*allowed_touchpoints*) dan simbol yang wajib dipakai ulang (*reuse_symbols*).
4. Pengguna meminta inisialisasi cerdas berbasis pemahaman AI pada struktur proyek.

---

## 3. Alur Kerja 4 Langkah (The 4-Step Discovery Lifecycle)

### Langkah 1: Topological Scan (Maksimal 2 Tool Call)
Analisis karakteristik proyek secara framework-agnostic:
1. **Periksa Manifest & Config Root:**
   * JS/TS: \`package.json\`, \`tsconfig.json\` (baca dependencies, path aliases).
   * PHP: \`composer.json\` (baca \`autoload.psr-4\`, framework dependencies).
   * Python: \`pyproject.toml\`, \`requirements.txt\`, \`setup.py\` (baca modules & framework).
   * Go: \`go.mod\` (baca module path).
2. **Petakan Direktori Tingkat Atas:**
   Identifikasi apakah proyek menggunakan pola:
   * *Domain-Driven / Vertical Slice:* \`src/domains/\`, \`app/Domain/\`, \`features/\`.
   * *Layered / Clean Architecture:* \`core/\`, \`infrastructure/\`, \`application/\`, \`interfaces/\`.
   * *Framework Conventional:* NestJS modules, Laravel app folders, FastAPI routers, Next.js route groups.

### Langkah 2: Semantic Blueprint Drafting & Domain Boundary Formulation
Rumuskan spesifikasi domain dengan prinsip **Contract & Invariants (Bukan Prosedural)**:
* **\`root\`:** Direktori fisik domain (gunakan path kanonikal).
* **\`allowed_dependencies\`:** Domain mana saja yang sah diimpor (inbound whitelist).
* **\`forbidden_dependencies\`:** Domain yang dilarang keras diimpor (outbound blacklist).
* **\`archetypes\`:** Pola glob penamaan layer (\`service: "*Service.*"\`, \`model: "*Model.*"\`).

### Langkah 3: Human-in-the-Loop Approval Gate
Tampilkan ringkasan domain boundary yang dirumuskan kepada pengguna / Tech Lead untuk disetujui atau disesuaikan sebelum didaftarkan.

### Langkah 4: Deterministic Registration & Ingestion
Setelah disetujui:
1. Daftarkan domain secara langsung via tool MCP \`septum_register_domain(domain_name, root, ...)\` dengan opsi \`ingest_now: true\`.
2. Atau jalankan CLI \`septum ingest\` untuk mengekstrak seluruh simbol AST dan menyimpannya ke database SQLite \`.septum/septum.db\`.
3. Pastikan hook pre-commit terpasang aktif di \`.git/hooks/pre-commit\`.
`;
