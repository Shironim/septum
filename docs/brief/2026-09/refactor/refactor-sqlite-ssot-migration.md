# Brief: Migrasi Septum ke SQLite SSOT & Standarisasi Ingestion Pipeline

**Category**: `refactor`  
**Status**: `Completed`  
**Target File**: `docs/brief/refactor-sqlite-ssot-migration.md`  
**Author**: Lead Architect / Orchestrator  
**Date**: 2026-09-18  

---

## 1. Executive Summary & Problem Statement

### Konteks Saat Ini
Arsitektur awal Septum bertumpu pada file deklarasi statis `.septum.yaml` untuk mendefinisikan batas modul (*bounded contexts*), aturan ketergantungan (*allowed/forbidden deps*), dan pola pengabaian file (*ignore patterns*). File ini kemudian di-load ke memori oleh `ConfigLoader` dan di-passing ke `IngestionPipeline` untuk memindai file dan menyimpannya ke database SQLite (`.septum/septum.db`).

### Masalah Struktural & Akar Penyebab (Root Causes)
1. **Split-Brain & State Drift:** File `.septum.yaml` dan database SQLite beroperasi sebagai dua representasi state paralel. Jika file YAML diubah tanpa sinkronisasi ulang, atau jika developer merombak folder kode tanpa memperbarui YAML, sistem mengalami desinkronisasi fatal.
2. **Kerapuhan Runtime (`throw new Error`):** `ConfigLoader.load()` melempar error keras jika file `.septum.yaml` tidak ditemukan, memblokir eksekusi CLI dan MCP tools saat berhadapan dengan repositori baru yang belum diinisialisasi secara manual.
3. **Ketiadaan Standarisasi Re-Parsing Inkremental:** Tidak ada protokol terstandarisasi yang mendeteksi file *dirty* secara atomik berbasis fingerprint hash konten. Re-parsing parsial berisiko meninggalkan *orphan rows* di tabel `symbols` dan `dependencies`.
4. **Asimetri CLI vs MCP:** MCP tools dan CLI commands belum berbagi abstraksi domain yang identik dalam memvalidasi batas arsitektur dan mengekstrak konteks kode.

---

## 2. Architectural Decision (ADR)

> **Keputusan:**  
> 1. Mengeliminasi ketergantungan pada `.septum.yaml`. Menjadikan database SQLite sebagai **100% Single Source of Truth (SSOT)**.  
> 2. Pada Fase 1 (Discovery & Init), AI agent / ingestion engine memindai codebase secara utuh, mengekstrak domain, files, symbols, dan dependencies, lalu langsung mengompilasi dan mengunci status ke SQLite catalog.  
> 3. Menstandarkan **3-Stage Ingestion Pipeline** dan **Incremental Re-Parsing Protocol** berbasis content-hash deterministik dan transaksi atomik SQLite.  
> 4. Menyelaraskan seluruh CLI commands dan MCP tools agar membaca langsung dari SQLite catalog tanpa asumsi adanya file YAML.

---

