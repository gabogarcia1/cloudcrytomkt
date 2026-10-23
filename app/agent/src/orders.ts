/**
 * Order delivery + read-only order queries, shared by the A2A and MCP faces.
 *
 *   deliverOrder(jobId)      verified FUNDED job → parse lines from the signed
 *                            on-chain task → provision every line (idempotent)
 *                            → receipt → signing.submitResult (fixed code).
 *   credits purchase         buyer-signed message → debit prepaid credits →
 *                            provision lines (no chain tx, no signing by us).
 *   orderStatus / groupStatus / ordersForBuyer   reads, WITHOUT secrets.
 *   orderCredentials(..)     secrets, only for a signature by the buyer.
 *
 * All-or-nothing: if any line of a purchase fails permanently, the lines
 * already provisioned are rolled back (deprovisioned) and nothing is
 * submitted, so the ERC-8183 escrow is refundable via claimRefund (credit
 * orders are re-credited instead).
 *
 * The on-chain deliverable is a RECEIPT: what was provisioned, where, until
 * when, plus a sha256 commitment of the credentials. Credentials never go
 * on-chain or to public storage; the buyer fetches them by proving wallet
 * ownership.
 */

import { createHash, randomUUID } from "node:crypto";
import { get8183Client } from "@bnbagent/studio-runtime/erc8183";
import { verifyMessage } from "viem";
import {
  type OrderLine,
  type ParsedOrder,
  findItem,
  fromMicro,
  orderTask,
  parseOrderTask,
  priceCart,
  toMicro,
} from "./catalog.js";
import { balanceMicro, credit, debit } from "./credits.js";
import {
  type Order,
  type OrderRecord,
  ProvisionError,
  type ProvisionResult,
  deprovision,
  getOrder,
  groupOf,
  listOrders,
  provision,
  updateOrder,
} from "./fulfillment/index.js";
import { getTask } from "./fulfillment/tasks.js";
import { type OrderInput, normalizeOrder, sellerPricing } from "./pricing.js";
import type { SigningApi } from "./sellerCore.js";

const JOB_STATUS = ["OPEN", "FUNDED", "SUBMITTED", "COMPLETED", "REJECTED", "EXPIRED"] as const;
export type UiStatus = "pendiente" | "pagado" | "provisionado" | "fallido";

async function readJob(jobId: number) {
  const client = await get8183Client();
  const id = BigInt(jobId);
  const job = await client.getJob(id);
  let token: string | null = null;
  try {
    token = await client.jobPaymentToken(id);
  } catch {
    token = null;
  }
  return { job, token, chainId: client.network.chainId };
}

// ── building line orders ───────────────────────────────────────────────────

interface GroupInfo {
  groupId: string;
  jobId: number | null;
  chainId: number;
  buyer: string;
  payment: "chain" | "credits";
  paymentToken: string;
  budgetAtomic: string;
}

/** Ids: chain line 0 keeps the v1 id/key (`<chain>-<job>`, `ccm-<chain>-<job>`). */
function lineOrders(g: GroupInfo, lines: OrderLine[]): Order[] {
  return lines.map((l, i) => {
    const item = findItem(l.itemId);
    if (item === null) throw new ProvisionError(`unknown item ${l.itemId}`, false);
    const v1 = g.payment === "chain" && i === 0;
    return {
      orderId: v1 ? g.groupId : `${g.groupId}#${i}`,
      groupId: g.groupId,
      lineIndex: i,
      jobId: g.jobId,
      chainId: g.chainId,
      term: l.term,
      qty: l.qty,
      payment: g.payment,
      buyer: g.buyer,
      item,
      region: l.region,
      paymentToken: g.paymentToken,
      budgetAtomic: g.budgetAtomic,
      idempotencyKey: v1 ? `ccm-${g.groupId}` : `ccm-${g.groupId}-${i}`,
    };
  });
}

/** Rebuild the `Order` of a stored line (meter / rollback). */
export function orderFromRecord(r: OrderRecord): Order | null {
  const item = findItem(r.itemId);
  if (item === null) return null;
  const groupId = groupOf(r);
  const i = r.lineIndex ?? 0;
  const v1 = r.orderId === groupId;
  return {
    orderId: r.orderId, groupId, lineIndex: i, jobId: r.jobId, chainId: r.chainId,
    term: r.term ?? "monthly", qty: r.qty ?? item.contract_months, payment: r.payment ?? "chain",
    buyer: r.buyer, item, region: r.region, paymentToken: r.paymentToken, budgetAtomic: r.budgetAtomic,
    idempotencyKey: v1 ? `ccm-${groupId}` : `ccm-${groupId}-${i}`,
  };
}

