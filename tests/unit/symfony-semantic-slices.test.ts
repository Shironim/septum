import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SymfonySemanticExtractor } from "../../src/core/parser/extractors/symfony-semantic.ts";
import type { ExecutionChainNode } from "../../src/types/index.ts";

describe("SymfonySemanticExtractor - Attribute Routes (PHP-04)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-symfony-"));

    // 1. Setup composer.json and bin/console marker
    fs.mkdirSync(path.join(tempDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "bin/console"), "#!/usr/bin/env php\n<?php\n");

    fs.writeFileSync(
      path.join(tempDir, "composer.json"),
      JSON.stringify({
        autoload: {
          "psr-4": {
            "App\\": "src/",
          },
        },
        require: {
          "symfony/framework-bundle": "^7.0",
          "symfony/routing": "^7.0",
        },
      }),
      "utf-8"
    );

    // 2. Setup src/Controller and src/Service
    fs.mkdirSync(path.join(tempDir, "src/Controller"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "src/Service"), { recursive: true });

    // 3. Service definition
    fs.writeFileSync(
      path.join(tempDir, "src/Service/OrderService.php"),
      `<?php
namespace App\\Service;

class OrderService
{
    public function calculateTotal(): int { return 100; }
}
`,
      "utf-8"
    );

    // 4. Controller with class-level and method-level #[Route] attributes
    fs.writeFileSync(
      path.join(tempDir, "src/Controller/OrderController.php"),
      `<?php
namespace App\\Controller;

use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;
use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\Routing\\Attribute\\Route;
use App\\Service\\OrderService;

#[Route('/api/orders', name: 'api_orders_')]
class OrderController extends AbstractController
{
    #[Route('', name: 'index', methods: ['GET'])]
    public function index(): Response
    {
        return new Response('list');
    }

    #[Route('/{id}', name: 'show', methods: ['GET'])]
    public function show(int $id, OrderService $orderService): Response
    {
        return new Response('detail');
    }

    #[Route('', name: 'create', methods: ['POST'])]
    public function create(Request $request, OrderService $orderService): Response
    {
        return new Response('created', 201);
    }
}
`,
      "utf-8"
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Happy Path", () => {
    it("detects Symfony topology and extracts attribute routes with prefix composition", async () => {
      const extractor = new SymfonySemanticExtractor(tempDir);
      expect(extractor.canHandle(tempDir, "symfony")).toBe(true);

      const slices = await extractor.extractSlices(tempDir);
      expect(slices.length).toBe(3);

      // Verify GET /api/orders
      const indexSlice = slices.find((s) => s.http_method === "GET" && s.route_uri === "/api/orders");
      expect(indexSlice).toBeDefined();
      expect(indexSlice?.controller_class).toBe("App\\Controller\\OrderController");
      expect(indexSlice?.action_name).toBe("index");
      expect(indexSlice?.route_name).toBe("api_orders_index");
      expect(indexSlice?.controller_file).toBe("src/Controller/OrderController.php");

      // Verify GET /api/orders/{id} with injected service
      const showSlice = slices.find((s) => s.http_method === "GET" && s.route_uri === "/api/orders/{id}");
      expect(showSlice).toBeDefined();
      expect(showSlice?.route_name).toBe("api_orders_show");

      const showChain: ExecutionChainNode[] = JSON.parse(showSlice!.execution_chain_json);
      const serviceNode = showChain.find((n) => n.stage === "service");
      expect(serviceNode).toBeDefined();
      expect(serviceNode?.symbol).toBe("OrderService");
      expect(serviceNode?.file).toBe("src/Service/OrderService.php");

      // Verify POST /api/orders with request and service
      const createSlice = slices.find((s) => s.http_method === "POST" && s.route_uri === "/api/orders");
      expect(createSlice).toBeDefined();

      const createChain: ExecutionChainNode[] = JSON.parse(createSlice!.execution_chain_json);
      const valNode = createChain.find((n) => n.stage === "validation");
      expect(valNode).toBeDefined();
      expect(valNode?.symbol).toBe("Request");
    });
  });

  describe("Edge Cases", () => {
    it("handles standalone method-level #[Route] without class-level prefix", async () => {
      fs.writeFileSync(
        path.join(tempDir, "src/Controller/HealthController.php"),
        `<?php
namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\Routing\\Attribute\\Route;

class HealthController
{
    #[Route('/health')]
    public function check(): Response
    {
        return new Response('OK');
    }
}
`,
        "utf-8"
      );

      const extractor = new SymfonySemanticExtractor(tempDir);
      const slices = await extractor.extractSlices(tempDir);

      const healthSlice = slices.find((s) => s.route_uri === "/health");
      expect(healthSlice).toBeDefined();
      expect(healthSlice?.http_method).toBe("GET"); // defaults to GET when methods omitted
      expect(healthSlice?.controller_class).toBe("App\\Controller\\HealthController");
      expect(healthSlice?.action_name).toBe("check");
    });

    it("expands multiple HTTP verbs on a single route attribute into separate slices", async () => {
      fs.writeFileSync(
        path.join(tempDir, "src/Controller/WebhookController.php"),
        `<?php
namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\Routing\\Attribute\\Route;

class WebhookController
{
    #[Route('/webhook/receiver', methods: ['POST', 'PUT'])]
    public function receive(): Response
    {
        return new Response('ack');
    }
}
`,
        "utf-8"
      );

      const extractor = new SymfonySemanticExtractor(tempDir);
      const slices = await extractor.extractSlices(tempDir);

      const postWebhook = slices.find((s) => s.route_uri === "/webhook/receiver" && s.http_method === "POST");
      const putWebhook = slices.find((s) => s.route_uri === "/webhook/receiver" && s.http_method === "PUT");
      expect(postWebhook).toBeDefined();
      expect(putWebhook).toBeDefined();
    });
  });

  describe("Unhappy Path", () => {
    it("handles controller without route attributes gracefully", async () => {
      fs.writeFileSync(
        path.join(tempDir, "src/Controller/PlainController.php"),
        `<?php
namespace App\\Controller;

class PlainController
{
    public function helperMethod(): void {}
}
`,
        "utf-8"
      );

      const extractor = new SymfonySemanticExtractor(tempDir);
      const slices = await extractor.extractSlices(tempDir);

      const plainSlice = slices.find((s) => s.controller_class.includes("PlainController"));
      expect(plainSlice).toBeUndefined();
    });

    it("returns empty array when project has no controllers or routes", async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-empty-symfony-"));
      try {
        const extractor = new SymfonySemanticExtractor(emptyDir);
        const slices = await extractor.extractSlices(emptyDir);
        expect(slices).toEqual([]);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });
});

