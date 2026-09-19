# Brief: Septum Observability & Analytics Telemetry Engine

> **Kategori**: feature  
> **Status**: Completed  
> **Tanggal**: 2026-09-19  

---

## Overview & Problem Statement
- **Konteks & Alasan**: `septum` memerlukan sistem telemetri observabilitas tingkat produksi (*Production-Grade Observability*) yang mampu memfasilitasi **analisis data penggunaan tools dan perilaku AI Agent (*Tool & Agent Analytics*)**. Selama ini, log error hanya dicatat ke stream `console.error` yang bersifat sementara (*ephemeral*) tanpa persistensi ke disk, tidak mengukur latensi pemanggilan tool, dan belum mengkorelasikan event pemanggilan dengan sesi fitur aktif (`feature_key`).
- **Tujuan Utama**:
  1. Mengimplementasikan **Dual-Sink Structured Logging**:
     - **Sink 1 (`console.error` / `stderr`)**: Stream real-time untuk pemantauan live MCP client tanpa merusak transport `stdout` JSON-RPC.
     - **Sink 2 (`.septum/septum.log`)**: Persistent flight recorder berbasis format **JSON Lines (`.jsonl`)** dengan *file size rotation guard* (maksimal 2MB).
  2. Mengumpulkan **Metrik Telemetri Analitik** per pemanggilan tool:
     - *Token Density & Context Compression*: Ukuran respon terstruktur (`bytes_out`, `lines_out`, `nodes_returned`) vs ribuan baris file arsitektur mentah.
     - *Latency & Graph Profiling*: Waktu eksekusi penelusuran graf dan slice (`duration_ms`), serta alert `slow_tool_execution` (> 250ms).
     - *Domain & Symbol Heatmap*: Simbol, rute, dan domain yang paling sering diperiksa atau dilintasi oleh agent.
     - *Active Session Correlation*: Mengaitkan setiap aktivitas tool dengan *feature session lock* aktif (`active_feature_key` dan `active_domain`).
     - *Boundary Violation Analytics*: Melacak domain mana yang paling sering memicu pelanggaran dependensi terlarang (*forbidden dependencies*).

---

## Scope & Boundaries
### In-Scope
- [ ] Pembuatan modul logger terstruktur [`src/core/telemetry/telemetry.ts`](src/core/telemetry/telemetry.ts) dengan dukungan dual-sink (`stderr` + `.septum/septum.log`) dan rotasi file otomatis.
- [ ] Penambahan schema event telemetri analitik:
  ```json
  {
    "timestamp": "ISO8601",
    "event": "tool_call_completed" | "tool_call_failed",
    "tool": "septum_get_domain_catalog | septum_trace_vertical_slice | septum_locate_symbol | septum_get_symbol_impact | ...",
    "duration_ms": 25,
    "input": { "domain": "orders", "query": "POST /api/orders" },
    "metrics": { "bytes_out": 680, "lines_out": 30, "nodes_returned": 8 },
    "session": { "feature_key": "order-checkout", "domain": "orders" },
    "status": "success" | "error",
    "error": { "code": "...", "message": "...", "stack": "..." }
  }
  ```
- [ ] Instrumentasi handler `CallToolRequestSchema` pada [`src/mcp/server.ts`](src/mcp/server.ts) untuk mengukur latensi dan mencatat telemetri analitik ke `.septum/septum.log`.
- [ ] Penambahan unit test untuk verifikasi rotasi berkas dan korelasi sesi.

### Out-of-Scope
- Menggunakan library tracing eksternal pihak ketiga (seperti OpenTelemetry Collector atau Prometheus exporter).
- Mengubah skema basis data SQLite `.septum/septum.db`.

---

## Spesifikasi Detail Pekerjaan

### 1. Daftar File yang Terlibat
1. `src/core/telemetry/telemetry.ts` (File Baru): Modul `SeptumTelemetry` yang mengelola append JSONL ke `.septum/septum.log`, rotasi file (2MB limit), dan streaming ke `stderr`.
2. `src/mcp/server.ts` (L60-L100, L420-L460): Pembungkusan eksekusi tool MCP dengan pengayaan sesi fitur dan pencatatan telemetri.
3. `tests/mcp-observability.test.ts` (File Baru): Verifikasi keutuhan log JSONL, pengukuran durasi, korelasi sesi, dan isolasi stdio.

### 2. Line Range Mapping (Presisi Target)
- `src/mcp/server.ts:L65-L85`: Inisialisasi timer `performance.now()` dan resolusi sesi aktif via `SessionManager`.
- `src/mcp/server.ts:L440-L465`: Pencatatan event sukses atau gagal ke `SeptumTelemetry.recordToolCall(...)`.

### 3. Dimensi Analisis Data yang Dihasilkan
1. **Analisis Efisiensi Token**: Membuktikan efektivitas Macro Map dan Vertical Slice dalam mengompresi konteks dibanding membaca puluhan file mentah.
2. **Analisis Pelanggaran Boundary (Boundary Leak Heatmap)**: Mengetahui domain mana yang sering mengalami kebocoran kode oleh agent.
3. **P95 Latensi Graf**: Mengidentifikasi kueri simbol atau vertical slice yang membutuhkan optimasi indexing SQLite.
4. **Analisis Sesi Fitur**: Melacak riwayat eksplorasi agent selama mengerjakan fitur tertentu.
5. **Diagnostik Resolusi Simbol**: Menemukan query simbol atau rute yang gagal ditemukan (*unresolved symbols*).

---

## Acceptance Criteria (Given-When-Then)

- [ ] **Scenario 1 (Pencatatan Telemetri Analitik ke .septum/septum.log)**:
  - **Given**: Server MCP `septum` sedang aktif melayani client.
  - **When**: Tool `septum_trace_vertical_slice` selesai dieksekusi.
  - **Then**: Satu baris JSONL baru tercatat di `.septum/septum.log` dengan atribut `tool`, `duration_ms`, `metrics.bytes_out`, dan `status: "success"`.

- [ ] **Scenario 2 (Korelasi Sesi Aktif)**:
  - **Given**: Terdapat sesi fitur yang terkunci via `septum feature` (`feature_key: "auth-jwt"`).
  - **When**: Sebuah tool MCP dijalankan.
  - **Then**: Event telemetri yang dicatat menyertakan properti `session: { feature_key: "auth-jwt", domain: "auth" }`.

- [ ] **Scenario 3 (Proteksi Rotasi File Log)**:
  - **Given**: File log `.septum/septum.log` mencapai batas 2MB.
  - **When**: Telemetri baru dicatat.
  - **Then**: File lama di-rotate menjadi `.septum/septum.log.1` dan file baru dimulai tanpa menyebabkan gangguan I/O.

---

## Definition of Done (DoD) Checklist
- [ ] Modul `SeptumTelemetry` terimplementasi dan terhubung ke `src/mcp/server.ts`.
- [ ] Berkas log `.septum/septum.log` terbentuk secara otomatis dengan format JSONL.
- [ ] Unit test mencakup pencatatan telemetri, korelasi sesi, dan rotasi file.
