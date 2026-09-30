import * as fs from "node:fs";
import * as path from "node:path";
import type { SeptumRepository } from "../database/repository.ts";
import type {
  CanonicalPlatformTag,
  CrossLayerInterplay,
  EnvironmentLayer,
  EnvironmentLayerInfo,
  EnvironmentTopology,
  TopologyNode,
} from "./types.ts";

export class EnvironmentDetector {
  public static detect(
    workspaceRoot: string,
    repo?: SeptumRepository,
    forceRefresh: boolean = false
  ): EnvironmentTopology {
    // 1. Fetch any previously verified layers and nodes from SQLite SSOT
    const savedLayers: Partial<Record<EnvironmentLayer, EnvironmentLayerInfo>> =
      repo && !forceRefresh ? repo.environment.getAllLayers() : {};
    const savedNodes = repo && !forceRefresh ? repo.environment.getAllNodes() : [];
    const savedNodeMap = new Map(savedNodes.map((n) => [n.id, n]));

    // 2. Perform root file-based heuristic inspection for each of the 6 layers
    const detectedEdge = this.inspectEdgeLayer(workspaceRoot);
    const detectedGateway = this.inspectGatewayLayer(workspaceRoot);
    const detectedHost = this.inspectHostLayer(workspaceRoot, detectedGateway);
    const detectedRuntime = this.inspectRuntimeLayer(workspaceRoot);
    const detectedStorage = this.inspectStorageLayer(workspaceRoot);
    const detectedTelemetry = this.inspectTelemetryLayer(workspaceRoot);

    // 3. Merge layers: Database verified layers take precedence
    const layers: Record<EnvironmentLayer, EnvironmentLayerInfo> = {
      edge: savedLayers.edge?.status === "VERIFIED" ? savedLayers.edge : detectedEdge,
      gateway: savedLayers.gateway?.status === "VERIFIED" ? savedLayers.gateway : detectedGateway,
      host: savedLayers.host?.status === "VERIFIED" ? savedLayers.host : detectedHost,
      runtime: savedLayers.runtime?.status === "VERIFIED" ? savedLayers.runtime : detectedRuntime,
      storage: savedLayers.storage?.status === "VERIFIED" ? savedLayers.storage : detectedStorage,
      telemetry: savedLayers.telemetry?.status === "VERIFIED" ? savedLayers.telemetry : detectedTelemetry,
    };

    // 4. Save layers to SQLite if not already stored
    if (repo) {
      for (const layerKey of Object.keys(layers) as EnvironmentLayer[]) {
        if (!savedLayers[layerKey] || forceRefresh) {
          repo.environment.saveLayer(layers[layerKey]);
        }
      }
    }

    // 5. Discover Multi-Node Entities (Monorepo / Subservices / Default Nodes)
    const detectedNodes: TopologyNode[] = [];
    const subservices = this.probeSubservices(workspaceRoot);

    if (subservices.length > 0) {
      // Monorepo / Multi-Service layout
      for (const sub of subservices) {
        const subRuntime = this.inspectRuntimeLayer(sub.path);
        const subGateway = this.inspectGatewayLayer(sub.path);
        const nodeId = `runtime:${sub.name}`;
        detectedNodes.push({
          id: nodeId,
          layer: "runtime",
          name: `${sub.name.toUpperCase()} Engine`,
          platform: subRuntime.platform || "Service Runtime",
          canonical_tag: subRuntime.canonical_tag || "unspecified",
          role: sub.type === "frontend" ? "frontend_spa" : "web_api",
          status: subRuntime.status,
          detected_from: [path.relative(workspaceRoot, sub.path)],
          constraints: subRuntime.constraints || [],
          connected_to: sub.type === "backend" ? ["storage:primary"] : [`runtime:backend`],
          unresolved_inquiry: subRuntime.unresolved_inquiry,
        });

        if (subGateway.status !== "AMBIGUOUS" && subGateway.platform !== "Standard Ingress / Unknown Web Server") {
          detectedNodes.push({
            id: `gateway:${sub.name}`,
            layer: "gateway",
            name: `${sub.name.toUpperCase()} Ingress`,
            platform: subGateway.platform || "Web Server",
            canonical_tag: subGateway.canonical_tag || "unspecified",
            status: subGateway.status,
            detected_from: subGateway.detected_from || [],
            constraints: subGateway.constraints || [],
            connected_to: [nodeId],
          });
        }
      }
      // Include Edge, Host, Storage, Telemetry default nodes
      detectedNodes.push(
        {
          id: "edge:primary",
          layer: "edge",
          name: "Perimeter Edge WAF",
          platform: layers.edge.platform || "Edge",
          canonical_tag: layers.edge.canonical_tag || "unspecified",
          status: layers.edge.status,
          detected_from: layers.edge.detected_from || [],
          constraints: layers.edge.constraints || [],
          unresolved_inquiry: layers.edge.unresolved_inquiry,
        },
        {
          id: "host:primary",
          layer: "host",
          name: "Compute Host",
          platform: layers.host.platform || "Host",
          canonical_tag: layers.host.canonical_tag || "unspecified",
          status: layers.host.status,
          detected_from: layers.host.detected_from || [],
          constraints: layers.host.constraints || [],
          unresolved_inquiry: layers.host.unresolved_inquiry,
        },
        {
          id: "storage:primary",
          layer: "storage",
          name: "Primary Storage",
          platform: layers.storage.platform || "Database",
          canonical_tag: layers.storage.canonical_tag || "unspecified",
          status: layers.storage.status,
          detected_from: layers.storage.detected_from || [],
          constraints: layers.storage.constraints || [],
          unresolved_inquiry: layers.storage.unresolved_inquiry,
        },
        {
          id: "telemetry:primary",
          layer: "telemetry",
          name: "Telemetry Pipeline",
          platform: layers.telemetry.platform || "Logger",
          canonical_tag: "unspecified",
          status: layers.telemetry.status,
          detected_from: layers.telemetry.detected_from || [],
          constraints: layers.telemetry.constraints || [],
        }
      );
    } else {
      // Standard Single-Service Topology Nodes
      detectedNodes.push(
        {
          id: "edge:primary",
          layer: "edge",
          name: "Perimeter Edge WAF",
          platform: layers.edge.platform || "Edge",
          canonical_tag: layers.edge.canonical_tag || "unspecified",
          status: layers.edge.status,
          detected_from: layers.edge.detected_from || [],
          constraints: layers.edge.constraints || [],
          unresolved_inquiry: layers.edge.unresolved_inquiry,
        },
        {
          id: "gateway:primary",
          layer: "gateway",
          name: "Web Ingress",
          platform: layers.gateway.platform || "Gateway",
          canonical_tag: layers.gateway.canonical_tag || "unspecified",
          status: layers.gateway.status,
          detected_from: layers.gateway.detected_from || [],
          constraints: layers.gateway.constraints || [],
          connected_to: ["runtime:primary"],
          unresolved_inquiry: layers.gateway.unresolved_inquiry,
        },
        {
          id: "host:primary",
          layer: "host",
          name: "Primary Host",
          platform: layers.host.platform || "Host",
          canonical_tag: layers.host.canonical_tag || "unspecified",
          status: layers.host.status,
          detected_from: layers.host.detected_from || [],
          constraints: layers.host.constraints || [],
          unresolved_inquiry: layers.host.unresolved_inquiry,
        },
        {
          id: "runtime:primary",
          layer: "runtime",
          name: "Application Runtime",
          platform: layers.runtime.platform || "Runtime",
          canonical_tag: layers.runtime.canonical_tag || "unspecified",
          status: layers.runtime.status,
          detected_from: layers.runtime.detected_from || [],
          constraints: layers.runtime.constraints || [],
          connected_to: ["storage:primary"],
          unresolved_inquiry: layers.runtime.unresolved_inquiry,
        },
        {
          id: "storage:primary",
          layer: "storage",
          name: "Database & Cache",
          platform: layers.storage.platform || "Storage",
          canonical_tag: layers.storage.canonical_tag || "unspecified",
          status: layers.storage.status,
          detected_from: layers.storage.detected_from || [],
          constraints: layers.storage.constraints || [],
          unresolved_inquiry: layers.storage.unresolved_inquiry,
        },
        {
          id: "telemetry:primary",
          layer: "telemetry",
          name: "Observability Pipeline",
          platform: layers.telemetry.platform || "Logger",
          canonical_tag: "unspecified",
          status: layers.telemetry.status,
          detected_from: layers.telemetry.detected_from || [],
          constraints: layers.telemetry.constraints || [],
        }
      );
    }

    // 6. Merge with SQLite SSOT Nodes (Verified or manually added nodes take precedence)
    const finalNodes: TopologyNode[] = [];
    const processedIds = new Set<string>();

    for (const dNode of detectedNodes) {
      const saved = savedNodeMap.get(dNode.id);
      if (saved && saved.status === "VERIFIED") {
        finalNodes.push(saved);
      } else {
        finalNodes.push(dNode);
      }
      processedIds.add(dNode.id);
    }

    // Include any custom nodes from DB that were not part of heuristic detection
    for (const sNode of savedNodes) {
      if (!processedIds.has(sNode.id)) {
        finalNodes.push(sNode);
        processedIds.add(sNode.id);
      }
    }

    // 7. Save detected nodes to SQLite SSOT
    if (repo) {
      for (const node of finalNodes) {
        if (!savedNodeMap.has(node.id) || forceRefresh) {
          repo.environment.saveNode(node);
        }
      }
    }

    const isDistributed =
      finalNodes.length > 6 ||
      finalNodes.filter((n) => n.layer === "host").length > 1 ||
      subservices.length > 0 ||
      finalNodes.some((n) => Boolean(n.domain_or_ip && n.domain_or_ip.includes(".")));

    // 8. Generate Cross-Layer & Distributed Interplays
    const interplays = this.analyzeInterplays(layers, finalNodes);

    // 9. Collect pending inquiries from both layers and nodes
    const pendingInquiries: string[] = [];
    for (const node of finalNodes) {
      if ((node.status === "AMBIGUOUS" || node.status === "UNRESOLVED") && node.unresolved_inquiry) {
        pendingInquiries.push(`[Node: ${node.id} (${node.layer.toUpperCase()})] ${node.unresolved_inquiry}`);
      }
    }
    for (const layerKey of Object.keys(layers) as EnvironmentLayer[]) {
      const info = layers[layerKey];
      if ((info.status === "AMBIGUOUS" || info.status === "UNRESOLVED") && info.unresolved_inquiry) {
        const layerStr = `[Layer: ${layerKey.toUpperCase()}] ${info.unresolved_inquiry}`;
        if (!pendingInquiries.some((q) => q.includes(info.unresolved_inquiry!))) {
          pendingInquiries.push(layerStr);
        }
      }
    }

    const overallStatus = pendingInquiries.length === 0 ? "RESOLVED" : "NEEDS_CLARIFICATION";
    const architecturalSummary = this.composeSummary(layers, overallStatus, isDistributed, finalNodes.length);

    return {
      is_distributed: isDistributed,
      nodes: finalNodes,
      layers,
      overall_status: overallStatus,
      interplays,
      pending_inquiries: pendingInquiries,
      architectural_summary: architecturalSummary,
    };
  }

