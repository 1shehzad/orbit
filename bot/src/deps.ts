import type { TicketDefinition } from "./analyzer.js";

/**
 * Topologically sort tickets by their dependencies.
 * Returns an ordered list of ticket batches — tickets in the same batch
 * are independent and can theoretically run in parallel.
 *
 * Example:
 *   T1 (no deps), T2 depends on T1, T3 depends on T1, T4 depends on T2+T3
 *   Returns: [[T1], [T2, T3], [T4]]
 */
export function buildExecutionOrder(tickets: TicketDefinition[]): TicketDefinition[][] {
  if (tickets.length === 0) return [];
  if (tickets.length === 1) return [tickets];

  const byKey = new Map<string, TicketDefinition>();
  for (const t of tickets) {
    byKey.set(t.key, t);
  }

  // Compute in-degree for each ticket
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // key -> keys that depend on it

  for (const t of tickets) {
    inDegree.set(t.key, 0);
    dependents.set(t.key, []);
  }

  for (const t of tickets) {
    for (const dep of t.dependsOn) {
      if (byKey.has(dep)) {
        inDegree.set(t.key, (inDegree.get(t.key) || 0) + 1);
        dependents.get(dep)!.push(t.key);
      }
      // If dep doesn't exist in our tickets, ignore it (already done or external)
    }
  }

  // Kahn's algorithm — batch by levels
  const batches: TicketDefinition[][] = [];
  const remaining = new Set(tickets.map((t) => t.key));

  while (remaining.size > 0) {
    // Find all tickets with no unresolved dependencies
    const ready: string[] = [];
    for (const key of remaining) {
      if ((inDegree.get(key) || 0) === 0) {
        ready.push(key);
      }
    }

    if (ready.length === 0) {
      // Circular dependency detected — just add remaining in original order
      const leftover = tickets.filter((t) => remaining.has(t.key));
      batches.push(leftover);
      break;
    }

    // This batch can run in parallel
    const batch = ready.map((k) => byKey.get(k)!);
    batches.push(batch);

    // Remove from remaining and update in-degrees
    for (const key of ready) {
      remaining.delete(key);
      for (const dep of dependents.get(key) || []) {
        inDegree.set(dep, (inDegree.get(dep) || 0) - 1);
      }
    }
  }

  return batches;
}

/**
 * Flatten batches into a sequential processing order.
 * Within each batch, tickets are ordered by priority (lower = more urgent).
 */
export function flattenToQueue(batches: TicketDefinition[][]): TicketDefinition[] {
  const queue: TicketDefinition[] = [];
  for (const batch of batches) {
    // Sort within batch by priority (1 = urgent first)
    const sorted = [...batch].sort((a, b) => a.priority - b.priority);
    queue.push(...sorted);
  }
  return queue;
}

/**
 * Format the execution plan for display.
 */
export function formatExecutionPlan(batches: TicketDefinition[][]): string {
  if (batches.length === 0) return "No tickets to process.";

  const lines: string[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    if (batches.length === 1 && batch.length === 1) {
      lines.push(`*${batch[0].key}.* ${batch[0].title}`);
      continue;
    }

    const parallel = batch.length > 1 ? " _(parallel)_" : "";
    lines.push(`*Stage ${i + 1}*${parallel}`);
    for (const t of batch) {
      const deps = t.dependsOn.length > 0 ? ` → after ${t.dependsOn.join(", ")}` : "";
      lines.push(`  ${t.key}. ${t.title}${deps}`);
    }
  }

  return lines.join("\n");
}
