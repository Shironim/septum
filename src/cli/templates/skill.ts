export const SEPTUM_MAP_SKILL_TEMPLATE = `---
name: septum-map
description: Framework-agnostic codebase discovery, multi-language AST symbol & file-connection mapping, and bounded-context governance for Septum. Uses Tree-Sitter WASM (TS/JS/TSX, PHP, Python, Go, Rust, Java, C#, Ruby + Vue/Svelte/Astro/Blade) and SQLite SSOT (.septum/septum.db) to prevent symbol duplication, map file integrations, and enforce architectural boundaries.
---

# \`septum-map\` — Multi-Language AST Discovery, File Connectivity & Bounded-Context Governance

> **Prinsip Utama:** Septum memetakan setiap fungsi, class, method, struct/interface, dan variabel/konstanta di file backend beserta keterhubungan dua arah antar-file (\`imports_from\` & \`imported_by\`) ke dalam SQLite SSOT (\`.septum/septum.db\`). Dengan peta deterministik ini, AI Agent **tidak boleh menduplikasi simbol yang sudah ada** dan wajib menjaga integritas batas domain (*bounded-context*) serta mencegah *circular dependency*.

---

## 1. Landasan Arsitektur & Pencegahan Duplikasi

1. **Anti-Symbol Duplication (Peta Simbol & Keterhubungan File):**
   Setiap file yang diindeks oleh mesin \`web-tree-sitter\` Septum memiliki daftar simbol terstruktur (\`class\`, \`interface\`, \`struct\`, \`trait\`, \`enum\`, \`function\`, \`method\`, \`type\`, \`constant\`, \`variable\`) serta graf koneksi dua arah (\`connections.imports_from\` dan \`connections.imported_by_count\`). Agen wajib memeriksa peta ini sebelum membuat fungsi, class, atau variabel baru.
2. **Software Reflexion Models & Boundary Enforcement:**
   Septum memvalidasi rencana perubahan kode terhadap aturan \`allowed_dependencies\`, \`forbidden_dependencies\`, \`allowed_touchpoints\`, dan mendeteksi siklus dependensi (\`circular_dependency\`) baik per-file maupun lintas-domain.
3. **Token-Budgeted Context (< 400 Tokens Default):**
   Katalog domain secara default disajikan dalam mode ringkas (\`detail_level: "compact"\`) agar agen memperoleh topologi file, rentang baris (\`line_span\`), jumlah method/property, dan koneksi antar-file tanpa membanjiri jendela konteks.

---

## 2. Referensi Cepat 5 Unified Tools MCP Septum (Standardized \`snake_case\` Contracts)

| Tool MCP | Parameter Utama (\`snake_case\`) | Fungsi & Kapan Digunakan |
|---|---|---|
| **\`septum_domain\`** | \`{ action?: "catalog"\\|"register"\\|"topology", domain?, detail_level?: "compact"\\|"full", archetype_filter?, file_filter?, root?, allowed_dependencies?, forbidden_dependencies?, ingest_now?, resolve?, resolve_node? }\` | Mengelola arsitektur makro, topologi domain, pendaftaran bounded-context, dan plane infrastruktur 6-layer. Default \`action: "catalog"\` (< 400 token). |
| **\`septum_symbol\`** | \`{ action?: "locate"\\|"inspect"\\|"impact"\\|"hotspots", query?, symbol?, domain?, include_dependencies?: true, min_lines?: 30, min_nesting?, sort_by?: "risk_score", limit?: 10 }\` | Unified Symbol Engine: mencari simbol (\`locate\`), inspeksi detail kontrak & signature (\`inspect\`), hitung blast radius & pemanggil (\`impact\`), atau isolasi fungsi kompleks & SRP smell (\`hotspots\`). |
| **\`septum_slice\`** | \`{ query, max_depth?: 5 }\` | Menelusuri alur eksekusi end-to-end (\`Ingress ➔ Validation ➔ Controller ➔ Service ➔ Repository ➔ Entity\`). \`max_depth\` default \`5\`, rentang \`1..8\` (gunakan \`6..8\` untuk deep trace Event/Job/Queue). |
| **\`septum_boundary\`** | \`{ scope?: "file"\\|"all"\\|"staged"\\|"domain", file_path?, file_paths?, proposed_imports?, feature_key?, domain? }\` | Pre-flight boundary check memvalidasi \`proposed_imports\` sebelum menulis file, serta audit repo-wide atau git-staged untuk mencegah pelanggaran batas domain dan *circular dependency*. |
| **\`septum_feature\`** | \`{ action?: "get"\\|"lock"\\|"release", feature_key?, domain?, allowed_touchpoints?, reuse_symbols?, force? }\` | Mengelola konteks fitur: ambil detail fitur (\`get\`), kunci sesi touchpoint di \`.septum/session.json\` (\`lock\`), atau lepaskan kunci sesi (\`release\`). |

---

## 3. Alur Kerja Pemetaan & Inisialisasi Domain (The 4-Step Lifecycle)

> [!NOTE] Zero-Config Default (\`septum init\`)
> Menjalankan \`septum init\` di terminal secara otomatis mendeteksi bahasa & framework (TS/JS, PHP/Laravel, Python, Go, Rust, Java, C#, Ruby), mendaftarkan domain ke \`.septum/septum.db\`, mengindeks AST via Tree-Sitter WASM, dan memasang hook di \`.agents/\`.

Gunakan alur 4 langkah ini saat merancang domain baru, melakukan *re-mapping* arsitektur, atau mengunci kontrak fitur:

### Langkah 1: Topological & Connectivity Scan (Maksimal 2 Tool Call)
1. Panggil \`septum_domain({ action: "catalog" })\` untuk memeriksa *Telescope View* dan daftar domain yang terdaftar.
2. Panggil \`septum_domain({ action: "catalog", domain: "<target>", detail_level: "compact" })\` untuk memetakan file, simbol yang sudah ada, dan koneksi \`imports_from\` / \`imported_by_count\`.

### Langkah 2: Perumusan Kontrak Domain & Anti-Duplikasi Simbol
* **\`domain\` & \`root\`:** Nama domain dan direktori kanonikalnya.
* **\`allowed_dependencies\` & \`forbidden_dependencies\`:** Whitelist dan blacklist dependensi lintas-domain.
* **\`reuse_symbols\`:** Daftar class, service, repository, atau konstanta eksisting yang **wajib digunakan kembali** agar agen tidak membuat kode duplikat.

### Langkah 3: Registrasi Deterministik ke SQLite SSOT
1. Gunakan \`septum_domain({ action: "register", domain, root, allowed_dependencies, forbidden_dependencies, ingest_now: true })\` untuk menyimpan batas domain.
2. Gunakan \`septum_feature({ action: "lock", feature_key, domain, allowed_touchpoints, reuse_symbols })\` untuk mengunci fokus pengerjaan fitur.

### Langkah 4: Verifikasi Boundary & Siklus Dependensi
Jalankan \`septum_boundary({ scope: "all" })\` (atau CLI \`septum check --staged\`) untuk memastikan 0 pelanggaran batas domain dan 0 *circular dependency*.
`;