  private static inspectEdgeLayer(root: string): EnvironmentLayerInfo {
    const wranglerExists = fs.existsSync(path.join(root, "wrangler.toml")) || fs.existsSync(path.join(root, "wrangler.json"));
    const envMap = this.parseEnvFileSafe(path.join(root, ".env.example"));
    const realEnv = this.parseEnvFileSafe(path.join(root, ".env"));

    let hasCloudflareTurnstile = false;
    let hasCloudfront = false;
    for (const key of [...envMap.keys(), ...realEnv.keys()]) {
      if (key.startsWith("CLOUDFLARE_") || key.startsWith("TURNSTILE_")) hasCloudflareTurnstile = true;
      if (key.startsWith("CLOUDFRONT_") || key.startsWith("AWS_CF_")) hasCloudfront = true;
    }

    if (wranglerExists) {
      return {
        layer: "edge",
        platform: "Cloudflare (Workers / Pages / Edge)",
        canonical_tag: "cdn_edge",
        status: "DETECTED",
        detected_from: ["wrangler.toml"],
        constraints: [
          "Edge execution boundary applies with Cloudflare edge runtime limits.",
          "DNSSEC, WAF, and DDoS mitigation operate at the Cloudflare edge layer.",
        ],
      };
    }

    if (hasCloudflareTurnstile) {
      return {
        layer: "edge",
        platform: "Cloudflare (Edge Proxy, WAF & Bot Mitigation)",
        canonical_tag: "cdn_edge",
        status: "DETECTED",
        detected_from: [".env"],
        constraints: [
          "Client real IP must be extracted from 'CF-Connecting-IP' header.",
          "Application rate limiting (e.g. Throttle middleware) must trust Cloudflare IP ranges in TrustedProxy to avoid blocking proxy nodes.",
          "Bot mitigation challenges operate at Cloudflare Edge before origin receives HTTP traffic.",
        ],
      };
    }

    if (hasCloudfront) {
      return {
        layer: "edge",
        platform: "AWS CloudFront CDN",
        canonical_tag: "cdn_edge",
        status: "DETECTED",
        detected_from: [".env"],
        constraints: [
          "Client IP extracted via 'X-Forwarded-For' header with trusted proxy validation.",
          "Edge cache invalidation requires CloudFront API triggers.",
        ],
      };
    }

    return {
      layer: "edge",
      platform: "Direct Ingress / Unresolved Edge",
      canonical_tag: "unspecified",
      status: "AMBIGUOUS",
      detected_from: [],
      unresolved_inquiry: "Apakah domain menggunakan Edge WAF/Proxy (seperti Cloudflare) atau lalu lintas langsung mengarah ke IP server hosting?",
      constraints: [
        "Jika menggunakan Cloudflare: Wajib setting Trusted Proxies agar rate limiting tidak menganggap seluruh traffic berasal dari IP Cloudflare.",
      ],
    };
  }

