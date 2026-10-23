/**
 * Orders this browser started (per wallet). Only public data: job id, item,
 * tx hashes. Never keys, never credentials. The agent + chain stay the source
 * of truth for status; this list just remembers jobs that are still OPEN
 * (the agent only learns about a job once it is funded and notified).
 */
export interface LocalOrder {
  /** On-chain job id, or the credit order id (cr-…) for credit purchases. */
  jobId: string;
  payment?: "chain" | "credits";
  /** Human summary of the lines (e.g. "Amazon EC2 S + Amazon S3 1 TB"). */
  summary?: string;
  buyer: string;
  itemId: string;
  region: string;
  symbol: string;
  decimals: number;
  token: string;
  amountAtomic: string;
  priceUsd: string;
  quoteExpiresAt: number;
  txs: Partial<Record<"create" | "register" | "budget" | "approve" | "fund", string>>;
  createdAt: string;
}

const KEY = "ccm.orders.v1";

function readAll(): LocalOrder[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as LocalOrder[];
  } catch {
    return [];
  }
}

function writeAll(orders: LocalOrder[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(orders));
  } catch {
    // storage unavailable (private mode) — orders still recoverable from the agent
  }
}

export function saveLocalOrder(order: LocalOrder): void {
  const all = readAll().filter((o) => o.jobId !== order.jobId);
  writeAll([order, ...all]);
}

export function localOrdersFor(buyer: string): LocalOrder[] {
  return readAll().filter((o) => o.buyer.toLowerCase() === buyer.toLowerCase());
}