type GroupOutcome =
  | { ok: true; results: Array<{ order: Order; result: ProvisionResult; reused: boolean }> }
  | { ok: false; permanent: true; reason: string };

/** Provision every line; on a permanent failure roll back the others. */
async function fulfillGroup(orders: Order[]): Promise<GroupOutcome> {
  const results: Array<{ order: Order; result: ProvisionResult; reused: boolean }> = [];
  for (const order of orders) {
    try {
      const { result, reused } = await provision(order);
      results.push({ order, result, reused });
    } catch (e) {
      if (e instanceof ProvisionError && !e.retryable) {
        const reason = `line ${order.lineIndex} (${order.item.id}) failed: ${e.message}`;
        for (const done of results) {
          await deprovision(done.order, "rolled_back", `rolled back: ${reason}`).catch((err) =>
            console.error(`[orders] rollback of ${done.order.orderId} failed`, err));
        }
        return { ok: false, permanent: true, reason };
      }
      throw e; // transient → retried later with the same idempotency keys
    }
  }
  return { ok: true, results };
}

function credentialsCommitment(credentials: Record<string, string>): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(credentials).sort(([a], [b]) => a.localeCompare(b))),
  );
  return `0x${createHash("sha256").update(canonical).digest("hex")}`;
}

function receipt(group: GroupInfo, parsed: ParsedOrder, results: Array<{ order: Order; result: ProvisionResult }>) {
  return {
    type: "cloudcryptomarket.receipt.v2",
    order: {
      group_id: group.groupId,
      job_id: group.jobId,
      chain_id: group.chainId,
      buyer: group.buyer,
      bundle_id: parsed.bundleId,
    },
    lines: results.map(({ order, result }) => ({
      line: order.lineIndex,
      item_id: order.item.id,
      provider: order.item.provider,
      category: order.item.category,
      service: order.item.service,
      plan: order.item.plan,
      specs: order.item.specs,
      region: order.region,
      term: order.term,
      qty: order.qty,
      resource: {
        resource_id: result.resourceId,
        endpoint: result.endpoint,
        console_url: result.consoleUrl,
        status: result.status,
        expires_at: result.expiresAt,
        details: result.details,
        mock: result.mock,
      },
      credentials_sha256: credentialsCommitment(result.credentials),
    })),
    credentials: { delivery: "off-chain; POST /api/orders/<id>/credentials signed by the buyer wallet" },
    provisioned_at: new Date().toISOString(),
  };
}

export type DeliveryOutcome = Record<string, unknown> & { ok: boolean; skip?: boolean };

/**
 * Deliver one VERIFIED funded job. Callers must run `verifySignedJob` first
 * (the A2A core and the MCP tool both do). Never throws for permanent
 * business failures — it returns `{ ok: false, skip: true }` so the job is
 * not retried and the buyer's refund path applies. Transient failures throw.
 */
export async function deliverOrder(
  jobId: number,
  signing: Pick<SigningApi, "jobSpec" | "submitResult">,
  generator: string,
): Promise<DeliveryOutcome> {
  const spec = await signing.jobSpec(jobId);
  const parsed = spec === null ? null : parseOrderTask(spec.task);
  if (parsed === null) {
    return { ok: false, job_id: jobId, skip: true, reason: "job is not a CloudCryptoMarket order" };
  }
  const { job, token, chainId } = await readJob(jobId);
  const group: GroupInfo = {
    groupId: `${chainId}-${jobId}`,
    jobId,
    chainId,
    buyer: String(job.client ?? ""),
    payment: "chain",
    paymentToken: token ?? "",
    budgetAtomic: job.budget.toString(),
  };
  // Lines must still exist in the catalog (the price itself was verified by
  // verifySignedJob against our own signature).
  for (const l of parsed.lines) {
    if (findItem(l.itemId) === null) {
      return { ok: false, job_id: jobId, skip: true, reason: `unknown item ${l.itemId}` };
    }
  }

  const outcome = await fulfillGroup(lineOrders(group, parsed.lines));
  if (!outcome.ok) {
    // Do NOT submit a fake deliverable: the job stays FUNDED, expires, and
    // the buyer reclaims the escrow with claimRefund (see CLOUDCRYPTOMARKET.md).
    return { ok: false, job_id: jobId, skip: true, reason: `provisioning failed: ${outcome.reason}` };
  }

  const res = await signing.submitResult(jobId, JSON.stringify(receipt(group, parsed, outcome.results), null, 2), {
    job_id: jobId,
    generator,
    kind: "cloudcryptomarket.receipt.v2",
    built_with: "https://github.com/bnb-chain/bnbagent-studio",
  });
  for (const { order } of outcome.results) {
    updateOrder(order.orderId, { state: "delivered", submitTx: res.submitTx, deliverableUrl: res.deliverableUrl });
  }
  return {
    ok: true,
    job_id: jobId,
    tx_hash: res.submitTx,
    deliverable_url: res.deliverableUrl,
    lines: outcome.results.length,
    reused_provisioning: outcome.results.every((r) => r.reused),
  };
}