  private static inspectGatewayLayer(root: string): EnvironmentLayerInfo {
    const rootHtaccess = path.join(root, ".htaccess");
    const publicHtaccess = path.join(root, "public", ".htaccess");
    const htaccessPath = fs.existsSync(publicHtaccess) ? publicHtaccess : fs.existsSync(rootHtaccess) ? rootHtaccess : null;

    const nginxConf = fs.existsSync(path.join(root, "nginx.conf")) || fs.existsSync(path.join(root, "docker", "nginx", "nginx.conf"));
    const caddyfile = fs.existsSync(path.join(root, "Caddyfile"));

    if (htaccessPath) {
      const content = this.readFileSafe(htaccessPath);
      const isLiteSpeed = content.includes("Litespeed") || content.includes("LSCache") || content.includes("<IfModule LiteSpeed>");

      return {
        layer: "gateway",
        platform: isLiteSpeed ? "LiteSpeed Web Server" : "Apache / LiteSpeed Web Server",
        canonical_tag: "shared_hosting",
        status: "DETECTED",
        detected_from: [path.relative(root, htaccessPath)],
        constraints: [
          "Routing, security headers, and rewrite rules are evaluated via .htaccess.",
          "Jika LiteSpeed aktif: Perhatikan module LSCache agar respons dinamis (seperti session/Inertia state) tidak ter-cache secara publik.",
          "Pastikan blokade akses file tersembunyi (.env, .git) terlindungi di level .htaccess.",
        ],
      };
    }

    if (nginxConf) {
      return {
        layer: "gateway",
        platform: "Nginx Reverse Proxy",
        canonical_tag: "vps",
        status: "DETECTED",
        detected_from: ["nginx.conf"],
        constraints: [
          "Inbound routing, fastcgi buffer size, dan client_max_body_size dikendalikan oleh konfigurasi Nginx.",
          "Header 'X-Forwarded-For' dan 'X-Forwarded-Proto' wajib diteruskan ke runtime aplikasi.",
        ],
      };
    }

    if (caddyfile) {
      return {
        layer: "gateway",
        platform: "Caddy Web Server",
        canonical_tag: "vps",
        status: "DETECTED",
        detected_from: ["Caddyfile"],
        constraints: ["Automatic TLS termination dan HTTP/3 active secara default."],
      };
    }

    return {
      layer: "gateway",
      platform: "Standard Ingress / Unknown Web Server",
      canonical_tag: "unspecified",
      status: "AMBIGUOUS",
      detected_from: [],
      unresolved_inquiry: "Web server apa yang menangani ingress HTTP (LiteSpeed, Nginx, Apache, atau Caddy)?",
      constraints: ["Konfigurasi rewrite rules dan upload limit harus disesuaikan dengan web server yang aktif."],
    };
  }

