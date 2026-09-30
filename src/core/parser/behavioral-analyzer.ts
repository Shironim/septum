export interface MethodBehavioralSummary {
  guards: string[];
  hasTransaction: boolean;
  emittedEvents: string[];
  dispatchedJobs: string[];
  mutations: string[];
}

export class BehavioralAnalyzer {
  /**
   * Analyzes the body of a method or function to extract semantic side-effects,
   * authorization guards, database transactions, emitted events, and background job dispatches.
   */
  public static analyzeMethod(code: string): MethodBehavioralSummary {
    const guards = new Set<string>();
    let hasTransaction = false;
    const emittedEvents = new Set<string>();
    const dispatchedJobs = new Set<string>();
    const mutations = new Set<string>();

    const lines = code.split("\n");

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//") || line.startsWith("#")) continue;

      // 1. Transaction Boundaries
      if (
        line.includes("DB::transaction") ||
        line.includes("DB::beginTransaction") ||
        line.includes("this.db.transaction") ||
        line.includes(".transaction(")
      ) {
        hasTransaction = true;
      }

      // 2. Authorization Guards
      // Laravel: $this->authorize('update', $order); or Gate::authorize(...)
      const authMatch = line.match(/(?:\$this->authorize|Gate::authorize)\s*\(\s*['"]([^'"]+)['"]/);
      if (authMatch) {
        guards.add(authMatch[1]);
      }
      // Laravel: abort_if(!..., 403, '...');
      if (line.includes("abort_if(") || line.includes("abort_unless(")) {
        guards.add("abort_guard");
      }
      // TS / NestJS: @UseGuards(AuthGuard, RolesGuard)
      const guardDecoratorMatch = line.match(/@UseGuards\s*\(([^)]+)\)/);
      if (guardDecoratorMatch) {
        const guardNames = guardDecoratorMatch[1].split(",").map((g) => g.trim());
        for (const g of guardNames) guards.add(g);
      }

      // 3. Emitted Events
      // Laravel: event(new OrderPlaced($order));
      const eventNewMatch = line.match(/event\s*\(\s*new\s+([A-Za-z0-9_]+)/);
      if (eventNewMatch) {
        emittedEvents.add(eventNewMatch[1]);
      }
      // Laravel: Event::dispatch(new OrderPlaced($order)); or Event::dispatch('name');
      const eventDispatchMatch = line.match(/Event::dispatch\s*\(\s*(?:new\s+)?([A-Za-z0-9_]+)/);
      if (eventDispatchMatch) {
        emittedEvents.add(eventDispatchMatch[1]);
      }
      // Laravel: broadcast(new OrderUpdated($order));
      const broadcastMatch = line.match(/broadcast\s*\(\s*new\s+([A-Za-z0-9_]+)/);
      if (broadcastMatch) {
        emittedEvents.add(broadcastMatch[1]);
      }
      // EventEmitter: this.eventEmitter.emit('order.created', ...)
      const nodeEmitMatch = line.match(/(?:eventEmitter|\$emit)\.emit\s*\(\s*['"]([^'"]+)['"]/);
      if (nodeEmitMatch) {
        emittedEvents.add(nodeEmitMatch[1]);
      }

      // 4. Dispatched Background Jobs
      // Laravel: ProcessPaymentJob::dispatch($order); or ProcessPayment::dispatchSync(...)
      const jobDispatchStaticMatch = line.match(/([A-Z][a-zA-Z0-9_]*(?:Job|Queue|Task|Process)[a-zA-Z0-9_]*)::dispatch/);
      if (jobDispatchStaticMatch) {
        dispatchedJobs.add(jobDispatchStaticMatch[1]);
      }
      // Laravel: dispatch(new ProcessPayment($order));
      const dispatchNewMatch = line.match(/dispatch\s*\(\s*new\s+([A-Za-z0-9_]+)/);
      if (dispatchNewMatch) {
        dispatchedJobs.add(dispatchNewMatch[1]);
      }
      // BullMQ / Queue: queue.add('process-payment', ...)
      const queueAddMatch = line.match(/(?:queue|queueService)\.add\s*\(\s*['"]([^'"]+)['"]/);
      if (queueAddMatch) {
        dispatchedJobs.add(queueAddMatch[1]);
      }

      // 5. Model Mutations
      // Laravel / ORM: $order->update([...]);
      const updateMatch = line.match(/\$([a-zA-Z0-9_]+)->update\s*\(/);
      if (updateMatch) {
        mutations.add(`${updateMatch[1]}.update()`);
      }
      // Laravel / ORM: $order->delete();
      const deleteMatch = line.match(/\$([a-zA-Z0-9_]+)->delete\s*\(/);
      if (deleteMatch) {
        mutations.add(`${deleteMatch[1]}.delete()`);
      }
      // Direct property assignment: $order->status = 'completed';
      const assignMatch = line.match(/\$([a-zA-Z0-9_]+)->([a-zA-Z0-9_]+)\s*=\s*([^;]+);/);
      if (assignMatch && !["this", "request"].includes(assignMatch[1])) {
        mutations.add(`${assignMatch[1]}.${assignMatch[2]}`);
      }
    }

    return {
      guards: Array.from(guards),
      hasTransaction,
      emittedEvents: Array.from(emittedEvents),
      dispatchedJobs: Array.from(dispatchedJobs),
      mutations: Array.from(mutations),
    };
  }
}
