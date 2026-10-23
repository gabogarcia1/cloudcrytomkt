/**
 * Common fulfillment contract shared by every cloud adapter.
 *
 * An adapter provisions ONE paid order inside the OPERATOR's cloud account
 * (credentials come from the operator's environment — never from the buyer)
 * and returns what the buyer needs to use the resource.
 */

import type { CatalogItem, ProviderId, Term } from "../catalog.js";

export interface Order {
  /**
   * Stable id of ONE order line. Chain orders: `<chainId>-<jobId>` for line 0
   * (v1-compatible) and `<chainId>-<jobId>#<i>` for further lines; credit
   * orders: `cr-<nonce>#<i>`.
   */
  orderId: string;
  /** Groups the lines of one purchase: `<chainId>-<jobId>` or `cr-<nonce>`. */
  groupId: string;
  lineIndex: number;
  /** On-chain job id (null for credit-funded orders). */
  jobId: number | null;
  chainId: number;
  term: Term;
  qty: number;
  payment: "chain" | "credits";
  /** The job's on-chain client (the paying wallet). */
  buyer: string;
  item: CatalogItem;
  region: string;
  /** Escrowed ERC-20 token address and atomic budget, as read on-chain. */
  paymentToken: string;
  budgetAtomic: string;
  /**
   * Pass this to every cloud API that supports client tokens / deterministic
   * names (EC2 ClientToken, Azure resource names, Huawei client_token…) so a
   * retried provision after a crash converges on the SAME resource.
   */
  idempotencyKey: string;
}

export interface ProvisionResult {
  resourceId: string;
  endpoint: string;
  consoleUrl: string | null;
  region: string;
  status: "active";
  /** ISO timestamp when the contracted period ends. */
  expiresAt: string;
  /** Secret material for the buyer. Never written on-chain or to public storage. */
  credentials: Record<string, string>;
  /** Non-secret facts (instance type, bucket name, quotas…). */
  details: Record<string, unknown>;
  /** True when produced by a mock adapter (sample values, nothing created). */
  mock: boolean;
}

export interface CloudProvisioner {
  readonly provider: ProviderId;
  provision(order: Order): Promise<ProvisionResult>;
  /**
   * Undo a provisioned line: rollback when another line of the same paid
   * order failed, or stop a metered resource when credits run out.
   */
  deprovision(order: Order, result: ProvisionResult): Promise<void>;
}

/** Thrown when the adapter cannot provision (no quota, bad region, API down…). */
export class ProvisionError extends Error {
  constructor(
    message: string,
    /** false → retrying cannot help (refund path); true → retry later. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProvisionError";
  }
}