  private static inspectHostLayer(root: string, gateway: EnvironmentLayerInfo): EnvironmentLayerInfo {
    const hasDocker = fs.existsSync(path.join(root, "Dockerfile")) || fs.existsSync(path.join(root, "docker-compose.yml")) || fs.existsSync(path.join(root, "docker-compose.yaml"));
    const hasFly = fs.existsSync(path.join(root, "fly.toml"));
    const hasVercel = fs.existsSync(path.join(root, "vercel.json"));
    const hasRender = fs.existsSync(path.join(root, "render.yaml"));

    if (hasDocker) {
      return {
        layer: "host",
        platform: "Containerized Compute (Docker / Dedicated VPS)",
        canonical_tag: "docker",
        status: "DETECTED",
        detected_from: ["Dockerfile / docker-compose.yml"],
        constraints: [
          "Isolated rootfs and process namespace.",
          "Process supervision (systemd/supervisord) and persistent daemon background workers are supported.",
        ],
      };
    }

    if (hasFly) {
      return {
        layer: "host",
        platform: "Fly.io MicroVMs",
        canonical_tag: "paas",
        status: "DETECTED",
        detected_from: ["fly.toml"],
        constraints: ["Ephemeral rootfs with persistent volume mounts."],
      };
    }

    if (hasVercel) {
      return {
        layer: "host",
        platform: "Vercel Serverless Edge",
        canonical_tag: "serverless",
        status: "DETECTED",
        detected_from: ["vercel.json"],
        constraints: ["Stateless request execution; no long-running socket or daemon processes."],
      };
    }

    if (hasRender) {
      return {
        layer: "host",
        platform: "Render Cloud Platform",
        canonical_tag: "paas",
        status: "DETECTED",
        detected_from: ["render.yaml"],
        constraints: ["Managed compute container with managed SSL."],
      };
    }

    // Heuristic: If .htaccess is present with PHP/Laravel and no Docker manifests exist
    if (gateway.detected_from?.some((f) => f.includes(".htaccess"))) {
      return {
        layer: "host",
        platform: "Shared Hosting (Hostinger / cPanel) or Unmanaged VPS",
        canonical_tag: "shared_hosting",
        status: "AMBIGUOUS",
        detected_from: gateway.detected_from,
        unresolved_inquiry: "Apakah aplikasi di-hosting pada Shared Hosting (seperti Hostinger LiteSpeed/cPanel) atau VPS mandiri?",
        constraints: [
          "Jika Shared Hosting: Akses root/sudo tidak tersedia, memori dan batas CPU dikontrol ketat oleh cgroups/CloudLinux.",
          "Jika Shared Hosting: Background queue worker tidak bisa berjalan sebagai daemon persisten (seperti Horizon); antrean wajib dieksekusi via scheduled cron batch ('queue:work --stop-when-empty').",
          "Jika Shared Hosting: Eksekusi command shell (proc_open/exec) sering dibatasi di php.ini.",
        ],
      };
    }

    return {
      layer: "host",
      platform: "Virtual Server / Unknown Host",
      canonical_tag: "unspecified",
      status: "UNRESOLVED",
      detected_from: [],
      unresolved_inquiry: "Di platform hosting apa aplikasi akan di-deploy (Shared Hosting, VPS Linux, Kubernetes, atau PaaS)?",
      constraints: ["Karakteristik hak akses process daemon dan cron scheduler bergantung pada tipe host."],
    };
  }

