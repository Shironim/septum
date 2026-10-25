import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FastApiSemanticExtractor } from "../../src/core/parser/extractors/fastapi-semantic.ts";
import { NestJsSemanticExtractor } from "../../src/core/parser/extractors/nestjs-semantic.ts";
import { DjangoSemanticExtractor } from "../../src/core/parser/extractors/django-semantic.ts";
import { blankCommentsAndStrings, findClosingParenthesis } from "../../src/core/parser/boundary-tracker.ts";

describe("framework language regressions", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "septum-semantic-depth-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("balances nested parameters while ignoring strings and comments and rejects incomplete input", async () => {
    const source = '(call(")"), /* ) */ dto) trailing';
    expect(findClosingParenthesis(blankCommentsAndStrings(source), 0)).toBe(source.indexOf(') trailing'));
    expect(findClosingParenthesis('(call(', 0)).toBe(-1);
    expect(findClosingParenthesis('call()', 0)).toBe(-1);
  });

  it("extracts annotated FastAPI handlers with multiline parameters and nested defaults", async () => {
    writeFileSync(join(root, "api.py"), `@app.post("/orders")
async def create(
    order: OrderCreate,
    user = Depends(get_current_user),
) -> dict[str, str]:
    return order_service.create(order)
`);
    const slices = await new FastApiSemanticExtractor().extractSlices(root);
    expect(slices).toHaveLength(1);
    expect(slices[0].controller_line).toBe(2);
    const chain = JSON.parse(slices[0].execution_chain_json);
    expect(chain.some((s: any) => s.stage === "validation" && s.symbol === "OrderCreate")).toBe(true);
    expect(chain.some((s: any) => s.stage === "guard" && s.symbol === "get_current_user")).toBe(true);
  });

  it("keeps NestJS DTO bindings across nested decorator arguments", async () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/orders.controller.ts"), `@Controller('orders')
export class OrdersController {
  @Post()
  create(
    @Body(new ValidationPipe({ transform: true })) dto: CreateOrderDto,
    @Headers('x-label)') label: string,
  ) { return this.service.create(dto); }
  @Get()
  list() { return []; }
}`);
    const slices = new NestJsSemanticExtractor().extractSlices(root);
    expect(slices).toHaveLength(2);
    const create = slices.find(s => s.action_name === "create")!;
    expect(create.controller_line).toBe(4);
    expect(JSON.parse(create.execution_chain_json).some((s: any) => s.stage === "validation" && s.symbol === "CreateOrderDto")).toBe(true);
  });

  for (const [base, actions] of [
    ["viewsets.ReadOnlyModelViewSet", ["list", "retrieve"]],
    ["viewsets.ViewSet", []],
    ["mixins.ListModelMixin, viewsets.GenericViewSet", ["list"]],
  ] as const) {
    it(`does not invent CRUD actions for ${base}`, async () => {
      writeFileSync(join(root, "views.py"), `class OrderViewSet(${base}):\n    serializer_class = OrderSerializer\n    queryset = Order.objects.all()\n`);
      writeFileSync(join(root, "urls.py"), 'router.register("orders", OrderViewSet, basename="order")');
      const slices = await new DjangoSemanticExtractor().extractSlices(root);
      expect(slices.map(s => s.action_name)).toEqual([...actions]);
      expect(slices.some(s => s.http_method === "POST")).toBe(false);
      for (const slice of slices) {
        expect(JSON.parse(slice.execution_chain_json).find((s: any) => s.stage === "controller").description).toContain("Inherited");
      }
    });
  }
});
