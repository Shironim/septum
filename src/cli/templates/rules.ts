export const SEPTUM_RULES_TEMPLATE = `# Septum Bounded-Context, Anti-Duplication & File Connectivity Rules

> **Prinsip Utama:** Proyek ini menggunakan **Septum** (\`.septum/septum.db\`) sebagai Single Source of Truth (SSOT) untuk memetakan seluruh class, fungsi, method, struct/interface, dan variabel/konstanta beserta keterhubungan antar-file. Setiap AI Coding Agent **dilarang membuat simbol duplikat** dan wajib mematuhi batas domain.

---

## 1. Anti-Duplikasi Simbol & Peta Keterhubungan File (Wajib Sebelum Coding)

Sebelum membuat class, fungsi, method, tipe, atau variabel/konstanta baru di file backend:
1. **Periksa Peta Domain & Koneksi File (Compact Mode < 400 Token):**
   Panggil \`septum_domain({ action: "catalog", domain: "<nama_domain>", detail_level: "compact" })\` (atau tanpa \`domain\` untuk *Macro Semantic Map*).
   * Perhatikan daftar simbol eksisting (\`class\`, \`interface\`, \`struct\`, \`function\`, \`type\`, \`constant\`, \`variable\`) beserta \`line_span\`-nya.
   * Perhatikan \`connections.imports_from\` (file mana saja yang diimpor oleh file tersebut) dan \`connections.imported_by_count\` (berapa file lain yang bergantung padanya).
   * Jika membutuhkan daftar signature method lengkap pada satu file, panggil \`septum_symbol({ action: "inspect", query: "<NamaSimbol>" })\`.
2. **Cari Simbol Lintas-Domain Sebelum Membuat Baru:**
   Panggil \`septum_symbol({ action: "locate", query: "<kata_kunci>" })\` untuk memastikan fungsi/helper/class yang ingin dibuat belum ada di codebase.
3. **Kunci Scope pada Fitur Aktif:**
   Jika mengerjakan fitur terdaftar, panggil \`septum_feature({ action: "get", feature_key: "<nama_fitur>" })\`:
   * **Patuhi \`allowed_touchpoints\`:** Jangan memodifikasi file di luar daftar touchpoint fitur aktif.
   * **Gunakan ulang \`reuse_symbols\`:** Wajib mengimpor dan memakai kembali simbol yang terdaftar di \`reuse_symbols\`.

---

## 2. Audit Blast Radius & Alur Eksekusi Sebelum Refactoring

1. **Cek Dampak Simbol (\`inbound_callers\`):**
   Sebelum mengubah parameter/return signature atau menghapus class/fungsi/method publik, wajib panggil:
   \`\`\`json
   septum_symbol({ "action": "impact", "query": "NamaClassAtauFungsi" })
   \`\`\`
   Periksa seluruh \`inbound_callers\` (termasuk *named imports* lintas file) agar tidak memutus kontrak file pemanggil.
2. **Telusuri Vertical Slice (Default Depth 5, Max Depth 8):**
   Gunakan \`septum_slice({ query: "<route|command|handler>", max_depth: 5 })\` (naikkan hingga \`max_depth: 8\` untuk alur Event/Job/Queue berlapis) guna memahami rantai eksekusi dari Ingress hingga Repository/Entity.

---

## 3. Pre-Flight Boundary & Circular Dependency Check

1. **Sebelum Menulis Import Lintas-Domain (\`write_to_file\` / \`replace_file_content\`):**
   \`\`\`json
   septum_boundary({
     "file_path": "path/ke/file.ts",
     "proposed_imports": ["../other-domain/service"],
     "feature_key": "opsional_feature_key"
   })
   \`\`\`
2. **Audit Menyeluruh & Deteksi Siklus (\`circular_dependency\`):**
   Jalankan \`septum_boundary({ scope: "staged" })\` atau \`septum_boundary({ scope: "all" })\` setelah menyelesaikan perubahan multi-file. Jika status \`rejected\` (\`forbidden_dependency\`, \`disallowed_dependency\`, \`touchpoint_violation\`, atau \`circular_dependency\`), batalkan/perbaiki arsitektur import sebelum melakukan commit.
`;