// ── credit-funded purchases ────────────────────────────────────────────────

interface PendingCreditPurchase {
  nonce: string;
  buyer: string;
  parsed: ParsedOrder;
  totalMicro: bigint;
  hourlyMicro: bigint;
  message: string;
  issuedAt: string;
  expiresAt: number;
}

const pendingCredit = new Map<string, PendingCreditPurchase>();
const CREDIT_QUOTE_TTL_MS = 10 * 60 * 1000;

/** Step 1: price the order and return the exact message the buyer signs. */
export function quoteCreditPurchase(buyer: string, input: OrderInput):
  { ok: true; nonce: string; message: string; total_usd: string; balance_usd: string; issued_at: string } | { ok: false; reason: string } {
  if (!/^0x[0-9a-fA-F]{40}$/.test(buyer)) return { ok: false, reason: "buyer address required" };
  const n = normalizeOrder(input);
  if (!n.ok) return n;
  const pricing = sellerPricing();
  const p = priceCart(n.lines, n.bundleId, pricing.network, { allowMetered: true });
  if (!p.ok) return p;
  if (p.price.lines.some((l) => l.item.category === "credits")) {
    return { ok: false, reason: "credit packs cannot be bought with credits" };
  }
  const totalMicro = toMicro(p.price.total_usd);
  const hourlyMicro = p.price.lines
    .filter((l) => l.term === "metered")
    .reduce((s, l) => s + toMicro(l.item.price_usd_hour!), 0n);
  const nonce = randomUUID();
  const issuedAt = new Date().toISOString();
  const parsed: ParsedOrder = { lines: n.lines, bundleId: n.bundleId };
  const message = [
    "CloudCryptoMarket",
    `Pagar con créditos: ${p.price.total_usd} USD${hourlyMicro > 0n ? " + uso por hora" : ""}`,
    `Pedido: ${orderTask(parsed)}`,
    `nonce: ${nonce}`,
    `issued_at: ${issuedAt}`,
  ].join("\n");
  pendingCredit.set(nonce, {
    nonce, buyer: buyer.toLowerCase(), parsed, totalMicro, hourlyMicro, message, issuedAt,
    expiresAt: Date.now() + CREDIT_QUOTE_TTL_MS,
  });
  return {
    ok: true, nonce, message, total_usd: p.price.total_usd,
    balance_usd: fromMicro(balanceMicro(buyer)), issued_at: issuedAt,
  };
}

/** Step 2: verify the buyer's signature, debit credits, provision. */
export async function executeCreditPurchase(nonce: string, signature: string):
  Promise<{ ok: true; group_id: string } | { ok: false; status: number; error: string }> {
  const q = pendingCredit.get(nonce);
  if (q === undefined || q.expiresAt < Date.now()) {
    pendingCredit.delete(nonce);
    return { ok: false, status: 410, error: "credit quote expired; request a new one" };
  }
  const valid = await verifyMessage({
    address: q.buyer as `0x${string}`,
    message: q.message,
    signature: signature as `0x${string}`,
  }).catch(() => false);
  if (!valid) return { ok: false, status: 403, error: "signature does not match the buyer" };
  pendingCredit.delete(nonce); // single use

  const groupId = `cr-${nonce}`;
  // Metered lines need at least one hour of balance on top of the upfront total.
  if (balanceMicro(q.buyer) < q.totalMicro + q.hourlyMicro) {
    return { ok: false, status: 402, error: "insufficient credits" };
  }
  if (!debit(q.buyer, q.totalMicro, `order ${groupId}`, groupId)) {
    return { ok: false, status: 402, error: "insufficient credits" };
  }
  const { chainId } = sellerPricing();
  const group: GroupInfo = {
    groupId, jobId: null, chainId, buyer: q.buyer, payment: "credits",
    paymentToken: "credits", budgetAtomic: q.totalMicro.toString(),
  };
  void completeCreditGroup(lineOrders(group, q.parsed.lines), q.buyer, q.totalMicro)
    .catch((e) => console.error(`[orders] credit order ${groupId} will be retried by the meter loop`, e));
  return { ok: true, group_id: groupId };
}