## 3. Target Architecture & Component Topology

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CODEBASE (DISK)                                │
│       Source files (.ts, .js, .php, etc.) ──> Traversal / Git Index         │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      3-STAGE INGESTION PIPELINE                             │
│                                                                             │
│  Stage 1: Fingerprinting (xxHash64/BLAKE3 hash, file size, extension)      │
│  Stage 2: AST Extraction (Exported symbols, imports, line_start:line_end)   │
│  Stage 3: Domain Ingestion & Relational Upsert (Atomic SQLite Transaction)  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 DETERMINISTIC SQLITE CATALOG (ABSOLUTE SSOT)                │
│                                                                             │
│  • repo_meta    : Watermark sinkronisasi, last_indexed_at, commit SHA       │
│  • domains      : Bounded contexts, root_path, visibility rules             │
│  • files        : Relative paths, content_hash, domain_id (ON DELETE CASCADE│
│  • symbols      : Granular symbol coordinates (line_start:line_end)         │
│  • dependencies : Inter-file & external edges, boundary violation flags    │
│  • slices       : Route & vertical architecture mappings                    │
└──────────────────────┬───────────────────────────────┬──────────────────────┘
                       │                               │
                       ▼                               ▼
       ┌───────────────────────────────┐ ┌───────────────────────────────┐
       │           CLI TOOLS           │ │           MCP TOOLS           │
       │  (septum init, ingest, query, │ │ (check-boundary, get-catalog, │
       │   verify, slice, serve)       │ │  locate-symbol, trace-slice)  │
       └───────────────────────────────┘ └───────────────────────────────┘
```

---

## 4. Standarisasi 3-Stage Ingestion Pipeline

### Stage 1: File Fingerprinting & Fast Diffing
- Menghitung `content_hash` cepat untuk setiap file di repositori.
- Membandingkan hash dengan data pada tabel `files` di SQLite:
  - Hash identik $\rightarrow$ **SKIPPED** (No I/O cost, zero token overhead).
  - Hash berbeda $\rightarrow$ **DIRTY** (Dijadwalkan untuk re-parsing AST).
  - File tidak ada lagi di disk $\rightarrow$ **DELETED** (Dijadwalkan untuk cascading removal).

### Stage 2: Precision AST Extraction
- Menjalankan AST parser ringan (`ASTParserEngine` / Tree-sitter / semantic extractors).
- Ekstrak secara presisi:
  - **Exported Symbols:** `name`, `kind`, `visibility`, `line_start`, `line_end`.
  - **Dependency Edges:** specifier import dan referensi simbol target.
- **Token Economy Guard:** Tidak pernah menyimpan raw source code di database. Database hanya menyimpan koordinat baris dan metadata struktural.

### Stage 3: Relational Persistence & Domain Clustering
- Jika file belum memiliki domain terasosiasi, domain diinferensi dari direktori tingkat atas modul (e.g. `src/auth/` $\rightarrow$ `auth`).
- Eksekusi pembaharuan database dibungkus dalam **`BEGIN IMMEDIATE TRANSACTION`**:
  ```sql
  -- 1. Bersihkan record lama untuk file dirty
  DELETE FROM symbols WHERE file_id = :file_id;
  DELETE FROM dependencies WHERE source_file_id = :file_id;
  
  -- 2. Insert symbols & dependencies baru
  INSERT INTO symbols (...) VALUES (...);
  INSERT INTO dependencies (...) VALUES (...);
  
  -- 3. Update status file
  UPDATE files SET content_hash = :hash, last_scanned_at = CURRENT_TIMESTAMP WHERE id = :file_id;
  
  -- 4. Update watermark status repositori
  INSERT OR REPLACE INTO repo_meta (key, value, updated_at) VALUES ('last_sync', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  ```

---

## 5. Scope & Target File Mapping

| Target File | Perkiraan Target Baris | Deskripsi Perubahan |
|---|---|---|
| [`src/core/database/schema.sql`](file:///home/shironim/Project/septum/src/core/database/schema.sql) | L88-L100 | Menambahkan tabel `repo_meta` dan index pendukung untuk status sinkronisasi. |
| [`src/core/database/client.ts`](file:///home/shironim/Project/septum/src/core/database/client.ts) | L20-L80 | Menambahkan `repo_meta` pada inline fallback schema dan memastikan koneksi WAL mode. |
| [`src/core/database/repository.ts`](file:///home/shironim/Project/septum/src/core/database/repository.ts) | L30-L100, L500-L580 | Menambahkan method `getMeta()`, `setMeta()`, `listDomains()`, serta query domain independen dari YAML. |
| [`src/core/config/schema.ts`](file:///home/shironim/Project/septum/src/core/config/schema.ts) | L1-L50 | Menyesuaikan schema konfigurasi agar mendukung fallback konfigurasi default tanpa file fisik. |
| [`src/core/config/loader.ts`](file:///home/shironim/Project/septum/src/core/config/loader.ts) | L5-L40 | Mengubah `ConfigLoader.load()` menjadi *graceful/optional*; mengembalikan default configuration jika `.septum.yaml` tidak ada. |
| [`src/core/ingestion/pipeline.ts`](file:///home/shironim/Project/septum/src/core/ingestion/pipeline.ts) | L30-L120 | Mengimplementasikan auto-discovery mode ketika `config.domains` kosong, langsung menyelaraskan dengan SQLite. |
| [`src/cli/commands/ingest.ts`](file:///home/shironim/Project/septum/src/cli/commands/ingest.ts) | L10-L50 | Menyesuaikan pemanggilan ingestion agar berjalan tanpa mewajibkan `.septum.yaml`. |
| [`src/cli/commands/init.ts`](file:///home/shironim/Project/septum/src/cli/commands/init.ts) | L10-L120 | Mengarahkan perintah `init` untuk langsung memetakan domain dan membuat database SQLite tanpa memaksa generate YAML. |
| [`src/cli/commands/check.ts`](file:///home/shironim/Project/septum/src/cli/commands/check.ts) | L10-L60 | Memvalidasi boundary architecture langsung dari database SQLite. |
| [`src/mcp/server.ts`](file:///home/shironim/Project/septum/src/mcp/server.ts) | L20-L80 | Memastikan server MCP beroperasi mulus menggunakan SQLite client tanpa asumsi konfigurasi YAML. |

---

## 6. Acceptance Criteria (Given-When-Then)

### Skenario 1: Inisialisasi Repositori Baru Tanpa `.septum.yaml`
- **GIVEN** Repositori kode baru tanpa file `.septum.yaml`.
- **WHEN** Developer atau AI agent menjalankan `septum init` atau `septum ingest`.
- **THEN** Sistem tidak boleh melempar error `Septum configuration file not found`.
- **AND** Database SQLite (`.septum/septum.db`) dibuat dengan tabel lengkap (`domains`, `files`, `symbols`, `dependencies`, `repo_meta`).
- **AND** Seluruh file sumber dipindai, di-hash, dan diindeks ke dalam database.

### Skenario 2: Re-Parsing Inkremental File Berubah
- **GIVEN** Database SQLite telah terindeks dengan 100 file.
- **WHEN** 1 file dimodifikasi dan perintah sinkronisasi dijalankan.
- **THEN** Hanya 1 file tersebut yang di-reparse AST-nya.
- **AND** 99 file lainnya dilewati (*skipped via hash match*).
- **AND** Tabel `repo_meta` mencatat timestamp pembaruan terbaru.

### Skenario 3: Penghapusan File Fisik (No Orphan Rows)
- **GIVEN** Suatu file sumber dihapus dari repositori.
- **WHEN** Ingestion pipeline berjalan.
- **THEN** Record file pada tabel `files` dihapus.
- **AND** Seluruh symbol dan dependency edge terkait terhapus bersih secara otomatis via `ON DELETE CASCADE`.

### Skenario 4: Kueri MCP Tools Deterministik
- **GIVEN** MCP Server Septum sedang berjalan.
- **WHEN** AI Agent memanggil tool `get-domain-catalog` atau `check-boundary`.
- **THEN** Hasil dikembalikan dalam format padat ($\le 30-50$ baris) langsung dari kueri SQLite terindeks, tanpa membaca file `.septum.yaml`.

---

## 7. Definition of Done (DoD)

- [x] Tabel `repo_meta` aktif pada skema SQLite fisik dan inline fallback schema.
- [x] `ConfigLoader` tidak melempar error saat `.septum.yaml` absen, melainkan menyediakan konfigurasi fallback terstandarisasi.
- [x] `IngestionPipeline` mendukung auto-discovery folder modul dan persistensi langsung ke SQLite.
- [x] Seluruh CLI commands (`init`, `ingest`, `check`, `query`) lulus pengujian tanpa file `.septum.yaml`.
- [x] Seluruh MCP tools (`check-boundary`, `get-domain-catalog`, dll.) berfungsi normal di atas SQLite SSOT.
- [x] Tidak ada regresi fungsionalitas pada fitur semantic extraction dan vertical slice tracing.
