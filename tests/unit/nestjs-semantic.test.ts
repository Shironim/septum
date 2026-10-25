import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NestJsSemanticExtractor } from "../../src/core/parser/extractors/nestjs-semantic.ts";

describe("TS-03 — NestJS Semantic AST Extractor (AST-Native & Async)", () => {
  let tmpDir: string;
  const extractor = new NestJsSemanticExtractor();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-nest-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts routes, DTOs, guards, and explicit service calls from AST", async () => {
    const controllerPath = path.join(tmpDir, "src/orders.controller.ts");
    fs.mkdirSync(path.dirname(controllerPath), { recursive: true });

    const code = `
import { Controller, Get, Post, Body, Param, UseGuards } from "@nestjs/common";
import { AuthGuard } from "./auth.guard";
import { CreateOrderDto } from "./create-order.dto";
import { OrderService } from "./order.service";

@Controller("api/v1/orders")
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(
    private readonly orderService: OrderService,
    private readonly uncalledService: UncalledService
  ) {}

  @Post()
  async createOrder(@Body() dto: CreateOrderDto) {
    return await this.orderService.create(dto);
  }

  @Get(":id")
  async getOrder(@Param("id") id: string) {
    return this.orderService.findById(id);
  }
}
`;
    fs.writeFileSync(controllerPath, code);

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(2);

    // 1. POST route verification
    const postSlice = slices.find((s) => s.http_method === "POST");
    expect(postSlice).toBeDefined();
    expect(postSlice?.route_uri).toBe("/api/v1/orders");
    expect(postSlice?.controller_class).toBe("OrdersController");
    expect(postSlice?.action_name).toBe("createOrder");

    const postChain = JSON.parse(postSlice!.execution_chain_json);
    expect(postChain.some((c: any) => c.stage === "ingress" && c.symbol === "POST /api/v1/orders")).toBe(true);
    expect(postChain.some((c: any) => c.stage === "guard" && c.symbol === "AuthGuard")).toBe(true);
    expect(postChain.some((c: any) => c.stage === "validation" && c.symbol === "CreateOrderDto")).toBe(true);
    expect(postChain.some((c: any) => c.stage === "controller" && c.symbol === "OrdersController::createOrder")).toBe(true);
    expect(postChain.some((c: any) => c.stage === "service" && c.symbol === "OrderService::create")).toBe(true);

    // 2. GET route verification
    const getSlice = slices.find((s) => s.http_method === "GET");
    expect(getSlice).toBeDefined();
    expect(getSlice?.route_uri).toBe("/api/v1/orders/:id");
    expect(getSlice?.action_name).toBe("getOrder");

    const getChain = JSON.parse(getSlice!.execution_chain_json);
    expect(getChain.some((c: any) => c.stage === "service" && c.symbol === "OrderService::findById")).toBe(true);
    // Uncalled service should NOT be hallucinated into execution chain
    expect(getChain.some((c: any) => c.symbol?.includes("UncalledService"))).toBe(false);
  });

  it("handles stacked decorators and ignores decorator text in comments and strings", async () => {
    const controllerPath = path.join(tmpDir, "src/items.controller.ts");
    fs.mkdirSync(path.dirname(controllerPath), { recursive: true });

    const code = `
@Controller()
export class ItemsController {
  // @Post('/fake-comment')
  /* @Delete('/fake-block') */
  @Get("items")
  @HttpCode(200)
  @Header("Cache-Control", "none")
  getItems() {
    const fake = "@Put('/fake-string')";
    return [];
  }
}
`;
    fs.writeFileSync(controllerPath, code);

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(1);
    expect(slices[0].route_uri).toBe("/items");
    expect(slices[0].http_method).toBe("GET");
    expect(slices[0].action_name).toBe("getItems");
  });

  it("resolves physical service file and penetrates to TypeORM persistence layer (L5)", async () => {
    const controllerPath = path.join(tmpDir, "src/orders.controller.ts");
    const servicePath = path.join(tmpDir, "src/order.service.ts");
    const entityPath = path.join(tmpDir, "src/order.entity.ts");

    fs.mkdirSync(path.dirname(controllerPath), { recursive: true });

    // 1. Entity
    fs.writeFileSync(
      entityPath,
      `
export class Order {
  id: number;
  total: number;
}
      `.trim()
    );

    // 2. Service injecting TypeORM repository
    fs.writeFileSync(
      servicePath,
      `
import { Injectable } from "@nestjs/common";
import { Repository } from "typeorm";
import { Order } from "./order.entity";

@Injectable()
export class OrderService {
  constructor(
    private readonly orderRepository: Repository<Order>
  ) {}

  async create(data: any): Promise<Order> {
    return this.orderRepository.save(data);
  }
}
      `.trim()
    );

    // 3. Controller
    fs.writeFileSync(
      controllerPath,
      `
import { Controller, Post, Body } from "@nestjs/common";
import { OrderService } from "./order.service";

@Controller("orders")
export class OrdersController {
  constructor(private readonly orderService: OrderService) {}

  @Post()
  async placeOrder(@Body() payload: any) {
    return this.orderService.create(payload);
  }
}
      `.trim()
    );

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(1);

    const slice = slices[0];
    expect(slice.http_method).toBe("POST");
    expect(slice.route_uri).toBe("/orders");

    const chain = JSON.parse(slice.execution_chain_json);

    // Verify L4: Physical service link
    const svcNode = chain.find((c: any) => c.stage === "service");
    expect(svcNode).toBeDefined();
    expect(svcNode?.symbol).toBe("OrderService::create");
    expect(svcNode?.file).toBe("src/order.service.ts");
    expect(svcNode?.line).toBeGreaterThanOrEqual(10);

    // Verify L5: Repository & Entity persistence link
    const repoNode = chain.find((c: any) => c.stage === "repository");
    expect(repoNode).toBeDefined();
    expect(repoNode?.symbol).toBe("OrderRepository");
    expect(repoNode?.file).toBe("src/order.service.ts");

    const entityNode = chain.find((c: any) => c.stage === "entity");
    expect(entityNode).toBeDefined();
    expect(entityNode?.symbol).toBe("Order");
    expect(entityNode?.file).toBe("src/order.entity.ts");
  });
});