async function completeCreditGroup(orders: Order[], buyer: string, totalMicro: bigint): Promise<void> {
  const groupId = orders[0]!.groupId;
  const outcome = await fulfillGroup(orders);
  if (outcome.ok) {
    for (const { order } of outcome.results) updateOrder(order.orderId, { state: "delivered" });
  } else {
    credit(buyer, totalMicro, `refund ${groupId}: ${outcome.reason}`, `refund-${groupId}`);
  }
}

/** Retry credit orders left incomplete by a transient failure (meter loop). */
export async function retryIncompleteCreditOrders(): Promise<void> {
  const groups = new Map<string, OrderRecord[]>();
  for (const r of listOrders()) {
    if (r.payment !== "credits") continue;
    groups.set(groupOf(r), [...(groups.get(groupOf(r)) ?? []), r]);
  }
  for (const recs of groups.values()) {
    const incomplete = recs.some((r) => ["paid", "provisioning", "provisioned"].includes(r.state) || (r.state === "failed" && r.retryable !== false));
    const terminal = recs.some((r) => r.state === "rolled_back" || (r.state === "failed" && r.retryable === false));
    if (!incomplete || terminal) continue;
    const orders = recs.map(orderFromRecord).filter((o): o is Order => o !== null).sort((a, b) => a.lineIndex - b.lineIndex);
    await completeCreditGroup(orders, recs[0]!.buyer, BigInt(recs[0]!.budgetAtomic)).catch(() => undefined);
  }
}

// ── read-only queries ──────────────────────────────────────────────────────

function lineState(r: OrderRecord) {
  const task = r.result?.details?.task_id ? getTask(String(r.result.details.task_id)) : null;
  const { credentials: _secret, ...resource } = r.result ?? ({} as ProvisionResult);
  return {
    order_id: r.orderId,
    line: r.lineIndex ?? 0,
    item_id: r.itemId,
    region: r.region,
    term: r.term ?? "monthly",
    qty: r.qty ?? null,
    state: r.state,
    error: r.error ?? null,
    resource: r.result === undefined ? null : resource,
    task: task === null ? null : { task_id: task.taskId, state: task.state, notes: task.notes, updated_at: task.updatedAt },
    metered_hours_billed: r.meteredHoursBilled ?? null,
  };
}

function aggregate(chain: string | null, lines: OrderRecord[]): UiStatus {
  if (lines.some((l) => l.state === "rolled_back" || (l.state === "failed" && l.retryable === false))) return "fallido";
  if (lines.length > 0 && lines.every((l) => ["provisioned", "delivered", "stopped"].includes(l.state))) return "provisionado";
  if (chain === "SUBMITTED" || chain === "COMPLETED") return "provisionado";
  if (chain === "EXPIRED" || chain === "REJECTED") return "fallido";
  if (chain === "FUNDED" || lines.length > 0) return "pagado";
  return "pendiente";
}

function parseTask(description: string): string {
  try {
    const d = JSON.parse(description) as { task?: unknown };
    return typeof d.task === "string" ? d.task : "";
  } catch {
    return "";
  }
}

/** Public status of an on-chain order (no secrets). */
export async function orderStatus(jobId: number): Promise<Record<string, unknown>> {
  const { job, token, chainId } = await readJob(jobId);
  const chain = JOB_STATUS[Number(job.status)] ?? `UNKNOWN(${job.status})`;
  const groupId = `${chainId}-${jobId}`;
  const recs = listOrders({ groupId }).sort((a, b) => (a.lineIndex ?? 0) - (b.lineIndex ?? 0));
  const parsed = parseOrderTask(parseTask(job.description));
  const first = recs[0];
  return {
    id: String(jobId),
    job_id: jobId,
    chain_id: chainId,
    payment: "chain",
    status: aggregate(chain, recs),
    chain_status: chain,
    buyer: job.client,
    provider: job.provider,
    budget_atomic: job.budget.toString(),
    payment_token: token,
    expired_at: Number(job.expiredAt),
    bundle_id: parsed?.bundleId ?? null,
    item_id: first?.itemId ?? parsed?.lines[0]?.itemId ?? null,
    region: first?.region ?? parsed?.lines[0]?.region ?? null,
    planned_lines: parsed?.lines ?? [],
    lines: recs.map(lineState),
    fulfillment_state: first?.state ?? null,
    error: recs.find((r) => r.error)?.error ?? null,
    submit_tx: first?.submitTx ?? null,
    deliverable_url: first?.deliverableUrl ?? null,
    resource: first ? lineState(first).resource : null,
  };
}

