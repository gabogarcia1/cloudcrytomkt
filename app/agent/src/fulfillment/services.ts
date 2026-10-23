/**
 * CloudCryptoMarket's own services (provider "ccm"):
 *   credits     → top up the buyer's prepaid credits ledger.
 *   consulting  → open a task (pendiente) the operator delivers.
 * Fully implemented (no external API): this is real business logic, not a mock.
 */

import { scaleMicro, toMicro } from "../catalog.js";
import { credit, creditsSummary, debit } from "../credits.js";
import { sellerPricing } from "../pricing.js";
import { contractEnd } from "./mock.js";
import { ensureTask, setTaskState } from "./tasks.js";
import {
  type CloudProvisioner,
  type Order,
  ProvisionError,
  type ProvisionResult,
} from "./types.js";

function creditedMicro(order: Order): bigint {
  return scaleMicro(toMicro(order.item.credits_usd ?? "0"), sellerPricing().network);
}

export const servicesProvisioner: CloudProvisioner = {
  provider: "ccm",
  async provision(order): Promise<ProvisionResult> {
    const base = { region: order.region, status: "active" as const, expiresAt: contractEnd(order), mock: false };
    if (order.item.category === "credits") {
      const amount = creditedMicro(order);
      credit(order.buyer, amount, `pack ${order.item.id}`, order.idempotencyKey);
      const summary = creditsSummary(order.buyer);
      return {
        ...base,
        resourceId: `credits:${order.buyer.toLowerCase()}`,
        endpoint: `/api/credits/${order.buyer}`,
        consoleUrl: null,
        credentials: {},
        details: { credited_usd: summary.entries.find((e) => e.ref === order.idempotencyKey)?.amount_usd ?? null, balance_usd: summary.balance_usd },
      };
    }
    if (order.item.category === "consulting") {
      const task = ensureTask({
        taskId: `task-${order.idempotencyKey}`,
        orderId: order.orderId,
        groupId: order.groupId,
        buyer: order.buyer,
        service: order.item.service,
        hours: Number(order.item.specs.hours),
      });
      return {
        ...base,
        resourceId: task.taskId,
        endpoint: "/pedidos",
        consoleUrl: null,
        credentials: {},
        details: { task_id: task.taskId, service: task.service, hours: task.hours },
      };
    }
    throw new ProvisionError(`services adapter cannot fulfil ${order.item.category}`, false);
  },
  async deprovision(order, result) {
    if (order.item.category === "credits") {
      // Roll back the top-up (only what is still unspent).
      debit(order.buyer, creditedMicro(order), `rollback ${order.item.id}`, `rollback-${order.idempotencyKey}`);
    } else if (order.item.category === "consulting") {
      setTaskState(result.resourceId, "cancelada", "order rolled back");
    }
  },
};
