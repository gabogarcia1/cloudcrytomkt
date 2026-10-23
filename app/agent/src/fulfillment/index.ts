/**
 * `provision(order)` — the single fulfillment entrypoint (one order LINE).
 *
 * Idempotency (a paid line NEVER provisions twice):
 *   1. In-process lock per order id — concurrent A2A notify, sweep and MCP
 *      notify for the same job share ONE provisioning promise.
 *   2. Persistent ledger (store.ts) — once a result is recorded, every later
 *      call returns the stored result instead of calling the cloud again
 *      (e.g. a retry after the on-chain submit failed).
 *   3. Cloud-side idempotency — adapters derive names / client tokens from
 *      `order.idempotencyKey`, so a crash between "cloud created it" and
 *      "ledger recorded it" converges on the same resource on retry.
 */

import type { ProviderId } from "../catalog.js";
import { awsProvisioner } from "./aws.js";
import { azureProvisioner } from "./azure.js";
import { huaweiProvisioner } from "./huawei.js";
import { servicesProvisioner } from "./services.js";
import { ensureOrder, getOrder, updateOrder } from "./store.js";
import {
  type CloudProvisioner,
  type Order,
  ProvisionError,
  type ProvisionResult,
} from "./types.js";

export * from "./types.js";
export {
  getOrder,
  groupOf,
  listOrders,
  updateOrder,
  type OrderRecord,
  type OrderState,
} from "./store.js";

const ADAPTERS: Record<ProviderId, CloudProvisioner> = {
  aws: awsProvisioner,
  azure: azureProvisioner,
  huawei: huaweiProvisioner,
  ccm: servicesProvisioner,
};

const inflight = new Map<string, Promise<ProvisionOutcome>>();

export interface ProvisionOutcome {
  result: ProvisionResult;
  /** true when the stored result was returned without calling the cloud. */
  reused: boolean;
}

export function provision(order: Order): Promise<ProvisionOutcome> {
  const running = inflight.get(order.orderId);
  if (running !== undefined) return running;
  const p = doProvision(order).finally(() => inflight.delete(order.orderId));
  inflight.set(order.orderId, p);
  return p;
}

async function doProvision(order: Order): Promise<ProvisionOutcome> {
  const rec = ensureOrder({
    orderId: order.orderId,
    groupId: order.groupId,
    lineIndex: order.lineIndex,
    jobId: order.jobId,
    chainId: order.chainId,
    buyer: order.buyer,
    itemId: order.item.id,
    region: order.region,
    term: order.term,
    qty: order.qty,
    payment: order.payment,
    paymentToken: order.paymentToken,
    budgetAtomic: order.budgetAtomic,
  });
  if (rec.result !== undefined && rec.state !== "rolled_back") {
    return { result: rec.result, reused: true };
  }
  if (rec.state === "rolled_back") {
    throw new ProvisionError(`line ${order.orderId} was rolled back`, false);
  }

  updateOrder(order.orderId, {
    state: "provisioning",
    attempts: rec.attempts + 1,
    error: undefined,
    retryable: undefined,
  });
  try {
    const result = await ADAPTERS[order.item.provider].provision(order);
    updateOrder(order.orderId, { state: "provisioned", result, provisionedAt: new Date().toISOString() });
    return { result, reused: false };
  } catch (e) {
    const retryable = e instanceof ProvisionError ? e.retryable : true;
    updateOrder(order.orderId, {
      state: "failed",
      error: e instanceof Error ? e.message : String(e),
      retryable,
    });
    throw e;
  }
}

/** Undo a provisioned line (rollback / metered stop). Idempotent. */
export async function deprovision(order: Order, finalState: "rolled_back" | "stopped", reason: string): Promise<void> {
  const rec = getOrder(order.orderId);
  if (rec === null || rec.state === "rolled_back" || rec.state === "stopped") return;
  if (rec.result !== undefined) {
    await ADAPTERS[order.item.provider].deprovision(order, rec.result);
  }
  updateOrder(order.orderId, { state: finalState, error: reason });
}
