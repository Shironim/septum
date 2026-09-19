export const SEPTUM_RULES_TEMPLATE = `# Septum Bounded-Context & Anti-Poisoning Partition Rules

> **Prinsip Utama:** Proyek ini menggunakan **Septum** untuk menegakkan batasan arsitektur (bounded-context) secara deterministik. Setiap AI Coding Agent wajib mematuhi aturan batas domain dan touchpoint berikut.

---

## 1. Single Source of Truth (SSOT) via Septum MCP

Sebelum menulis atau mengedit file backend/domain:
1. **Dilarang Menebak Kontrak Domain:**
   Gunakan tool MCP \`septum_get_domain_catalog(domain: "...")\` untuk memeriksa file, arketipe, dan signature publik yang sah di dalam domain tersebut.
2. **Kunci Scope pada Fitur Aktif:**
   Jika sedang mengerjakan fitur spesifik yang terdaftar di katalog Septum, panggil \`septum_get_feature_context(feature: "...")\`.
   * **Wajib patuhi \`allowed_touchpoints\`:** Jangan menyentuh atau memodifikasi file di luar daftar yang diizinkan untuk fitur tersebut.
   * **Wajib gunakan ulang \`reuse_symbols\`:** Jangan membuat fungsi atau helper duplikat jika simbol tersebut sudah terdaftar di \`reuse_symbols\`.

---

## 2. Pre-Flight Boundary Check Sebelum Menulis Kode

Sebelum mengeksekusi penulisan file (\`write_to_file\` atau \`replace_file_content\`):
1. Panggil tool MCP:
   \`\`\`json
   septum_check_boundary({
     "file_path": "path/ke/file.ts",
     "proposed_imports": ["target_import_statement"],
     "feature_key": "nama_fitur_opsional"
   })
   \`\`\`
2. **Rejection Handling:** Jika Septum mengembalikan status \`rejected\` (\`forbidden_dependency\`, \`disallowed_dependency\`, atau \`touchpoint_violation\`), **BATALKAN** rencana penulisan tersebut dan cari rute arsitektur yang sah (misal melalui Interface/Shared-Kernel yang diizinkan).

---

## 3. Anti Local Scope Myopia

* Dilarang menghapus fungsi publik atau mengubah signature class hanya karena fungsi tersebut tidak terlihat dipanggil di file lokal yang sedang diedit.
* Pastikan seluruh dependensi inbound/outbound mematuhi batasan domain yang terdaftar di database Septum (\`.septum/septum.db\`).
`;
