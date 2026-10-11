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

## 2. Referensi Cepat 12 Tool MCP Septum (Standardized \`snake_case\` Contracts)

| Tool MCP | Parameter Utama (\`snake_case\`) | Fungsi & Kapan Digunakan |
|---|---|---|
| **\`septum_get_domain_catalog\`** | \`{ domain?, detail_level?: "compact"\\|"full", archetype_filter?, file_filter? }\` | Tanpa \`domain\`: menampilkan *Macro Semantic Map* seluruh proyek. Dengan \`domain\`: menampilkan daftar file, \`connections\` (\`imports_from\`, \`imported_by_count\`), dan simbol di domain tersebut (\`compact\` default < 400 token). |
| **\`septum_locate_symbol\`** | \`{ query, domain?, limit?: 10 }\` | Mencari lokasi file dan baris (\`line_start\`-\`line_end\`) dari class, fungsi, method (\`Class::method\`), struct, atau konstanta. |
| **\`septum_get_symbol\`** | \`{ symbol, domain?, include_dependencies?: true }\` | Mengekstrak detail kontrak simbol: signature, \`exact_range\`, \`dependencies_injected\`, \`outbound_calls\`, \`sibling_methods\`, dan \`connected_files\`. |
| **\`septum_get_symbol_impact\`** | \`{ symbol }\` | Menghitung *blast radius* (\`inbound_callers\`, \`total_dependents\`, \`risk_level\`) termasuk pelacakan *named imports* lintas file sebelum mengubah signature. |
| **\`septum_trace_vertical_slice\`** | \`{ query, max_depth?: 5 }\` | Menelusuri alur eksekusi end-to-end (\`Ingress ➔ Validation ➔ Controller ➔ Service ➔ Repository ➔ Entity\`). \`max_depth\` default \`5\`, rentang \`1..8\` (gunakan \`6..8\` untuk deep trace Event/Job/Queue). |
| **\`septum_check_boundary\`** | \`{ file_path?, file_paths?, proposed_imports?, feature_key?, scope?: "file"\\|"all"\\|"staged"\\|"domain", domain? }\` | **Pre-Write:** memvalidasi \`proposed_imports\` pada \`file_path\`. **Macro Audit:** panggil dengan \`{ scope: "all" }\` atau \`{ scope: "staged" }\` untuk mengaudit seluruh batas domain & *circular dependencies*. |
| **\`septum_get_symbol_hotspots\`** | \`{ domain?, min_lines?: 30, min_nesting?, kind?, limit?: 30, sort_by?: "risk_score" }\` | Mengidentifikasi fungsi/class paling kompleks berdasarkan \`risk_score\` (\`line_count\` $\\times$ \`nesting_depth\`). |
| **\`septum_get_feature_context\`** | \`{ feature_key? }\` | Mengambil konteks fitur aktif (\`allowed_touchpoints\`, \`reuse_symbols\`, input/output contract). |
| **\`septum_clear_feature_context\`** | \`{}\` | Melepaskan kunci sesi fitur aktif di \`.septum/session.json\`. |
| **\`septum_register_domain\`** | \`{ domain, root, description?, allowed_dependencies?, forbidden_dependencies?, archetypes?, ingest_now?: true }\` | Mendaftarkan atau memperbarui bounded-context domain langsung ke SQLite SSOT (\`.septum/septum.db\`). |
| **\`septum_register_feature\`** | \`{ feature_key, domain, description?, allowed_touchpoints?, reuse_symbols?, input_contract?, output_contract? }\` | Mendaftarkan kontrak fitur baru ke SQLite SSOT dan mengaktifkan sesi *touchpoint lock*. |
| **\`septum_get_environment_topology\`** | \`{ resolve?, resolveNode?, refresh? }\` | Memetakan 6-layer topologi infrastruktur (\`EDGE\`, \`GATEWAY\`, \`HOST\`, \`RUNTIME\`, \`STORAGE\`, \`TELEMETRY\`) beserta invarian lintas-layer. |

---

## 3. Alur Kerja Pemetaan & Inisialisasi Domain (The 4-Step Lifecycle)

> [!NOTE] Zero-Config Default (\`septum init\`)
> Menjalankan \`septum init\` di terminal secara otomatis mendeteksi bahasa & framework (TS/JS, PHP/Laravel, Python, Go, Rust, Java, C#, Ruby), mendaftarkan domain ke \`.septum/septum.db\`, mengindeks AST via Tree-Sitter WASM, dan memasang hook di \`.agents/\`.

Gunakan alur 4 langkah ini saat merancang domain baru, melakukan *re-mapping* arsitektur, atau mengunci kontrak fitur:

### Langkah 1: Topological & Connectivity Scan (Maksimal 2 Tool Call)
1. Panggil \`septum_get_domain_catalog({})\` untuk memeriksa *Telescope View* dan daftar domain yang terdaftar.
2. Panggil \`septum_get_domain_catalog({ domain: "<target>", detail_level: "compact" })\` untuk memetakan file, simbol yang sudah ada, dan koneksi \`imports_from\` / \`imported_by_count\`.

### Langkah 2: Perumusan Kontrak Domain & Anti-Duplikasi Simbol
* **\`domain\` & \`root\`:** Nama domain dan direktori kanonikalnya.
* **\`allowed_dependencies\` & \`forbidden_dependencies\`:** Whitelist dan blacklist dependensi lintas-domain.
* **\`reuse_symbols\`:** Daftar class, service, repository, atau konstanta eksisting yang **wajib digunakan kembali** agar agen tidak membuat kode duplikat.

### Langkah 3: Registrasi Deterministik ke SQLite SSOT
1. Gunakan \`septum_register_domain({ domain, root, allowed_dependencies, forbidden_dependencies, ingest_now: true })\` untuk menyimpan batas domain.
2. Gunakan \`septum_register_feature({ feature_key, domain, allowed_touchpoints, reuse_symbols })\` untuk mengunci fokus pengerjaan fitur.

### Langkah 4: Verifikasi Boundary & Siklus Dependensi
Jalankan \`septum_check_boundary({ scope: "all" })\` (atau CLI \`septum check --staged\`) untuk memastikan 0 pelanggaran batas domain dan 0 *circular dependency*.
`;

