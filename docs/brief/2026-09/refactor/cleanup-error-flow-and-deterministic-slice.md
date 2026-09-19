# Brief: Septum Error Flow Hardening & Deterministic Slice Tracing

> **Kategori**: refactor  
> **Status**: Completed  
> **Tanggal**: 2026-09-19  

---

## Overview & Problem Statement
- **Konteks & Alasan**: Berdasarkan audit `review-ai-code` menjelang publikasi ke npmjs, teridentifikasi tiga area kerapuhan dan logika "magic" pada `septum`:
  1. **Swallowed Errors / Silent Failures (`catch (_) {}`)**: Ditemukan blok penelanan exception kosong pada [`vertical-slice-tracer.ts`](src/core/resolver/vertical-slice-tracer.ts) (L38, L112, L197), [`call-graph-tracer.ts`](src/core/resolver/call-graph-tracer.ts) (L148), dan [`topology-detector.ts`](src/core/discovery/topology-detector.ts) (L293, L396). Ketika terjadi kegagalan parsing JSON atau database query, exception ditelan tanpa jejak, menyebabkan kegagalan analitik yang tersembunyi (*silent misdiagnosis*).
  2. **"Magic" Heuristik Substring Matching**: Pada `vertical-slice-tracer.ts`, jika sebuah rute tidak cocok dengan pola endpoint yang presisi, sistem secara diam-diam melakukan *substring matching* ke berkas/simbol mana pun tanpa menandai tingkat kepastian. Hal ini dapat menghasilkan rantai eksekusi fiktif (*hallucinated slice*).
  3. **Redundansi Subcommand CLI (`session` vs `feature`)**: Inkonsistensi alias `case "session": case "feature":` di [`src/cli/index.ts`](src/cli/index.ts) yang membingungkan dokumentasi Single Source of Truth (SSOT).
- **Tujuan Utama**:
  1. Menghilangkan seluruh blok `catch (_) {}` dan menggantinya dengan penanganan error deterministik (structured warning log / default recovery terprediksi).
  2. Menambahkan metadata tingkat kepastian (`confidence: "exact" | "inferred"`) pada hasil `trace_vertical_slice` dan menandai bagian rantai yang berasal dari inferensi heuristik.
  3. Menstandarkan antarmuka CLI ke perintah kanonikal `septum feature [status|clear]` dan membersihkan alias `session`.

---

## Scope & Boundaries
### In-Scope
- [ ] Refactor semua blok `catch (_) {}` pada `src/core/resolver/vertical-slice-tracer.ts`, `src/core/resolver/call-graph-tracer.ts`, dan `src/core/discovery/topology-detector.ts`.
- [ ] Penambahan properti `confidence` dan `is_exact_match` pada interface `VerticalSlice` di `src/types/index.ts` dan implementasinya di `vertical-slice-tracer.ts`.
- [ ] Pembersihan alias usang `session` pada `src/cli/index.ts` sehingga kanonikal menjadi `feature`.
- [ ] Pembaruan help text dan dokumentasi command pada `printHelp()`.

### Out-of-Scope
- Mengubah skema tabel database SQLite `.septum/septum.db`.
- Mengubah algoritma Tree-sitter AST parsing untuk TypeScript/PHP.

---

## Spesifikasi Detail Pekerjaan

### 1. Daftar File yang Terlibat
1. `src/types/index.ts`: Penambahan tipe kepastian trace (`confidence: "exact" | "inferred"`).
2. `src/core/resolver/vertical-slice-tracer.ts` (L35-L45, L105-L120, L190-L205): Penggantian empty catch dan penandaan confidence.
3. `src/core/resolver/call-graph-tracer.ts` (L140-L155): Penggantian empty catch dengan logging terstruktur.
4. `src/core/discovery/topology-detector.ts` (L290-L300, L390-L405): Penanganan kegagalan baca file secara aman tanpa empty catch.
5. `src/cli/index.ts` (L90-L105, L165-L175): Standarisasi CLI ke `feature [status|clear]`.

### 2. Line Range Mapping (Presisi Target)
- `src/core/resolver/vertical-slice-tracer.ts:L35-L42`: Tangani error `getAllVerticalSlices` secara eksplisit.
- `src/core/resolver/vertical-slice-tracer.ts:L190-L202`: Tangani `JSON.parse` kegagalan parse dengan error log dan fallback empty array.
- `src/cli/index.ts:L94-L105`: Hapus `case "session":`, pertahankan `case "feature":`.

### 3. Urutan Pengerjaan
1. Perbarui interface `VerticalSlice` di `src/types/index.ts`.
2. Refactor penanganan error dan tambahkan `confidence` pada `src/core/resolver/vertical-slice-tracer.ts`.
3. Bersihkan empty catch pada `src/core/resolver/call-graph-tracer.ts` dan `src/core/discovery/topology-detector.ts`.
4. Standarkan sub-command di `src/cli/index.ts`.
5. Jalankan test suite `bun test` untuk memastikan kepatuhan boundary dan validitas tracer.

### 4. Dampak & Risiko
- **Dampak Positif:** Sistem menjadi transparan; tidak ada silent crash; AI Agent mengetahui derajat kepastian suatu vertical slice (*Zero Hallucination*).
- **Risiko:** Perubahan kecil pada respons JSON `trace_vertical_slice` (penambahan field `confidence` non-breaking).

---

## Acceptance Criteria (Given-When-Then)

- [ ] **Scenario 1 (Transparansi Keyakinan Vertical Slice)**:
  - **Given**: Pengguna menjalankan `septum slice "orders"` atau memanggil MCP tool `trace_vertical_slice`.
  - **When**: Tracer mencocokkan rute yang terdaftar.
  - **Then**: Respons menyertakan properti `confidence: "exact"`, sedangkan rute yang dicocokkan via fallback heuristik menyertakan `confidence: "inferred"`.

- [ ] **Scenario 2 (Zero Silent Errors pada JSON Parsing)**:
  - **Given**: Terjadi anomali record JSON pada execution chain database.
  - **When**: Tracer mencoba melakukan decode execution chain.
  - **Then**: Kesalahan tidak ditelan secara diam-diam, melainkan dicatat ke error log dengan safe recovery tanpa crash.

- [ ] **Scenario 3 (Konsistensi Subcommand Feature)**:
  - **Given**: Pengguna menjalankan `septum feature status` atau `septum feature clear`.
  - **When**: Command diproses.
  - **Then**: Operasi session lock berhasil dieksekusi dan terdokumentasi rapi pada `septum --help`.

---

## Definition of Done (DoD) Checklist
- [ ] Seluruh blok `catch (_) {}` tereliminasi dari codebase.
- [ ] Metadata `confidence` terpasang pada seluruh hasil trace vertical slice.
- [ ] Subcommand CLI kanonikal adalah `feature` (bebas alias membingungkan).
- [ ] Seluruh unit test eksisting dan test baru lulus (`bun test`).
