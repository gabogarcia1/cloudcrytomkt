/**
 * Order store — the idempotency ledger for paid order LINES.
 *
 * Local default: a JSON file (`ORDERS_DB_PATH`, default `.data/orders.json`
 * under app/agent) written atomically (temp file + rename). This is enough
 * for `bag dev`. A deployed AgentCore microVM has an EPHEMERAL disk and may
 * run several instances, so before production swap this module for a
 * durable store with conditional writes (e.g. DynamoDB `PutItem` with
 * `attribute_not_exists(orderId)`), keeping the same interface.
 */

import type { Term } from "../catalog.js";
import { dataPath, readJson, writeJson } from "./fileDb.js";
import type { ProvisionResult } from "./types.js";

export type OrderState =
  | "paid" // funded / debited, provisioning not started
  | "provisioning" // adapter call in flight (or crashed mid-call)
  | "provisioned" // resource exists, on-chain submit pending
  | "delivered" // receipt submitted on-chain (or credit order completed)
  | "failed" // last provisioning attempt failed (see `error`)
  | "rolled_back" // undone because another line of the same order failed
  | "stopped"; // metered resource stopped (credits exhausted)

export interface OrderRecord {
  orderId: string;
  /** Purchase group (`<chainId>-<jobId>` or `cr-<nonce>`); absent on v1 records. */
  groupId?: string;
  lineIndex?: number;
  jobId: number | null;
  chainId: number;
  buyer: string;
  itemId: string;
  region: string;
  term?: Term;
  qty?: number;
  payment?: "chain" | "credits";
  paymentToken: string;
  budgetAtomic: string;
  state: OrderState;
  attempts: number;
  result?: ProvisionResult;
  provisionedAt?: string;
  meteredHoursBilled?: number;
  error?: string;
  retryable?: boolean;
  submitTx?: string;
  deliverableUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

const path = () => dataPath("ORDERS_DB_PATH", "orders.json");
const readAll = () => readJson<Record<string, OrderRecord>>(path(), {});

/** Group id of a record (v1 records predate `groupId`). */
export function groupOf(r: OrderRecord): string {
  return r.groupId ?? r.orderId.split("#")[0]!;
}

export function getOrder(orderId: string): OrderRecord | null {
  return readAll()[orderId] ?? null;
}

export function listOrders(filter: { buyer?: string; groupId?: string } = {}): OrderRecord[] {
  const buyer = filter.buyer?.toLowerCase();
  return Object.values(readAll())
    .filter((o) => buyer === undefined || o.buyer.toLowerCase() === buyer)
    .filter((o) => filter.groupId === undefined || groupOf(o) === filter.groupId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.lineIndex ?? 0) - (b.lineIndex ?? 0));
}

/** Insert-if-absent; returns the stored record (existing one wins). */
export function ensureOrder(
  base: Omit<OrderRecord, "state" | "attempts" | "createdAt" | "updatedAt">,
): OrderRecord {
  const all = readAll();
  const existing = all[base.orderId];
  if (existing !== undefined) return existing;
  const now = new Date().toISOString();
  const rec: OrderRecord = { ...base, state: "paid", attempts: 0, createdAt: now, updatedAt: now };
  all[base.orderId] = rec;
  writeJson(path(), all);
  return rec;
}

export function updateOrder(
  orderId: string,
  patch: Partial<Omit<OrderRecord, "orderId" | "createdAt">>,
): OrderRecord {
  const all = readAll();
  const rec = all[orderId];
  if (rec === undefined) throw new Error(`order ${orderId} not found`);
  const next = { ...rec, ...patch, updatedAt: new Date().toISOString() };
  all[orderId] = next;
  writeJson(path(), all);
  return next;
}
