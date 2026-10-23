/**
 * Buyer-side ERC-8183 purchase, signed by the CUSTOMER's wallet (the web never
 * sees a private key):
 *
 *   1. createJobWithToken(provider, router, expiredAt, description, router, token)
 *   2. router.registerJob(jobId, policy)
 *   3. setBudget(jobId, amount)
 *   4. token.approve(commerce, amount)          (only if allowance is short)
 *   5. fund(jobId, amount)                      → escrow, job FUNDED
 *   6. A2A notify_funded(jobId)                 → agent verifies + provisions
 *
 * The amount, token and description come verbatim from the agent's signed
 * quote; the agent re-verifies its own signature against the funded job.
 */
import type { Config } from "wagmi";
import { readContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { type Abi, type Address, type Hash, decodeEventLog } from "viem";
import type { ItemQuote } from "./agent";
import { CHAIN, SUBMIT_WINDOW_SECONDS } from "./config";
import { type LocalOrder, saveLocalOrder } from "./localOrders";

export type StepId = "create" | "register" | "budget" | "approve" | "fund";

export const STEP_LABELS: Record<StepId, string> = {
  create: "Crear el pedido (job) on-chain",
  register: "Registrar la política de evaluación",
  budget: "Fijar el presupuesto",
  approve: "Autorizar el token",
  fund: "Depositar el pago en escrow",
};

type StepCb = (step: StepId, state: "wallet" | "mining" | "done" | "skipped", hash?: Hash) => void;

async function send(
  config: Config,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  step: StepId,
  onStep: StepCb,
): Promise<{ hash: Hash; logs: readonly { data: Hash; topics: readonly Hash[] }[] }> {
  onStep(step, "wallet");
  const hash = await writeContract(config, { address, abi, functionName, args } as Parameters<typeof writeContract>[1]);
  onStep(step, "mining", hash);
  const receipt = await waitForTransactionReceipt(config, { hash, chainId: CHAIN.chainId });
  if (receipt.status !== "success") throw new Error(`${STEP_LABELS[step]}: transacción revertida (${hash})`);
  onStep(step, "done", hash);
  return { hash, logs: receipt.logs as unknown as { data: Hash; topics: readonly Hash[] }[] };
}

function jobIdFromLogs(logs: readonly { data: Hash; topics: readonly Hash[] }[]): bigint {
  for (const log of logs) {
    try {
      const ev = decodeEventLog({ abi: CHAIN.commerce.abi, data: log.data, topics: log.topics as [Hash, ...Hash[]] });
      if (ev.eventName === "JobCreated") return (ev.args as unknown as { jobId: bigint }).jobId;
    } catch {
      // not a Commerce event
    }
  }
  throw new Error("JobCreated event not found in receipt");
}

export async function tokenBalance(config: Config, token: Address, owner: Address): Promise<bigint> {
  return (await readContract(config, {
    address: token,
    abi: CHAIN.erc20Abi,
    functionName: "balanceOf",
    args: [owner],
    chainId: CHAIN.chainId,
  })) as bigint;
}

export async function purchase(
  config: Config,
  buyer: Address,
  quote: ItemQuote,
  onStep: StepCb,
): Promise<{ jobId: bigint; order: LocalOrder }> {
  if (quote.chain_id !== CHAIN.chainId) throw new Error("la cotización es de otra red");
  if (quote.commerce.toLowerCase() !== CHAIN.commerce.address.toLowerCase()) {
    throw new Error("la cotización apunta a otro contrato Commerce");
  }
  const amount = BigInt(quote.amount_atomic);
  const token = quote.asset.address;
  const expiredAt = BigInt(Math.floor(Date.now() / 1000) + SUBMIT_WINDOW_SECONDS + CHAIN.disputeWindowSeconds + 300);

  // 1. create
  const created = await send(
    config, CHAIN.commerce.address, CHAIN.commerce.abi, "createJobWithToken",
    [quote.provider, CHAIN.router.address, expiredAt, quote.job_description, CHAIN.router.address, token],
    "create", onStep,
  );
  const jobId = jobIdFromLogs(created.logs);
  const order: LocalOrder = {
    jobId: jobId.toString(),
    payment: "chain",
    summary: orderSummary(quote),
    buyer,
    itemId: quote.item_id,
    region: quote.region,
    symbol: quote.asset.symbol,
    decimals: quote.asset.decimals,
    token,
    amountAtomic: quote.amount_atomic,
    priceUsd: quote.price_usd,
    quoteExpiresAt: quote.quote_expires_at,
    txs: { create: created.hash },
    createdAt: new Date().toISOString(),
  };
  saveLocalOrder(order);

  // 2. register policy on the router
  order.txs.register = (await send(config, CHAIN.router.address, CHAIN.router.abi, "registerJob", [jobId, CHAIN.policy.address], "register", onStep)).hash;
  saveLocalOrder(order);

  // 3. budget
  order.txs.budget = (await send(config, CHAIN.commerce.address, CHAIN.commerce.abi, "setBudget", [jobId, amount, "0x"], "budget", onStep)).hash;
  saveLocalOrder(order);

  // 4. approve exactly the amount (only if needed)
  const allowance = (await readContract(config, {
    address: token, abi: CHAIN.erc20Abi, functionName: "allowance",
    args: [buyer, CHAIN.commerce.address], chainId: CHAIN.chainId,
  })) as bigint;
  if (allowance < amount) {
    order.txs.approve = (await send(config, token, CHAIN.erc20Abi, "approve", [CHAIN.commerce.address, amount], "approve", onStep)).hash;
    saveLocalOrder(order);
  } else {
    onStep("approve", "skipped");
  }

  // 5. fund (escrow)
  order.txs.fund = (await send(config, CHAIN.commerce.address, CHAIN.commerce.abi, "fund", [jobId, amount, "0x"], "fund", onStep)).hash;
  saveLocalOrder(order);

  return { jobId, order };
}

export function orderSummary(q: { lines?: Array<{ service: string; plan: string }>; bundle?: { name: string } | null }): string {
  const lines = (q.lines ?? []).map((l) => `${l.service} ${l.plan}`).join(" + ");
  return q.bundle ? `Paquete ${q.bundle.name}: ${lines}` : lines;
}

/** After expiry without delivery, the buyer reclaims the escrow. */
export async function claimRefund(config: Config, jobId: bigint): Promise<Hash> {
  const hash = await writeContract(config, {
    address: CHAIN.commerce.address, abi: CHAIN.commerce.abi, functionName: "claimRefund", args: [jobId],
  } as Parameters<typeof writeContract>[1]);
  await waitForTransactionReceipt(config, { hash, chainId: CHAIN.chainId });
  return hash;
}
