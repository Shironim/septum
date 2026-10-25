import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { GoSemanticExtractor } from "../../src/core/parser/extractors/go-semantic.ts";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `septum-test-${prefix}-`));
}

describe("GoSemanticExtractor (Gin, Echo, Chi)", () => {
  const extractor = new GoSemanticExtractor();

  it("should detect Gin / Echo / Chi frameworks in go.mod and extract full execution slices", () => {
    const tempDir = createTempDir("golang");

    try {
      // 1. Mock go.mod
      const goModContent = `
module myapp

go 1.22

require (
    github.com/gin-gonic/gin v1.9.1
    github.com/labstack/echo/v4 v4.11.4
    github.com/go-chi/chi/v5 v5.0.12
)
      `.trim();
      fs.writeFileSync(path.join(tempDir, "go.mod"), goModContent);
      expect(extractor.canHandle(tempDir)).toBe(true);

      // 2. Mock handlers file: internal/delivery/http/order_handler.go
      const handlerDir = path.join(tempDir, "internal", "delivery", "http");
      fs.mkdirSync(handlerDir, { recursive: true });

      const handlerCode = `
package http

import (
    "net/http"
    "github.com/gin-gonic/gin"
)

type OrderHandler struct {
    orderService OrderService
    orderRepo    OrderRepository
}

type CreateOrderRequest struct {
    CustomerID string  \`json:"customer_id"\`
    Amount     float64 \`json:"amount"\`
}

func (h *OrderHandler) CreateOrder(c *gin.Context) {
    var req CreateOrderRequest
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }

    order, err := h.orderService.ProcessOrder(c.Request.Context(), req)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }

    c.JSON(http.StatusCreated, order)
}

func (h *OrderHandler) GetOrderByID(c *gin.Context) {
    id := c.Param("id")
    c.JSON(http.StatusOK, gin.H{"id": id})
}
      `.trim();
      fs.writeFileSync(path.join(handlerDir, "order_handler.go"), handlerCode);

      // 3. Mock routes file: cmd/api/router.go
      const cmdDir = path.join(tempDir, "cmd", "api");
      fs.mkdirSync(cmdDir, { recursive: true });

      const routerCode = `
package main

import (
    "github.com/gin-gonic/gin"
    "myapp/internal/delivery/http"
)

func SetupRouter(h *http.OrderHandler) *gin.Engine {
    r := gin.Default()

    v1 := r.Group("/api/v1")
    orders := v1.Group("/orders")
    {
        orders.POST("", h.CreateOrder)
        orders.GET("/:id", h.GetOrderByID)
    }

    return r
}
      `.trim();
      fs.writeFileSync(path.join(cmdDir, "router.go"), routerCode);

      // 4. Extract slices
      const slices = extractor.extractSlices(tempDir);
      expect(slices.length).toBe(2);

      // Verify POST /api/v1/orders
      const postSlice = slices.find((s) => s.http_method === "POST");
      expect(postSlice).toBeDefined();
      expect(postSlice?.route_uri).toBe("/api/v1/orders");
      expect(postSlice?.action_name).toBe("CreateOrder");
      expect(postSlice?.controller_class).toBe("OrderHandler");

      const postChain = JSON.parse(postSlice!.execution_chain_json);
      expect(postChain.some((c: any) => c.stage === "ingress" && c.symbol.includes("POST /api/v1/orders"))).toBe(true);
      expect(postChain.some((c: any) => c.stage === "validation" && c.symbol === "CreateOrderRequest")).toBe(true);
      expect(postChain.some((c: any) => c.stage === "controller" && c.symbol.includes("OrderHandler::CreateOrder"))).toBe(true);
      expect(postChain.some((c: any) => c.stage === "service" && c.symbol.includes("orderService::ProcessOrder"))).toBe(true);

      // Verify GET /api/v1/orders/:id
      const getSlice = slices.find((s) => s.http_method === "GET");
      expect(getSlice).toBeDefined();
      expect(getSlice?.route_uri).toBe("/api/v1/orders/:id");
      expect(getSlice?.action_name).toBe("GetOrderByID");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should extract Chi router endpoint slices", () => {
    const tempDir = createTempDir("chi");

    try {
      fs.writeFileSync(path.join(tempDir, "go.mod"), "module app\nrequire github.com/go-chi/chi/v5 v5.0.12\n");

      const chiCode = `
package main

import (
    "net/http"
    "github.com/go-chi/chi/v5"
)

type ArticleHandler struct{}

func (h *ArticleHandler) GetArticle(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("article"))
}

func (h *ArticleHandler) DeleteArticle(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusNoContent)
}

func Routes(h *ArticleHandler) chi.Router {
    r := chi.NewRouter()
    r.Get("/articles/{id}", h.GetArticle)
    r.Delete("/articles/{id}", h.DeleteArticle)
    return r
}
      `.trim();

      fs.writeFileSync(path.join(tempDir, "main.go"), chiCode);

      const slices = extractor.extractSlices(tempDir);
      expect(slices.length).toBe(2);

      const getSlice = slices.find((s) => s.http_method === "GET");
      expect(getSlice).toBeDefined();
      expect(getSlice?.route_uri).toBe("/articles/{id}");
      expect(getSlice?.action_name).toBe("GetArticle");

      const delSlice = slices.find((s) => s.http_method === "DELETE");
      expect(delSlice).toBeDefined();
      expect(delSlice?.route_uri).toBe("/articles/{id}");
      expect(delSlice?.action_name).toBe("DeleteArticle");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should extract net/http standard library routes with Go 1.22+ patterns (GO-03)", () => {
    const tempDir = createTempDir("nethttp");

    try {
      fs.writeFileSync(path.join(tempDir, "go.mod"), "module nethttpapp\n\ngo 1.22\n");

      const code = `
package main

import (
    "net/http"
)

type UserHandler struct{}

func (h *UserHandler) GetUsers(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("users"))
}

func (h *UserHandler) CreateUser(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusCreated)
}

func pingHandler(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("pong"))
}

func RegisterRoutes(mux *http.ServeMux, h *UserHandler) {
    http.HandleFunc("/ping", pingHandler)
    mux.HandleFunc("GET /api/users", h.GetUsers)
    mux.HandleFunc("POST /api/users", h.CreateUser)
}
      `.trim();

      fs.writeFileSync(path.join(tempDir, "main.go"), code);

      const slices = extractor.extractSlices(tempDir);
      expect(slices.length).toBe(3);

      // Verify /ping (method ANY)
      const pingSlice = slices.find((s) => s.route_uri === "/ping");
      expect(pingSlice).toBeDefined();
      expect(pingSlice?.http_method).toBe("ANY");
      expect(pingSlice?.action_name).toBe("pingHandler");

      // Verify GET /api/users
      const getSlice = slices.find((s) => s.http_method === "GET");
      expect(getSlice).toBeDefined();
      expect(getSlice?.route_uri).toBe("/api/users");
      expect(getSlice?.controller_class).toBe("UserHandler");
      expect(getSlice?.action_name).toBe("GetUsers");

      // Verify POST /api/users
      const postSlice = slices.find((s) => s.http_method === "POST");
      expect(postSlice).toBeDefined();
      expect(postSlice?.route_uri).toBe("/api/users");
      expect(postSlice?.controller_class).toBe("UserHandler");
      expect(postSlice?.action_name).toBe("CreateUser");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should isolate group prefixes across different files to prevent collision (GO-04)", () => {
    const tempDir = createTempDir("scope-collision");

    try {
      fs.writeFileSync(path.join(tempDir, "go.mod"), "module myapp\n\ngo 1.22\nrequire github.com/gin-gonic/gin v1.9.1\n");

      // File A: Public API routes
      const apiDir = path.join(tempDir, "api");
      fs.mkdirSync(apiDir, { recursive: true });
      const fileACode = `
package api

import "github.com/gin-gonic/gin"

func SetupPublicRoutes(r *gin.Engine) {
    v1 := r.Group("/api/v1")
    orders := v1.Group("/orders")
    orders.POST("", CreateOrder)
}

func CreateOrder(c *gin.Context) {
    c.String(200, "created")
}
      `.trim();
      fs.writeFileSync(path.join(apiDir, "public.go"), fileACode);

      // File B: Internal Admin routes using the same variable names (v1)
      const adminDir = path.join(tempDir, "admin");
      fs.mkdirSync(adminDir, { recursive: true });
      const fileBCode = `
package admin

import "github.com/gin-gonic/gin"

func SetupAdminRoutes(r *gin.Engine) {
    v1 := r.Group("/internal/v1")
    metrics := v1.Group("/metrics")
    metrics.GET("", GetMetrics)
}

func GetMetrics(c *gin.Context) {
    c.String(200, "metrics")
}
      `.trim();
      fs.writeFileSync(path.join(adminDir, "admin.go"), fileBCode);

      const slices = extractor.extractSlices(tempDir);
      expect(slices.length).toBe(2);

      const orderSlice = slices.find((s) => s.action_name === "CreateOrder");
      expect(orderSlice).toBeDefined();
      expect(orderSlice?.route_uri).toBe("/api/v1/orders");

      const metricSlice = slices.find((s) => s.action_name === "GetMetrics");
      expect(metricSlice).toBeDefined();
      expect(metricSlice?.route_uri).toBe("/internal/v1/metrics");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should not hallucinate DTO names when request type is unresolvable (GO-04)", () => {
    const tempDir = createTempDir("nodto-hallucination");

    try {
      fs.writeFileSync(path.join(tempDir, "go.mod"), "module myapp\n\ngo 1.22\nrequire github.com/gin-gonic/gin v1.9.1\n");

      const code = `
package main

import (
    "net/http"
    "github.com/gin-gonic/gin"
)

type DynamicHandler struct{}

func (h *DynamicHandler) ProcessUntyped(c *gin.Context) {
    var raw map[string]interface{}
    if err := c.ShouldBindJSON(&raw); err != nil {
        return
    }
    c.JSON(200, raw)
}

func SetupRouter(r *gin.Engine, h *DynamicHandler) {
    r.POST("/dynamic", h.ProcessUntyped)
}
      `.trim();

      fs.writeFileSync(path.join(tempDir, "main.go"), code);

      const slices = extractor.extractSlices(tempDir);
      expect(slices.length).toBe(1);

      const slice = slices[0];
      const chain = JSON.parse(slice.execution_chain_json);

      // Ensure validation stage is NOT present (no invented "RawRequest")
      expect(chain.some((c: any) => c.stage === "validation")).toBe(false);
      expect(chain.some((c: any) => c.stage === "controller" && c.symbol === "DynamicHandler::ProcessUntyped")).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should extract Echo router group and DTO binding slices (GO-05a)", () => {
    const tempDir = createTempDir("echo");

    try {
      fs.writeFileSync(path.join(tempDir, "go.mod"), "module echoapp\n\ngo 1.22\nrequire github.com/labstack/echo/v4 v4.11.4\n");

      const code = `
package main

import (
    "net/http"
    "github.com/labstack/echo/v4"
)

type AuthHandler struct{}

type LoginPayload struct {
    Username string \`json:"username"\`
    Password string \`json:"password"\`
}

func (h *AuthHandler) Login(c echo.Context) error {
    req := LoginPayload{}
    if err := c.Bind(&req); err != nil {
        return err
    }
    return c.NoContent(http.StatusOK)
}

func Routes(e *echo.Echo, h *AuthHandler) {
    g := e.Group("/auth")
    g.POST("/login", h.Login)
}
      `.trim();

      fs.writeFileSync(path.join(tempDir, "main.go"), code);

      const slices = extractor.extractSlices(tempDir);
      expect(slices.length).toBe(1);

      const slice = slices[0];
      expect(slice.http_method).toBe("POST");
      expect(slice.route_uri).toBe("/auth/login");
      expect(slice.controller_class).toBe("AuthHandler");
      expect(slice.action_name).toBe("Login");

      const chain = JSON.parse(slice.execution_chain_json);
      expect(chain.some((c: any) => c.stage === "validation" && c.symbol === "LoginPayload")).toBe(true);
      expect(chain.some((c: any) => c.stage === "controller" && c.symbol === "AuthHandler::Login")).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should extract routes from method-based setup and anonymous closures (edge cases)", () => {
    const tempDir = createTempDir("server-methods");

    try {
      fs.writeFileSync(path.join(tempDir, "go.mod"), "module serverapp\n\ngo 1.22\nrequire github.com/gin-gonic/gin v1.9.1\n");

      const code = `
package main

import (
    "net/http"
    "github.com/gin-gonic/gin"
)

type Server struct {
    router *gin.Engine
}

func (s *Server) ping(c *gin.Context) {
    c.String(200, "pong")
}

func (s *Server) SetupRoutes() {
    s.router.GET("/ping", s.ping)
    s.router.GET("/health", func(c *gin.Context) {
        c.String(200, "ok")
    })
}
      `.trim();

      fs.writeFileSync(path.join(tempDir, "main.go"), code);

      const slices = extractor.extractSlices(tempDir);
      expect(slices.length).toBe(2);

      const pingSlice = slices.find((s) => s.route_uri === "/ping");
      expect(pingSlice).toBeDefined();
      expect(pingSlice?.controller_class).toBe("Server");
      expect(pingSlice?.action_name).toBe("ping");

      const healthSlice = slices.find((s) => s.route_uri === "/health");
      expect(healthSlice).toBeDefined();
      expect(healthSlice?.action_name).toBe("closure");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should extract Fiber routes and c.BodyParser(&req) DTO validation", () => {
    const tempDir = createTempDir("fiber");

    try {
      fs.writeFileSync(path.join(tempDir, "go.mod"), "module fiberapp\n\ngo 1.22\nrequire github.com/gofiber/fiber/v2 v2.52.0\n");

      const code = `
package main

import (
    "github.com/gofiber/fiber/v2"
)

type FiberOrderHandler struct {}

type CreateFiberOrderRequest struct {
    Item string \`json:"item"\`
}

func (h *FiberOrderHandler) CreateOrder(c *fiber.Ctx) error {
    var req CreateFiberOrderRequest
    if err := c.BodyParser(&req); err != nil {
        return c.Status(400).SendString(err.Error())
    }
    return c.SendStatus(201)
}

func SetupFiber(h *FiberOrderHandler) *fiber.App {
    app := fiber.New()
    api := app.Group("/api")
    api.Post("/fiber-orders", h.CreateOrder)
    return app
}
      `.trim();

      fs.writeFileSync(path.join(tempDir, "main.go"), code);

      const slices = extractor.extractSlices(tempDir);
      expect(slices.length).toBe(1);

      const slice = slices[0];
      expect(slice.http_method).toBe("POST");
      expect(slice.route_uri).toBe("/api/fiber-orders");
      expect(slice.controller_class).toBe("FiberOrderHandler");
      expect(slice.action_name).toBe("CreateOrder");

      const chain = JSON.parse(slice.execution_chain_json);
      expect(chain.some((c: any) => c.stage === "ingress" && c.symbol === "POST /api/fiber-orders")).toBe(true);
      expect(chain.some((c: any) => c.stage === "validation" && c.symbol === "CreateFiberOrderRequest")).toBe(true);
      expect(chain.some((c: any) => c.stage === "controller" && c.symbol === "FiberOrderHandler::CreateOrder")).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("resolves physical service, repository, and entity files across Clean Architecture layers (L5)", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = createTempDir("go-clean-arch-l5");
      fs.writeFileSync(path.join(tempDir, "go.mod"), "module shop\n\ngo 1.22\nrequire github.com/gin-gonic/gin v1.9.1\n");

      // 1. Entity: internal/domain/order.go
      const domainDir = path.join(tempDir, "internal", "domain");
      fs.mkdirSync(domainDir, { recursive: true });
      fs.writeFileSync(
        path.join(domainDir, "order.go"),
        `
package domain

type Order struct {
    ID    int64
    Total float64
}
        `.trim()
      );

      // 2. Repository: internal/repository/order_repo.go
      const repoDir = path.join(tempDir, "internal", "repository");
      fs.mkdirSync(repoDir, { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, "order_repo.go"),
        `
package repository

import "shop/internal/domain"

type OrderRepository struct {}

func (r *OrderRepository) Save(order *domain.Order) error {
    return nil
}
        `.trim()
      );

      // 3. Service: internal/service/order_service.go
      const serviceDir = path.join(tempDir, "internal", "service");
      fs.mkdirSync(serviceDir, { recursive: true });
      fs.writeFileSync(
        path.join(serviceDir, "order_service.go"),
        `
package service

import (
    "shop/internal/domain"
    "shop/internal/repository"
)

type OrderService struct {
    repo *repository.OrderRepository
}

func (s *OrderService) ProcessOrder(order *domain.Order) error {
    return s.repo.Save(order)
}
        `.trim()
      );

      // 4. Handler: internal/handler/order_handler.go
      const handlerDir = path.join(tempDir, "internal", "handler");
      fs.mkdirSync(handlerDir, { recursive: true });
      fs.writeFileSync(
        path.join(handlerDir, "order_handler.go"),
        `
package handler

import (
    "github.com/gin-gonic/gin"
    "shop/internal/service"
)

type OrderHandler struct {
    orderService *service.OrderService
}

type CreateOrderRequest struct {
    Total float64 \`json:"total"\`
}

func (h *OrderHandler) Create(c *gin.Context) {
    var req CreateOrderRequest
    if err := c.ShouldBindJSON(&req); err != nil {
        return
    }
    h.orderService.ProcessOrder(nil)
}

func SetupRoutes(r *gin.Engine, h *OrderHandler) {
    r.POST("/orders", h.Create)
}
        `.trim()
      );
    });

    afterAll(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("resolves physical service, repository, and entity files across Clean Architecture layers (L5)", () => {
      const slices = extractor.extractSlices(tempDir);
      expect(slices).toHaveLength(1);

      const slice = slices[0];
      expect(slice.http_method).toBe("POST");
      expect(slice.route_uri).toBe("/orders");
      expect(slice.controller_class).toBe("OrderHandler");

      const chain = JSON.parse(slice.execution_chain_json);

      // L4: Service linked to internal/service/order_service.go
      const svcNode = chain.find((c: any) => c.stage === "service");
      expect(svcNode).toBeDefined();
      expect(svcNode?.symbol).toContain("ProcessOrder");
      expect(svcNode?.file).toBe("internal/service/order_service.go");

      // L5: Repository linked to internal/repository/order_repo.go
      const repoNode = chain.find((c: any) => c.stage === "repository");
      expect(repoNode).toBeDefined();
      expect(repoNode?.symbol).toContain("Save");
      expect(repoNode?.file).toBe("internal/repository/order_repo.go");

      // L5: Entity linked to internal/domain/order.go
      const entNode = chain.find((c: any) => c.stage === "entity");
      expect(entNode).toBeDefined();
      expect(entNode?.symbol).toBe("Order");
      expect(entNode?.file).toBe("internal/domain/order.go");
    });
  });
});
