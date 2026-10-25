import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { FastApiSemanticExtractor } from "../../src/core/parser/extractors/fastapi-semantic.ts";
import { DjangoSemanticExtractor } from "../../src/core/parser/extractors/django-semantic.ts";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `septum-test-${prefix}-`));
}

describe("Python Semantic Slice Extractors (FastAPI & Django)", () => {
  describe("FastApiSemanticExtractor", () => {
    it("should detect FastAPI project topology and extract complete vertical slices", async () => {
      const tempDir = createTempDir("fastapi");
      const extractor = new FastApiSemanticExtractor();

      try {
        // Mock requirements.txt
        fs.writeFileSync(path.join(tempDir, "requirements.txt"), "fastapi==0.110.0\nuvicorn\npydantic\n");
        expect(extractor.canHandle(tempDir)).toBe(true);

        // Mock routes file: app/routers/orders.py
        const routersDir = path.join(tempDir, "app", "routers");
        fs.mkdirSync(routersDir, { recursive: true });

        const routerCode = `
from fastapi import APIRouter, Depends, HTTPException, status
from app.schemas.order import CreateOrderSchema, OrderOut
from app.dependencies.auth import get_current_user
from app.services.order_service import OrderService
from app.models.order import Order

router = APIRouter(prefix="/orders", tags=["orders"])

@router.post("/", response_model=OrderOut, status_code=status.HTTP_201_CREATED)
async def create_order(
    payload: CreateOrderSchema,
    current_user: dict = Depends(get_current_user),
):
    """Create a new order."""
    result = OrderService.process_payment(payload)
    return result

@router.get("/{order_id}")
async def get_order_by_id(order_id: str):
    return {"id": order_id}
        `.trim();

        fs.writeFileSync(path.join(routersDir, "orders.py"), routerCode);

        const slices = await extractor.extractSlices(tempDir);
        expect(slices.length).toBe(2);

        // POST /orders
        const postSlice = slices.find((s) => s.http_method === "POST");
        expect(postSlice).toBeDefined();
        expect(postSlice?.route_uri).toBe("/orders/");
        expect(postSlice?.action_name).toBe("create_order");

        const postChain = JSON.parse(postSlice!.execution_chain_json);
        expect(postChain.some((c: any) => c.stage === "ingress" && c.symbol.includes("POST /orders/"))).toBe(true);
        expect(postChain.some((c: any) => c.stage === "guard" && c.symbol === "get_current_user")).toBe(true);
        expect(postChain.some((c: any) => c.stage === "validation" && c.symbol === "CreateOrderSchema")).toBe(true);
        expect(postChain.some((c: any) => c.stage === "controller" && c.symbol.includes("orders::create_order"))).toBe(true);
        expect(postChain.some((c: any) => c.stage === "service" && c.symbol.includes("OrderService::process_payment"))).toBe(true);

        // GET /orders/{order_id}
        const getSlice = slices.find((s) => s.http_method === "GET");
        expect(getSlice).toBeDefined();
        expect(getSlice?.route_uri).toBe("/orders/{order_id}");
        expect(getSlice?.action_name).toBe("get_order_by_id");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    describe("resolves physical service file and connects to SQLAlchemy ORM model (L5)", () => {
      let tempDir: string;
      const extractor = new FastApiSemanticExtractor();

      beforeAll(() => {
        tempDir = createTempDir("fastapi-l5");
        fs.writeFileSync(path.join(tempDir, "requirements.txt"), "fastapi\nsqlalchemy\n");

        const routersDir = path.join(tempDir, "app", "routers");
        const servicesDir = path.join(tempDir, "app", "services");
        const modelsDir = path.join(tempDir, "app", "models");
        fs.mkdirSync(routersDir, { recursive: true });
        fs.mkdirSync(servicesDir, { recursive: true });
        fs.mkdirSync(modelsDir, { recursive: true });

        // 1. Model
        fs.writeFileSync(
          path.join(modelsDir, "order.py"),
          `
class Order:
    __tablename__ = "orders"
          `.trim()
        );

        // 2. Service
        fs.writeFileSync(
          path.join(servicesDir, "order_service.py"),
          `
from app.models.order import Order

class OrderService:
    @staticmethod
    def create_order(db, payload):
        order = Order(total=payload.total)
        db.add(order)
        return order
          `.trim()
        );

        // 3. Router
        fs.writeFileSync(
          path.join(routersDir, "orders.py"),
          `
from fastapi import APIRouter
from app.services.order_service import OrderService

router = APIRouter(prefix="/orders")

@router.post("/")
def place_order(payload: dict):
    return OrderService.create_order(None, payload)
          `.trim()
        );
      });

      afterAll(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
      });

      it("resolves physical service file and connects to SQLAlchemy ORM model (L5)", async () => {
        const slices = await extractor.extractSlices(tempDir);
        expect(slices).toHaveLength(1);

        const chain = JSON.parse(slices[0].execution_chain_json);

        // L4: Physical Service link
        const svcNode = chain.find((c: any) => c.stage === "service");
        expect(svcNode).toBeDefined();
        expect(svcNode?.symbol).toBe("OrderService::create_order");
        expect(svcNode?.file).toBe("app/services/order_service.py");

        // L5: Physical Model persistence link
        const modelNode = chain.find((c: any) => c.stage === "model");
        expect(modelNode).toBeDefined();
        expect(modelNode?.symbol).toBe("Order");
        expect(modelNode?.file).toBe("app/models/order.py");
      });
    });
  });

  describe("DjangoSemanticExtractor", () => {
    it("should detect Django / DRF topology and extract ViewSet and CBV execution slices", async () => {
      const tempDir = createTempDir("django");
      const extractor = new DjangoSemanticExtractor();

      try {
        // Mock manage.py
        fs.writeFileSync(path.join(tempDir, "manage.py"), "#!/usr/bin/env python\n");
        expect(extractor.canHandle(tempDir)).toBe(true);

        // Mock views.py
        const appDir = path.join(tempDir, "orders");
        fs.mkdirSync(appDir, { recursive: true });

        const viewsCode = `
from rest_framework import viewsets
from rest_framework.views import APIView
from rest_framework.response import Response
from .models import Order
from .serializers import OrderSerializer, CheckoutSerializer

class OrderViewSet(viewsets.ModelViewSet):
    queryset = Order.objects.all()
    serializer_class = OrderSerializer

class CheckoutView(APIView):
    def post(self, request):
        serializer = CheckoutSerializer(data=request.data)
        return Response({"status": "ok"})
        `.trim();

        fs.writeFileSync(path.join(appDir, "views.py"), viewsCode);

        // Mock urls.py
        const urlsCode = `
from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import OrderViewSet, CheckoutView

router = DefaultRouter()
router.register(r'orders', OrderViewSet, basename='order')

urlpatterns = [
    path('api/checkout/', CheckoutView.as_view(), name='checkout'),
] + router.urls
        `.trim();

        fs.writeFileSync(path.join(appDir, "urls.py"), urlsCode);

        const slices = await extractor.extractSlices(tempDir);
        expect(slices.length).toBeGreaterThanOrEqual(6);

        // Check DRF ViewSet slices
        const listSlice = slices.find((s) => s.http_method === "GET" && s.action_name === "list");
        expect(listSlice).toBeDefined();
        expect(listSlice?.route_uri).toBe("/orders");

        const createSlice = slices.find((s) => s.http_method === "POST" && s.action_name === "create");
        expect(createSlice).toBeDefined();
        expect(createSlice?.route_uri).toBe("/orders");

        const createChain = JSON.parse(createSlice!.execution_chain_json);
        expect(createChain.some((c: any) => c.stage === "ingress")).toBe(true);
        expect(createChain.some((c: any) => c.stage === "validation" && c.symbol === "OrderSerializer")).toBe(true);
        expect(createChain.some((c: any) => c.stage === "controller" && c.symbol === "OrderViewSet::create")).toBe(true);
        expect(createChain.some((c: any) => c.stage === "model" && c.symbol === "Order")).toBe(true);

        // Check APIView CBV post slice
        const checkoutSlice = slices.find((s) => s.route_name === "checkout");
        expect(checkoutSlice).toBeDefined();
        expect(checkoutSlice?.http_method === "POST").toBe(true);
        expect(checkoutSlice?.route_uri).toBe("/api/checkout");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should resolve multi-file Django URLConf inclusions with path('api/', include('...'))", async () => {
      const tempDir = createTempDir("django-multifile");
      const extractor = new DjangoSemanticExtractor();

      try {
        fs.writeFileSync(path.join(tempDir, "manage.py"), "#!/usr/bin/env python\n");

        // App orders: orders/views.py and orders/urls.py
        const ordersDir = path.join(tempDir, "orders");
        fs.mkdirSync(ordersDir, { recursive: true });

        const viewsCode = `
from rest_framework import viewsets
from rest_framework.views import APIView
from rest_framework.response import Response

class OrderViewSet(viewsets.ReadOnlyModelViewSet):
    pass

class StatusView(APIView):
    def get(self, request):
        return Response({"status": "healthy"})
        `.trim();
        fs.writeFileSync(path.join(ordersDir, "views.py"), viewsCode);

        const ordersUrlsCode = `
from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import OrderViewSet, StatusView

router = DefaultRouter()
router.register(r'orders', OrderViewSet, basename='order')

urlpatterns = [
    path('status/', StatusView.as_view(), name='status'),
] + router.urls
        `.trim();
        fs.writeFileSync(path.join(ordersDir, "urls.py"), ordersUrlsCode);

        // Root urls.py: includes orders.urls under 'api/v1/'
        const rootUrlsCode = `
from django.urls import path, include

urlpatterns = [
    path('api/v1/', include('orders.urls')),
]
        `.trim();
        fs.writeFileSync(path.join(tempDir, "urls.py"), rootUrlsCode);

        const slices = await extractor.extractSlices(tempDir);
        expect(slices.length).toBeGreaterThanOrEqual(3);

        // Verify prefixes composed: /api/v1/orders and /api/v1/status
        const listSlice = slices.find((s) => s.http_method === "GET" && s.action_name === "list");
        expect(listSlice).toBeDefined();
        expect(listSlice?.route_uri).toBe("/api/v1/orders");

        const statusSlice = slices.find((s) => s.route_name === "status");
        expect(statusSlice).toBeDefined();
        expect(statusSlice?.http_method).toBe("GET");
        expect(statusSlice?.route_uri).toBe("/api/v1/status");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("FastAPI Multi-file Router Composition (PY-03)", () => {
    it("should resolve multi-file include_router chains with prefix propagation and schema binding", async () => {
      const tempDir = createTempDir("fastapi-composition");
      const extractor = new FastApiSemanticExtractor();

      try {
        fs.writeFileSync(path.join(tempDir, "requirements.txt"), "fastapi==0.115.0\n");

        // 1. app/routers/orders.py: defines router with sub-routes
        const routersDir = path.join(tempDir, "app", "routers");
        fs.mkdirSync(routersDir, { recursive: true });

        const ordersCode = `
from fastapi import APIRouter, Depends
from app.schemas import OrderCreate, OrderOut

router = APIRouter(prefix="/orders")

def auth_guard():
    return True

def db_session():
    return None

@router.post("/", response_model=OrderOut)
def create_order(
    payload: OrderCreate,
    current_user: dict = Depends(auth_guard),
    db = Depends(db_session),
):
    return {"id": "1"}

@router.get("/{order_id}")
def get_order(order_id: str):
    return {"id": order_id}
        `.trim();
        fs.writeFileSync(path.join(routersDir, "orders.py"), ordersCode);

        // 2. app/api.py: includes orders router with prefix /v1
        const apiCode = `
from fastapi import APIRouter
from app.routers import orders

api_router = APIRouter(prefix="/v1")
api_router.include_router(orders.router)
        `.trim();
        fs.writeFileSync(path.join(tempDir, "app", "api.py"), apiCode);

        // 3. main.py: includes api_router with prefix /api
        const mainCode = `
from fastapi import FastAPI
from app.api import api_router

app = FastAPI()
app.include_router(api_router, prefix="/api")
        `.trim();
        fs.writeFileSync(path.join(tempDir, "main.py"), mainCode);

        const slices = await extractor.extractSlices(tempDir);
        expect(slices.length).toBeGreaterThanOrEqual(2);

        // Verify composed prefix: /api + /v1 + /orders + / = /api/v1/orders/
        const postSlice = slices.find((s) => s.http_method === "POST" && s.action_name === "create_order");
        expect(postSlice).toBeDefined();
        expect(postSlice?.route_uri).toBe("/api/v1/orders/");

        const chain = JSON.parse(postSlice!.execution_chain_json);
        expect(chain.some((c: any) => c.stage === "ingress" && c.symbol === "POST /api/v1/orders/")).toBe(true);
        expect(chain.some((c: any) => c.stage === "guard" && c.symbol === "auth_guard")).toBe(true);
        expect(chain.some((c: any) => c.stage === "validation" && c.symbol === "OrderCreate")).toBe(true);
        expect(chain.some((c: any) => c.stage === "dependency" && c.symbol === "db_session")).toBe(true);
        expect(chain.some((c: any) => c.stage === "response_schema" && c.symbol === "OrderOut")).toBe(true);

        const getSlice = slices.find((s) => s.http_method === "GET" && s.action_name === "get_order");
        expect(getSlice).toBeDefined();
        expect(getSlice?.route_uri).toBe("/api/v1/orders/{order_id}");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should handle aliased submodule imports, router-level guards, decorator dependencies, and union types", async () => {
      const tempDir = createTempDir("fastapi-advanced-edgecases");
      const extractor = new FastApiSemanticExtractor();

      try {
        fs.writeFileSync(path.join(tempDir, "requirements.txt"), "fastapi==0.115.0\n");

        // 1. app/routers/users.py: defines router with router-level dependency and union schema
        const routersDir = path.join(tempDir, "app", "routers");
        fs.mkdirSync(routersDir, { recursive: true });

        const usersCode = `
from fastapi import APIRouter, Depends
from app.schemas import UserCreate

def jwt_auth():
    return True

def rate_limiter():
    return True

router = APIRouter(prefix="/users", dependencies=[Depends(jwt_auth)])

@router.post("/", dependencies=[Depends(rate_limiter)])
def register(payload: UserCreate | None):
    return {"status": "ok"}
        `.trim();
        fs.writeFileSync(path.join(routersDir, "users.py"), usersCode);

        // 2. main.py: imports with alias 'from app.routers.users import router as user_router'
        const mainCode = `
from fastapi import FastAPI
from app.routers.users import router as user_router

app = FastAPI()
app.include_router(user_router, prefix="/api")
        `.trim();
        fs.writeFileSync(path.join(tempDir, "main.py"), mainCode);

        const slices = await extractor.extractSlices(tempDir);
        expect(slices.length).toBe(1);

        const slice = slices[0];
        expect(slice.route_uri).toBe("/api/users/");

        const chain = JSON.parse(slice.execution_chain_json);
        // Router-level dependency 'jwt_auth' must be captured
        expect(chain.some((c: any) => c.stage === "guard" && c.symbol === "jwt_auth")).toBe(true);
        // Decorator-level dependency 'rate_limiter' must be captured
        expect(chain.some((c: any) => c.stage === "dependency" && c.symbol === "rate_limiter")).toBe(true);
        // Python 3.10+ union type 'UserCreate | None' cleanly extracted as 'UserCreate'
        expect(chain.some((c: any) => c.stage === "validation" && c.symbol === "UserCreate")).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should gracefully handle circular include_router graphs and unresolvable targets", async () => {
      const tempDir = createTempDir("fastapi-circular");
      const extractor = new FastApiSemanticExtractor();

      try {
        fs.writeFileSync(path.join(tempDir, "requirements.txt"), "fastapi==0.115.0\n");

        // Circular includes: a.py includes b.py, and b.py includes a.py
        const aCode = `
from fastapi import APIRouter
from b import router as b_router

router = APIRouter(prefix="/a")
router.include_router(b_router, prefix="/sub_b")

@router.get("/hello")
def a_hello():
    return "a"
        `.trim();
        fs.writeFileSync(path.join(tempDir, "a.py"), aCode);

        const bCode = `
from fastapi import APIRouter
from a import router as a_router

router = APIRouter(prefix="/b")
router.include_router(a_router, prefix="/sub_a")

@router.get("/world")
def b_world():
    return "b"
        `.trim();
        fs.writeFileSync(path.join(tempDir, "b.py"), bCode);

        // Extractor must terminate safely without infinite recursion or stack overflow
        const slices = await extractor.extractSlices(tempDir);
        expect(slices.length).toBeGreaterThanOrEqual(2);
        expect(slices.some((s) => s.action_name === "a_hello")).toBe(true);
        expect(slices.some((s) => s.action_name === "b_world")).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("Django / DRF Edge Cases & Unhappy Paths (PY-04)", () => {
    it("should extract DRF ViewSet custom @action endpoints (detail=True and detail=False) and normalize regex patterns", async () => {
      const tempDir = createTempDir("django-custom-actions");
      const extractor = new DjangoSemanticExtractor();

      try {
        fs.writeFileSync(path.join(tempDir, "manage.py"), "#!/usr/bin/env python\n");

        const viewsDir = path.join(tempDir, "shop");
        fs.mkdirSync(viewsDir, { recursive: true });

        const viewsCode = `
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.views import APIView
from rest_framework.response import Response

class ProductViewSet(viewsets.ModelViewSet):
    @action(detail=True, methods=['post'])
    def buy(self, request, pk=None):
        return Response({"status": "bought"})

    @action(detail=False, methods=['get'])
    def popular(self, request):
        return Response([])

class LegacyItemView(APIView):
    def get(self, request, item_id):
        return Response({"id": item_id})
        `.trim();
        fs.writeFileSync(path.join(viewsDir, "views.py"), viewsCode);

        const urlsCode = `
from django.urls import path, re_path
from rest_framework.routers import DefaultRouter
from .views import ProductViewSet, LegacyItemView

router = DefaultRouter()
router.register(r'products', ProductViewSet, basename='product')

urlpatterns = [
    re_path(r'^catalog/(?P<item_id>\\d+)/$', LegacyItemView.as_view(), name='legacy_item'),
    path('shop/<int:product_id>/', LegacyItemView.as_view(), name='modern_item'),
] + router.urls
        `.trim();
        fs.writeFileSync(path.join(viewsDir, "urls.py"), urlsCode);

        const slices = await extractor.extractSlices(tempDir);

        // 1. Verify custom detail=True action: POST /products/{id}/buy
        const buySlice = slices.find((s) => s.action_name === "buy");
        expect(buySlice).toBeDefined();
        expect(buySlice?.http_method).toBe("POST");
        expect(buySlice?.route_uri).toBe("/products/{id}/buy");
        const buyChain = JSON.parse(buySlice!.execution_chain_json);
        expect(buyChain.find((c: any) => c.stage === "controller").description).toBe("DRF ViewSet Custom Action");

        // 2. Verify custom detail=False action: GET /products/popular
        const popSlice = slices.find((s) => s.action_name === "popular");
        expect(popSlice).toBeDefined();
        expect(popSlice?.http_method).toBe("GET");
        expect(popSlice?.route_uri).toBe("/products/popular");

        // 3. Verify regex pattern normalization: ^catalog/(?P<item_id>\d+)/$ -> /catalog/{item_id}
        const legacySlice = slices.find((s) => s.route_name === "legacy_item");
        expect(legacySlice).toBeDefined();
        expect(legacySlice?.route_uri).toBe("/catalog/{item_id}");

        // 4. Verify path converter normalization: shop/<int:product_id>/ -> /shop/{product_id}
        const modernSlice = slices.find((s) => s.route_name === "modern_item");
        expect(modernSlice).toBeDefined();
        expect(modernSlice?.route_uri).toBe("/shop/{product_id}");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should gracefully handle Django urls.py pointing to missing or unresolvable views without throwing", async () => {
      const tempDir = createTempDir("django-unresolved-views");
      const extractor = new DjangoSemanticExtractor();

      try {
        fs.writeFileSync(path.join(tempDir, "manage.py"), "#!/usr/bin/env python\n");

        // urls.py with non-existent or 3rd party views
        const urlsCode = `
from django.urls import path

urlpatterns = [
    path('auth/token/', MissingTokenView.as_view(), name='token'),
    path('external/', external_view, name='external'),
]
        `.trim();
        fs.writeFileSync(path.join(tempDir, "urls.py"), urlsCode);

        // Extractor should not crash, returns 0 slices gracefully
        const slices = await extractor.extractSlices(tempDir);
        expect(Array.isArray(slices)).toBe(true);
        expect(slices.length).toBe(0);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