  private static inspectRuntimeLayer(root: string): EnvironmentLayerInfo {
    const composerJson = path.join(root, "composer.json");
    const packageJson = path.join(root, "package.json");
    const goMod = path.join(root, "go.mod");

    if (fs.existsSync(composerJson)) {
      const content = this.readJsonSafe(composerJson);
      const phpVersion = content?.require?.php || ">=8.1";
      const isLaravel = Boolean(content?.require?.["laravel/framework"]);

      const inertiaVue = this.checkInertiaVue(packageJson);

      return {
        layer: "runtime",
        platform: `PHP ${phpVersion} (FPM / FastCGI)${isLaravel ? " + Laravel" : ""}${inertiaVue ? " + Inertia/Vue" : ""}`,
        status: "DETECTED",
        detected_from: ["composer.json", ...(inertiaVue ? ["package.json"] : [])],
        constraints: [
          "Stateless request-response lifecycle with opcode cache.",
          "Memory limit and max_execution_time governed by hosting php.ini pool.",
          ...(inertiaVue ? ["Inertia page visits utilize X-Inertia header protocol; cache rules must preserve dynamic state."] : []),
        ],
      };
    }

    if (fs.existsSync(goMod)) {
      return {
        layer: "runtime",
        platform: "Golang (Compiled Native Binary)",
        status: "DETECTED",
        detected_from: ["go.mod"],
        constraints: [
          "Single binary execution with goroutine concurrency pool.",
          "No external PHP-FPM or interpreter dependency.",
        ],
      };
    }

    if (fs.existsSync(packageJson)) {
      const content = this.readJsonSafe(packageJson);
      const nodeVersion = content?.engines?.node || ">=18";
      return {
        layer: "runtime",
        platform: `Node.js (${nodeVersion}) / Bun`,
        status: "DETECTED",
        detected_from: ["package.json"],
        constraints: [
          "Single-threaded asynchronous event loop.",
          "Uncaught promise rejections or long CPU tasks block the entire runtime loop.",
        ],
      };
    }

    return {
      layer: "runtime",
      platform: "Generic Runtime",
      status: "UNRESOLVED",
      detected_from: [],
      unresolved_inquiry: "Apa bahasa dan runtime execution model yang digunakan oleh aplikasi ini?",
      constraints: [],
    };
  }

  private static inspectStorageLayer(root: string): EnvironmentLayerInfo {
    const envMap = this.parseEnvFileSafe(path.join(root, ".env.example"));
    const realEnv = this.parseEnvFileSafe(path.join(root, ".env"));
    const mergedEnv = new Map([...envMap, ...realEnv]);
    const detectedStorage: string[] = [];

    const dbConn = mergedEnv.get("DB_CONNECTION")?.toLowerCase() || "";
    const dbPort = mergedEnv.get("DB_PORT") || "";

    if (dbConn === "mysql" || dbPort === "3306" || [...mergedEnv.keys()].some(k => k.startsWith("MYSQL_"))) {
      detectedStorage.push("MySQL / MariaDB");
    } else if (dbConn === "pgsql" || dbPort === "5432" || [...mergedEnv.keys()].some(k => k.startsWith("POSTGRES_"))) {
      detectedStorage.push("PostgreSQL");
    } else if (dbConn === "sqlite" || fs.existsSync(path.join(root, "database", "database.sqlite"))) {
      detectedStorage.push("SQLite (File-based)");
    }

    const queueConn = mergedEnv.get("QUEUE_CONNECTION")?.toLowerCase() || "";
    const redisHost = mergedEnv.get("REDIS_HOST");
    if (queueConn === "redis" || redisHost || mergedEnv.has("REDIS_CLIENT")) {
      detectedStorage.push("Redis (Cache & Queues)");
    }

    if (detectedStorage.length > 0) {
      return {
        layer: "storage",
        platform: detectedStorage.join(" + "),
        canonical_tag: "managed_db",
        status: "DETECTED",
        detected_from: [".env"],
        constraints: [
          "Database connection pool limits and socket timeouts must be configured.",
          "Pada Shared Hosting: Akses MySQL biasanya terikat ke 'localhost' / loopback dengan batas koneksi maksimal.",
        ],
      };
    }

    return {
      layer: "storage",
      platform: "Relational Database / Storage",
      canonical_tag: "unspecified",
      status: "AMBIGUOUS",
      detected_from: [],
      unresolved_inquiry: "Database dan caching layer apa yang digunakan (MySQL, Postgres, SQLite, Redis)?",
      constraints: ["Koneksi database wajib dikunci dengan connection pooling dan transactional isolation yang sesuai."],
    };
  }

