export const SEPTUM_MAP_SKILL_TEMPLATE = `---
name: septum-map
description: Framework-agnostic codebase and boundary governance. Use when initializing Septum, reviewing its domain catalog, registering domain boundaries, managing feature touchpoints, or checking Septum boundary results.
---

# \`septum-map\` — Septum Governance

> **Prinsip utama:** Septum memberi bukti dari index dan aturan yang tercatat, bukan ground truth lengkap tentang source atau runtime. Selalu nyatakan cakupan dan ketidakpastian sebelum memakai hasilnya sebagai dasar keputusan.

## Cakupan

Gunakan skill ini hanya untuk mengoperasikan dan menafsirkan governance Septum: katalog domain, aturan dependency, feature touchpoints, dan boundary check. Skill ini tidak menetapkan desain backend atau kebijakan bisnis; ikuti skill dan keputusan project yang relevan.

## Kontrak tool dan command

Schema MCP yang aktif dan output \`septum --help\` adalah kontrak saat ini. Periksa keduanya sebelum menggunakan tool atau command; jangan mengandalkan nama tool, parameter, atau kemampuan dari salinan skill/dokumentasi lain.

| Tool | Kegunaan | Batas interpretasi |
|---|---|---|
| \`septum_domain\` | \`catalog\` membaca peta (opsi \`detail_level: "compact"\`); \`register\` mendaftarkan domain; \`topology\` membaca atau mencatat topologi lingkungan. | Registrasi dan resolusi topologi dapat mengubah state. Layout folder hanya petunjuk, bukan bukti kebijakan domain. |
| \`septum_symbol\` | \`locate\`, \`inspect\`, \`impact\`, atau \`hotspots\` sesuai schema aktif. | Hasil bergantung pada index dan extractor. Impact/hotspot adalah sinyal triase, bukan bukti lengkap tentang runtime atau risiko perubahan. |
| \`septum_slice\` | Menelusuri kandidat vertical slice dari query; \`max_depth\` membatasi penelusuran. | \`confidence\` dapat menjelaskan kecocokan query; jangan anggap setiap node/edge sebagai panggilan runtime yang terbukti. |
| \`septum_boundary\` | Memeriksa usulan file/import atau mengaudit scope \`file\`, \`staged\`, \`domain\`, atau \`all\`; hasil dapat memuat rule \`circular_dependency\`. | Interpretasikan berdasarkan \`status\`, scope, sync state, dan coverage yang dikembalikan. \`approved\` hanya berlaku untuk scope yang diperiksa. |
| \`septum_feature\` | \`get\` membaca konteks; \`lock\` membuat feature/session lock; \`release\` melepasnya. | \`lock\` dan \`release\` mengubah state session; touchpoints adalah input ke pemeriksaan Septum, bukan kontrol akses filesystem. |

CLI yang umum: \`septum init\` menyiapkan konfigurasi, hook/harness yang dipilih, dan initial index; \`septum sync\` memperbarui index; \`septum check\` menjalankan boundary check. Verifikasi opsi aktual dengan \`septum --help\`. Command tersebut dapat mengubah file project atau index.

## Alur governance

1. **Periksa kondisi awal.** Pastikan workspace target benar. Periksa apakah \`.septum/septum.db\` dan konfigurasi Septum sudah ada. Gunakan \`workspace_path\` bila schema tool menyediakan dan konteks berisi beberapa project.
2. **Baca peta dan coverage.** Ambil katalog domain. Catat status index, file unsupported/skipped/uncovered, dan informasi freshness yang benar-benar tersedia. Jika status tidak ada atau tidak cukup, tandai coverage sebagai tidak diketahui.
3. **Pisahkan bukti dari usulan.** Gunakan source/layout dan kontrak project sebagai bukti. Perlakukan nama folder, archetype, hasil impact, hotspot, dan slice sebagai petunjuk sampai diverifikasi. Jangan menyimpulkan aturan bisnis atau dependency yang diizinkan dari struktur folder saja.
4. **Rumuskan perubahan governance.** Sajikan domain/root, allowed/forbidden dependencies, archetypes, dan alasan berbasis bukti. Tandai asumsi serta keputusan yang perlu dikonfirmasi pemilik project.
5. **Minta persetujuan sebelum mutasi.** Lakukan \`septum_domain(action: "register")\`, \`septum_feature(action: "lock"|"release")\`, \`septum init\`, atau \`septum sync\` hanya jika task secara jelas mengizinkannya. Jelaskan bahwa operasi tersebut mengubah konfigurasi, session, hook, atau index sesuai command yang dipilih.
6. **Verifikasi hasil sesuai scope.** Setelah perubahan yang diizinkan, baca ulang katalog/session terkait dan jalankan boundary check yang tepat. Laporkan status aktual; jangan mengubah \`unknown\` menjadi lulus.

## Menafsirkan hasil

- \`approved\` berarti tidak ada pelanggaran yang ditemukan pada scope dan coverage yang diperiksa; itu tidak membuktikan seluruh repository bebas pelanggaran.
- \`unknown\`, sync yang belum selesai/gagal, atau file unsupported/skipped berarti hasil tidak cukup untuk menyimpulkan aman.
- Tidak ditemukannya simbol, caller, route, atau dependency berarti “tidak ditemukan pada index/query ini”, bukan otomatis “tidak ada di source/runtime”.
- \`exact\`/confidence pada slice adalah label pencocokan yang dikembalikan tool. Jangan mengubahnya menjadi kepastian bahwa seluruh chain benar secara runtime.
- Feature lock dapat membantu boundary check atau hook Septum yang aktif menolak touchpoint di luar daftar. Ia tidak membatasi kemampuan baca/tulis agent atau proses lain pada level OS.

## Format laporan ringkas

Laporkan:

- **Workspace dan operasi:** target, tool/command, scope, serta apakah state berubah.
- **Bukti:** status dan lokasi yang benar-benar dikembalikan Septum/source.
- **Coverage:** complete, partial, unknown, atau tidak dilaporkan, beserta alasannya.
- **Inferensi/asumsi:** labeli secara eksplisit; jangan tampilkan sebagai ground truth.
- **Keputusan governance:** aturan yang diusulkan/disetujui dan siapa yang mengotorisasi mutasinya.
`;
