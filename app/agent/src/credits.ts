/**
 * Prepaid credits ledger (off-chain, per buyer wallet).
 *
 * Units: micro-USD *on the active network* — i.e. already multiplied by the
 * catalog `price_scale` (testnet credits are as cheap as testnet prices).
 * Every entry carries a unique `ref`; crediting or debiting the same ref twice
 * is a no-op, so retried top-ups / charges never double-count.
 *
 * Top-ups:  ERC-8183 credit packs (fulfillment/services.ts) and x402 micro
 *           payments (dualMain.ts → creditX402Topup).
 * Spending: credit-funded orders (orders.ts) and the hourly usage meter
 *           (meter.ts). Nothing here signs or moves tokens.
 */

import { fromMicro } from "./catalog.js";
import { dataPath, readJson, writeJson } from "./fulfillment/fileDb.js";

export interface CreditEntry {
  ts: string;
  delta_micro: string;
  reason: string;
  ref: string;
}

interface Account {
  balance_micro: string;
  entries: CreditEntry[];
}

type Ledger = Record<string, Account>;

const path = () => dataPath("CREDITS_DB_PATH", "credits.json");
const key = (buyer: string) => buyer.toLowerCase();

function load(): Ledger {
  return readJson<Ledger>(path(), {});
}

export function balanceMicro(buyer: string): bigint {
  return BigInt(load()[key(buyer)]?.balance_micro ?? "0");
}

export function creditsSummary(buyer: string) {
  const acc = load()[key(buyer)];
  return {
    buyer: key(buyer),
    balance_usd: fromMicro(BigInt(acc?.balance_micro ?? "0")),
    entries: (acc?.entries ?? []).slice(-50).reverse().map((e) => ({
      ts: e.ts,
      amount_usd: (e.delta_micro.startsWith("-") ? "-" : "+") + fromMicro(BigInt(e.delta_micro.replace("-", ""))),
      reason: e.reason,
      ref: e.ref,
    })),
  };
}

function apply(buyer: string, delta: bigint, reason: string, ref: string, allowNegative: boolean): boolean {
  const ledger = load();
  const acc: Account = ledger[key(buyer)] ?? { balance_micro: "0", entries: [] };
  if (acc.entries.some((e) => e.ref === ref)) return true; // idempotent replay
  const next = BigInt(acc.balance_micro) + delta;
  if (next < 0n && !allowNegative) return false;
  acc.balance_micro = next.toString();
  acc.entries.push({ ts: new Date().toISOString(), delta_micro: delta.toString(), reason, ref });
  ledger[key(buyer)] = acc;
  writeJson(path(), ledger);
  return true;
}

/** Add credits (idempotent by ref). */
export function credit(buyer: string, micro: bigint, reason: string, ref: string): void {
  if (micro < 0n) throw new Error("credit amount must be >= 0");
  apply(buyer, micro, reason, ref, false);
}

/** Debit credits; false (and no change) if the balance is insufficient. */
export function debit(buyer: string, micro: bigint, reason: string, ref: string): boolean {
  if (micro < 0n) throw new Error("debit amount must be >= 0");
  return apply(buyer, -micro, reason, ref, false);
}

export function hasRef(buyer: string, ref: string): boolean {
  return load()[key(buyer)]?.entries.some((e) => e.ref === ref) ?? false;
}