  private static inspectTelemetryLayer(root: string): EnvironmentLayerInfo {
    const envExample = this.readFileSafe(path.join(root, ".env.example")) || this.readFileSafe(path.join(root, ".env"));
    const composerJson = this.readJsonSafe(path.join(root, "composer.json"));
    const packageJson = this.readJsonSafe(path.join(root, "package.json"));

    const hasSentry = envExample.includes("SENTRY_DSN") || Boolean(composerJson?.require?.["sentry/sentry-laravel"]) || Boolean(packageJson?.dependencies?.["@sentry/vue"] || packageJson?.dependencies?.["@sentry/browser"]);
    const hasOtel = envExample.includes("OTEL_") || Boolean(packageJson?.dependencies?.["@opentelemetry/api"]);

    if (hasSentry) {
      return {
        layer: "telemetry",
        platform: "Sentry Error & Performance Monitoring",
        status: "DETECTED",
        detected_from: ["Sentry SDK in dependencies / .env"],
        constraints: ["Unhandled exceptions and frontend breadcrumbs sent to Sentry with trace sampling."],
      };
    }

    if (hasOtel) {
      return {
        layer: "telemetry",
        platform: "OpenTelemetry Distributed Tracing",
        status: "DETECTED",
        detected_from: ["OpenTelemetry SDK"],
        constraints: ["Context propagation with W3C traceparent headers."],
      };
    }

    return {
      layer: "telemetry",
      platform: "Application Log Files (Local / Daily)",
      status: "DETECTED",
      detected_from: ["Standard Framework Logger"],
      constraints: [
        "Rotasi log harian (daily log rotation) wajib dijaga agar disk server/hosting tidak penuh.",
        "Error logs harus memuat correlation ID dan context data tanpa membocorkan kredensial PII.",
      ],
    };
  }

