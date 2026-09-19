# Brief: Inisialisasi Fondasi Septum, Core Ingestion Engine, Standalone CLI, dan Precision MCP Server

> **Kategori**: feature  
> **Status**: Completed  
> **Tanggal**: 2026-09-17  

---

## Overview & Problem Statement

### Konteks & Alasan
Dalam ekosistem *Agentic Software Engineering*, kegagalan implementasi kode oleh AI Agent hampir selalu dipicu oleh **Context Poisoning** daripada *Context Deficiency*. Ketiadaan *boundary* deterministik dan kontrak per-fitur memicu 5 anomali fatal:
1. **Accidental Deletion**: AI membersihkan kode/helper yang dikira *dead code* karena tidak terpanggil di file lokal, padahal krusial untuk fitur lain.
2. **Cross-Domain Code Leakage**: Variabel, model, atau query dari domain lain terselip ke dalam controller yang tidak relevan akibat pencarian similarity RAG tanpa batas.
3. **Fungsi Duplikat**: AI mengarang method/service baru dari nol karena tidak memiliki katalog deterministik tentang *reusable symbols* yang sudah ada.
4. **Phantom Business Logic & Payload Bloat**: AI menambahkan query/data baru yang tidak diminta (misal mengirim data produk ke halaman yang hanya butuh data pesanan).
5. **Rusaknya Logika Bisnis**: AI bekerja berdasarkan tebakan bebas (*probabilistic guessing*) tanpa persetujuan spesifikasi kontrak data (In/Out) dan touchpoints file.

### Tujuan Utama
Membangun fondasi **Septum** sebagai *Prescriptive & Boundary Architecture Engine* berbasis **TypeScript** dan runtime **Bun**:
1. Menyediakan *Core Ingestion Engine* berbasis AST (`web-tree-sitter` WASM) dan embedded SQLite (`.septum/septum.db` via `bun:sqlite`).
2. Menyediakan *Precision MCP Server* (`src/mcp/`) via `stdio` yang menginjeksi katalog otoritatif (< 500 token) per domain dan memblokir pelanggaran boundary.
3. Menyediakan *Standalone CLI* (`bin/septum.ts`) yang dapat dijalankan secara mandiri oleh developer atau CI/CD pipeline (`init`, `ingest`, `check`, `query`, `serve`).

---

## Scope & Boundaries

### In-Scope
- [x] **Project Setup & Configuration**:
  - Inisialisasi `package.json`, `tsconfig.json`, dan konfigurasi Bun.
  - Setup dependensi esensial: `@modelcontextprotocol/sdk`, `web-tree-sitter`, `zod`, `yaml`.
- [x] **Core SQLite Storage Layer (`src/core/database/`)**:
  - Implementasi `schema.sql` (tabel: `domains`, `files`, `symbols`, `dependencies`).
  - Abstraksi client database via `bun:sqlite` dengan migration & indexing otomatis.
- [x] **Config & Spec Parser (`src/core/config/`)**:
  - Parser & validator skema `.septum.yaml` berbasis Zod.
- [x] **Tree-sitter WASM AST Extractor (`src/core/parser/`)**:
  - Ekstraksi struktural: nama class, interface, method signatures, parameter, return types, serta deklarasi import/use.
- [x] **Incremental Ingestion Pipeline (`src/core/ingestion/`)**:
  - Scanner file rekursif dengan hashing SHA-256 untuk memproses hanya file yang berubah.
  - Pipeline AST extraction -> normalisasi simbol -> penulisan katalog ke database `.septum/septum.db`.
- [x] **Boundary & Leak Evaluator (`src/core/boundary/`)**:
  - Evaluasi aturan `allowed_dependencies` dan `forbidden_dependencies`.
  - Deteksi anomali import ilegal dan pelanggaran touchpoint per domain.
- [x] **Standalone CLI Adapter (`src/cli/`)**:
  - `septum init`: Pembuatan scaffolding `.septum.yaml`.
  - `septum ingest`: Sinkronisasi AST file ke basis data.
  - `septum query <domain>`: Tampilan ringkas katalog simbol dan aturan domain di terminal.
  - `septum check`: Verifikasi integritas static import (CI gate, exit code 1 jika ada pelanggaran).
  - `septum serve`: Menjalankan MCP server via stdio.
- [x] **Precision MCP Server Adapter (`src/mcp/`)**:
  - Transport Stdio kompatibel MCP protocol standar.
  - Tool `septum_get_domain_catalog`: Mengembalikan manifest ringkas (< 400 token) berisi file yang diizinkan, public signatures, dan batasan domain.
  - Tool `septum_check_boundary`: Memvalidasi rencana perubahan / impor sebelum kode dimodifikasi.

### Out-of-Scope
- Implementasi runtime pre-tool hook IDE (`pre-septum-guard.cjs`) pada direktori global agent (akan dibuat sebagai modul tersendiri setelah core engine stabil).
- Graphical Web Dashboard / UI (fokus awal adalah CLI berkinerja tinggi dan MCP stdio).
- Automatic Code Refactoring / Self-Healing rewrite engine (Septum bertindak sebagai pagar deterministik & katalog otoritatif, bukan transpiler).