/** Public status of a credit-funded order. */
export function creditOrderStatus(groupId: string): Record<string, unknown> | null {
  const recs = listOrders({ groupId }).sort((a, b) => (a.lineIndex ?? 0) - (b.lineIndex ?? 0));
  if (recs.length === 0) return null;
  return {
    id: groupId,
    group_id: groupId,
    payment: "credits",
    status: aggregate(null, recs),
    buyer: recs[0]!.buyer,
    total_usd: fromMicro(BigInt(recs[0]!.budgetAtomic)),
    lines: recs.map(lineState),
  };
}

/** Orders (grouped) for a buyer from the ledger (no chain reads, no secrets). */
export function ordersForBuyer(buyer: string): Array<Record<string, unknown>> {
  const groups = new Map<string, OrderRecord[]>();
  for (const r of listOrders({ buyer })) {
    const g = groupOf(r);
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  return [...groups.entries()].map(([groupId, recs]) => ({
    id: recs[0]!.payment === "credits" ? groupId : String(recs[0]!.jobId),
    group_id: groupId,
    job_id: recs[0]!.jobId,
    payment: recs[0]!.payment ?? "chain",
    item_id: recs[0]!.itemId,
    lines: recs.length,
    updated_at: recs.map((r) => r.updatedAt).sort().at(-1),
  }));
}

/** Exact message the buyer signs to read credentials (EIP-191 personal_sign). */
export function credentialsMessage(orderRef: string, chainId: number, issuedAt: string): string {
  return [
    "CloudCryptoMarket",
    `Ver credenciales del pedido #${orderRef}`,
    `chain_id: ${chainId}`,
    `issued_at: ${issuedAt}`,
  ].join("\n");
}

const MAX_SIGNATURE_AGE_MS = 10 * 60 * 1000;

/**
 * Return the credentials of every provisioned line if `signature` was made
 * by the order's buyer (job client for chain orders, ledger buyer for credit
 * orders). `orderRef` is a job id (digits) or a credit group id (`cr-…`).
 */
export async function orderCredentials(
  orderRef: string,
  proof: { signature: string; issued_at: string },
): Promise<{ ok: true; lines: Array<{ line: number; item_id: string; credentials: Record<string, string> }>; credentials: Record<string, string> } | { ok: false; status: number; error: string }> {
  const issued = Date.parse(proof.issued_at);
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > MAX_SIGNATURE_AGE_MS) {
    return { ok: false, status: 401, error: "signature expired; sign a fresh message" };
  }
  let buyer: string;
  let groupId: string;
  let chainId: number;
  if (/^\d+$/.test(orderRef)) {
    const r = await readJob(Number(orderRef));
    buyer = String(r.job.client);
    chainId = r.chainId;
    groupId = `${chainId}-${orderRef}`;
  } else {
    groupId = orderRef;
    chainId = sellerPricing().chainId;
    const recs = listOrders({ groupId });
    if (recs.length === 0) return { ok: false, status: 404, error: "order not found" };
    buyer = recs[0]!.buyer;
  }
  const valid = await verifyMessage({
    address: buyer as `0x${string}`,
    message: credentialsMessage(orderRef, chainId, proof.issued_at),
    signature: proof.signature as `0x${string}`,
  }).catch(() => false);
  if (!valid) return { ok: false, status: 403, error: "signature does not match the order's buyer" };
  const recs = listOrders({ groupId }).filter((r) => r.result !== undefined && r.state !== "rolled_back");
  if (recs.length === 0) return { ok: false, status: 404, error: "order not provisioned yet" };
  const lines = recs
    .sort((a, b) => (a.lineIndex ?? 0) - (b.lineIndex ?? 0))
    .map((r) => ({ line: r.lineIndex ?? 0, item_id: r.itemId, credentials: r.result!.credentials }));
  // Flat map kept for v1 clients (single-line orders).
  const flat = Object.assign({}, ...lines.map((l) => (lines.length === 1 ? l.credentials : Object.fromEntries(Object.entries(l.credentials).map(([k, v]) => [`${l.item_id}.${k}`, v])))));
  return { ok: true, lines, credentials: flat };
}

/** Back-compat: credit-only retry hook (status reads trigger nothing else). */
export function _pendingCreditQuotes(): number {
  return pendingCredit.size;
}

export { getOrder };