  private static analyzeInterplays(
    layers: Record<EnvironmentLayer, EnvironmentLayerInfo>,
    nodes: TopologyNode[] = []
  ): CrossLayerInterplay[] {
    const interplays: CrossLayerInterplay[] = [];

    // Canonical tag resolution
    const isCloudflare =
      layers.edge.canonical_tag === "cdn_edge" ||
      this.matchCanonicalTag(layers.edge.platform) === "cdn_edge" ||
      layers.edge.platform?.toLowerCase().includes("cloudflare") ||
      nodes.some((n) => n.canonical_tag === "cdn_edge" || n.platform?.toLowerCase().includes("cloudflare"));

    const isSharedHosting =
      layers.host.canonical_tag === "shared_hosting" ||
      this.matchCanonicalTag(layers.host.platform) === "shared_hosting" ||
      nodes.some((n) => n.canonical_tag === "shared_hosting" || this.matchCanonicalTag(n.platform) === "shared_hosting");

    const isLiteSpeedOrApache =
      layers.gateway.canonical_tag === "shared_hosting" ||
      layers.gateway.platform?.toLowerCase().includes("litespeed") ||
      layers.gateway.platform?.toLowerCase().includes("apache");

    // Interplay 1: Cloudflare WAF + Web Server + App Rate Limiting
    if (isCloudflare) {
      interplays.push({
        title: "Perimeter Bot Protection & Trusted Proxy Invariant",
        involved_layers: ["edge", "gateway", "runtime"],
        involved_node_ids: nodes.filter((n) => n.layer === "edge" || n.layer === "runtime").map((n) => n.id),
        risk_or_rule: "Cloudflare bertindak sebagai reverse proxy. Jika aplikasi tidak men-trust IP range Cloudflare, maka seluruh request klien tampak berasal dari IP node Cloudflare.",
        required_action: "Di runtime (Laravel/Express), konfigurasikan TrustedProxies middleware untuk mempercayai Cloudflare IPs dan membaca client IP asli dari header 'CF-Connecting-IP'. Ini krusial agar Throttle / Rate Limiter tidak memblokir Cloudflare secara massal saat ada serangan bot.",
      });
    }

    // Interplay 2: Shared Hosting + Queue Workers
    if (isSharedHosting) {
      interplays.push({
        title: "Shared Hosting Background Execution Invariant",
        involved_layers: ["host", "runtime"],
        involved_node_ids: nodes.filter((n) => n.layer === "host" || n.layer === "runtime").map((n) => n.id),
        risk_or_rule: "Shared Hosting (seperti Hostinger LiteSpeed) membatasi daemon background persisten dan membunuh proses long-running yang memakan CPU/memory.",
        required_action: "Jangan mengandalkan daemon persisten ('php artisan queue:listen' atau Horizon). Gunakan scheduler cron berkala dengan opsi batch ('php artisan queue:work --stop-when-empty --max-time=50') atau webhook serverless untuk memproses antrean.",
      });
    }

    // Interplay 3: LiteSpeed Caching vs Single Page / Inertia State
    if (isLiteSpeedOrApache && layers.runtime.platform?.toLowerCase().includes("inertia")) {
      interplays.push({
        title: "LiteSpeed Cache vs Inertia Dynamic State Invariant",
        involved_layers: ["gateway", "runtime"],
        involved_node_ids: nodes.filter((n) => n.layer === "gateway" || n.layer === "runtime").map((n) => n.id),
        risk_or_rule: "Fitur caching agresif pada LiteSpeed (.htaccess LSCache) dapat secara tidak sengaja meng-cache payload JSON Inertia atau respons halaman sesi pengguna.",
        required_action: "Pastikan aturan .htaccess mengecualikan caching pada request yang membawa header 'X-Inertia' atau cookie autentikasi ('laravel_session', 'XSRF-TOKEN').",
      });
    }

    // Distributed Interplay 4: Cross-Domain Cookie & CORS Invariant
    const domains = nodes.map((n) => n.domain_or_ip).filter((d): d is string => Boolean(d && d.includes(".")));
    const hasSeparateFrontendBackend =
      nodes.some((n) => n.role === "frontend_spa" || n.id.includes("frontend")) &&
      nodes.some((n) => n.role === "web_api" || n.id.includes("backend"));
    const hasMultipleDomains = new Set(domains).size > 1;

    if (hasMultipleDomains || hasSeparateFrontendBackend) {
      interplays.push({
        title: "Cross-Domain Cookie & CORS Security Invariant",
        involved_layers: ["edge", "gateway", "runtime"],
        involved_node_ids: nodes.filter((n) => n.layer === "runtime" || n.layer === "gateway").map((n) => n.id),
        risk_or_rule: "Frontend dan Backend beroperasi pada domain/subdomain berbeda atau decoupled SPA. Browser memblokir pengiriman cookie session/CSRF dan memicu CORS preflight (OPTIONS).",
        required_action: "Konfigurasikan backend CORS credentials=true dengan whitelist domain frontend spesifik. Untuk session cookie, setel 'SameSite=None; Secure' serta domain wildcard '.rootdomain.com' jika berbagi root domain.",
      });
    }

    // Distributed Interplay 5: Database Migration Concurrency Invariant
    const computeNodes = nodes.filter((n) => n.layer === "host" || (n.layer === "runtime" && n.role !== "frontend_spa"));
    if (computeNodes.length > 1) {
      interplays.push({
        title: "Distributed Database Migration Concurrency Invariant",
        involved_layers: ["host", "storage"],
        involved_node_ids: computeNodes.map((n) => n.id),
        risk_or_rule: "Terdapat lebih dari 1 instance host/compute (multi-VPS / multi-node) yang terhubung ke database bersama. Menjalankan migrasi database serentak saat deployment memicu deadlock tabel atau migration race condition.",
        required_action: "Pastikan script migrasi (seperti 'artisan migrate --isolated') hanya dijalankan oleh satu designated deploy pipeline runner sebelum node lain menerima traffic.",
      });
    }

    // Distributed Interplay 6: Distributed Scheduler Duplication Invariant
    const hostNodes = nodes.filter((n) => n.layer === "host");
    if (hostNodes.length > 1) {
      interplays.push({
        title: "Distributed Scheduler & Cron Invariant",
        involved_layers: ["host", "runtime"],
        involved_node_ids: hostNodes.map((n) => n.id),
        risk_or_rule: "Beberapa server host aktif secara paralel. Jika scheduler cron dipasang di semua instance VPS, task terjadwal (seperti batch email atau billing) akan terduplikasi.",
        required_action: "Kunci scheduler menggunakan atomic cache mutex lock ('schedule:run' dengan 'withoutOverlapping()') atau tetapkan 1 VPS khusus sebagai Dedicated Worker Node.",
      });
    }

    return interplays;
  }