---

## Spesifikasi Detail Pekerjaan

### 1. Struktur Direktori
```bash
septum/
├── .septum.yaml
├── .septum/
│   └── septum.db
├── bin/
│   └── septum.ts
├── src/
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── init.ts
│   │   │   ├── ingest.ts
│   │   │   ├── query.ts
│   │   │   ├── check.ts
│   │   │   └── serve.ts
│   │   └── index.ts
│   ├── mcp/
│   │   ├── tools/
│   │   │   ├── get-domain-catalog.ts
│   │   │   └── check-boundary.ts
│   │   └── server.ts
│   ├── core/
│   │   ├── config/
│   │   │   ├── schema.ts
│   │   │   └── loader.ts
│   │   ├── database/
│   │   │   ├── schema.sql
│   │   │   ├── client.ts
│   │   │   └── repository.ts
│   │   ├── parser/
│   │   │   ├── tree-sitter.ts
│   │   │   └── extractors/
│   │   ├── ingestion/
│   │   │   ├── hasher.ts
│   │   │   └── pipeline.ts
│   │   └── boundary/
│   │       └── evaluator.ts
│   └── types/
│       └── index.ts
├── package.json
└── tsconfig.json
```

### 2. Skema Basis Data SQLite (`src/core/database/schema.sql`)
- **`domains`**: `id`, `name`, `root_path`, `allowed_deps_json`, `forbidden_deps_json`.
- **`files`**: `id`, `domain_id`, `path`, `archetype`, `content_hash`, `last_scanned_at`.
- **`symbols`**: `id`, `file_id`, `name`, `kind` (`class` | `interface` | `function` | `method`), `signature`, `visibility`, `line_start`, `line_end`.
- **`dependencies`**: `id`, `source_file_id`, `target_symbol_or_path`, `import_statement`, `is_external`.

### 3. Kontrak Respons MCP (`septum_get_domain_catalog`)
Batas token ketat (< 400 token):
```json
{
  "domain": "orders",
  "root": "app/Domain/Orders",
  "allowed_dependencies": ["customers", "payments", "shared"],
  "forbidden_dependencies": ["inventory"],
  "files": [
    {
      "path": "app/Domain/Orders/Services/OrderService.php",
      "archetype": "service",
      "symbols": [
        {
          "name": "OrderService",
          "kind": "class",
          "methods": [
            "cancelOrder(int $orderId, string $reason): bool",
            "recalculate(Order $order): Money"
          ]
        }
      ]
    }
  ]
}
```

---

## Acceptance Criteria (Given-When-Then)

### Scenario 1: Scaffold Konfigurasi Baru via CLI
- **Given**: Repositori belum memiliki file `.septum.yaml`.
- **When**: Developer mengeksekusi `bun run bin/septum.ts init`.
- **Then**: File template `.septum.yaml` terbuat dengan validasi Zod schema yang sah.

### Scenario 2: Ingestion & Pembuatan Katalog SQLite
- **Given**: Konfigurasi `.septum.yaml` valid dan terdapat file source code dalam direktori domain.
- **When**: Perintah `bun run bin/septum.ts ingest` dieksekusi.
- **Then**: Basis data `.septum/septum.db` terisi dengan pemetaan domains, files, symbols (class & signatures), dan hash file tersimpan untuk caching.

### Scenario 3: Query Katalog via MCP Server
- **Given**: MCP Server berjalan (`bun run bin/septum.ts serve`) dan basis data telah terisi.
- **When**: AI Agent memanggil tool `septum_get_domain_catalog` dengan argumen `domain: "orders"`.
- **Then**: Server mengembalikan JSON manifest dengan panjang payload < 500 token yang mencakup public signatures, files, serta allowed/forbidden boundaries.

### Scenario 4: Evaluasi Pelanggaran Boundary (Anti-Leak)
- **Given**: Domain `orders` memiliki `forbidden_dependencies: ["inventory"]`.
- **When**: Sebuah file di `orders` mengimpor kelas dari modul `inventory` dan diperiksa via `septum check` atau tool `septum_check_boundary`.
- **Then**: Septum menolak operasi tersebut dengan error deterministik yang menyebutkan baris file, pelanggaran domain asal, dan domain terlarang yang diimpor.

---

## Definition of Done (DoD) Checklist

- [x] Konfigurasi proyek Bun + TypeScript selesai tanpa error typecheck (`bun run tsc --noEmit`).
- [x] Skema database terkompilasi dan berjalan normal di `bun:sqlite`.
- [x] Ingestion AST incremental berhasil mengekstrak signature tanpa membaca seluruh teks file secara brute force.
- [x] CLI `bin/septum.ts` mendukung perintah: `init`, `ingest`, `query`, `check`, dan `serve`.
- [x] MCP Server berhasil merespons kueri protokol via stdio dengan manifest ringkas (< 500 token).
- [x] Seluruh skenario Acceptance Criteria teruji dan lulus.