  private static composeSummary(
    layers: Record<EnvironmentLayer, EnvironmentLayerInfo>,
    status: "RESOLVED" | "NEEDS_CLARIFICATION",
    isDistributed: boolean = false,
    nodeCount: number = 6
  ): string {
    const topologyMode = isDistributed ? `Distributed Multi-Node (${nodeCount} nodes)` : "Monolithic Single-Node";
    const edge = layers.edge.platform || "Direct";
    const gateway = layers.gateway.platform || "Standard Ingress";
    const host = layers.host.platform || "Unknown Host";
    const runtime = layers.runtime.platform || "Standard Runtime";
    const storage = layers.storage.platform || "Standard Storage";

    return `Architecture Plane: [${topologyMode}]. Pipeline: [Edge: ${edge}] ➔ [Gateway: ${gateway}] ➔ [Host: ${host}] ➔ [Runtime: ${runtime}] ➔ [Storage: ${storage}]. Status: ${status}.`;
  }

  private static checkInertiaVue(packageJsonPath: string): boolean {
    if (!fs.existsSync(packageJsonPath)) return false;
    const content = this.readJsonSafe(packageJsonPath);
    return Boolean(
      content?.dependencies?.["@inertiajs/vue3"] ||
      content?.dependencies?.["@inertiajs/inertia-vue3"] ||
      content?.devDependencies?.["@inertiajs/vue3"]
    );
  }

  public static parseEnvFileSafe(filePath: string): Map<string, string> {
    const map = new Map<string, string>();
    const raw = this.readFileSafe(filePath);
    if (!raw) return map;

    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      map.set(key, val);
    }
    return map;
  }

  public static matchCanonicalTag(str?: string): CanonicalPlatformTag {
    if (!str) return "unspecified";
    const s = str.toLowerCase();
    if (s.includes("shared") || s.includes("hostinger") || s.includes("cpanel") || s.includes("litespeed")) return "shared_hosting";
    if (s.includes("docker") || s.includes("compose") || s.includes("container")) return "docker";
    if (s.includes("k8s") || s.includes("kubernetes") || s.includes("helm")) return "kubernetes";
    if (s.includes("vps") || s.includes("dedicated") || s.includes("digitalocean") || s.includes("linode") || s.includes("ubuntu")) return "vps";
    if (s.includes("cloudflare") || s.includes("cloudfront") || s.includes("fastly") || s.includes("akamai")) return "cdn_edge";
    if (s.includes("vercel") || s.includes("serverless") || s.includes("lambda")) return "serverless";
    if (s.includes("fly.io") || s.includes("render") || s.includes("railway") || s.includes("heroku")) return "paas";
    if (s.includes("rds") || s.includes("managed") || s.includes("supabase") || s.includes("planetscale")) return "managed_db";
    return "unspecified";
  }

  public static probeSubservices(workspaceRoot: string): { path: string; name: string; type: "backend" | "frontend" | "service" }[] {
    const subservices: { path: string; name: string; type: "backend" | "frontend" | "service" }[] = [];
    const candidateDirs = ["backend", "frontend", "api", "web", "client", "ui", "services", "apps"];
    for (const dir of candidateDirs) {
      const fullDir = path.join(workspaceRoot, dir);
      if (fs.existsSync(fullDir)) {
        try {
          const stat = fs.statSync(fullDir);
          if (!stat.isDirectory()) continue;

          if (dir === "apps" || dir === "services") {
            const entries = fs.readdirSync(fullDir, { withFileTypes: true });
            for (const e of entries) {
              if (e.isDirectory()) {
                const nestedPath = path.join(fullDir, e.name);
                const isFrontend = e.name.toLowerCase().includes("web") || e.name.toLowerCase().includes("ui") || e.name.toLowerCase().includes("client");
                subservices.push({
                  path: nestedPath,
                  name: `${dir}-${e.name}`,
                  type: isFrontend ? "frontend" : "service",
                });
              }
            }
          } else {
            const isFrontend = dir === "frontend" || dir === "web" || dir === "client" || dir === "ui";
            subservices.push({ path: fullDir, name: dir, type: isFrontend ? "frontend" : "backend" });
          }
        } catch {
          // Ignore filesystem errors
        }
      }
    }
    return subservices;
  }

  private static readFileSafe(filePath: string): string {
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, "utf-8");
      }
    } catch {
      // Ignored
    }
    return "";
  }

  private static readJsonSafe(filePath: string): Record<string, any> | null {
    try {
      if (fs.existsSync(filePath)) {
        const text = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(text);
      }
    } catch {
      // Ignored
    }
    return null;
  }
}
