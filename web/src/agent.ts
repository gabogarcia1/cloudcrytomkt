/**
 * Client for the CloudCryptoMarket agent.
 *
 *  - negotiate / notify_funded go over A2A JSON-RPC (`message/send` with a
 *    DataPart), exactly like any other buyer agent would.
 *  - read-only data (catalog previews, advisor, order status, credits) and the
 *    wallet-signature-gated credentials / credit purchases use the agent's
 *    small REST API under /api.
 */
import { AGENT_URL } from "./config";

async function a2a(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${AGENT_URL}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/send",
      params: {
        message: {
          kind: "message",
          role: "user",
          messageId: crypto.randomUUID(),
          parts: [{ kind: "data", data }],
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`agent HTTP ${res.status}`);
  const body = (await res.json()) as {
    result?: { parts?: Array<{ kind: string; data?: Record<string, unknown> }> };
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message ?? "agent error");
  const part = body.result?.parts?.find((p) => p.kind === "data");
  if (!part?.data) throw new Error("agent returned no data");
  return part.data;
}

export interface QuoteAsset {
  assetId: string;
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}

export interface QuoteLine {
  itemId: string;
  region: string;
  term: string;
  qty: number;
  list_usd: string;
  annual_discount_usd: string;
  service: string;
  plan: string;
  provider: string;
  category: string;
}

export interface ItemQuote {
  item_id: string;
  region: string;
  lines: QuoteLine[];
  bundle: { id: string; name: string; discount_pct: string; discount_usd: string } | null;
  subtotal_usd: string;
  list_total_usd: string;
  price_scale: string;
  price_usd: string;
  asset: QuoteAsset;
  amount_atomic: string;
  provider: `0x${string}`;
  chain_id: number;
  commerce: `0x${string}`;
  router: `0x${string}`;
  policy: `0x${string}`;
  job_description: string;
  quote_expires_at: number;
  negotiation_hash: string;
}

/** Signed, binding quote for an order payload (item | lines | bundle). */
export async function negotiate(order: Record<string, unknown>, asset: string): Promise<ItemQuote> {
  const env = await a2a({ skill: "negotiate", ...order, asset });
  const response = (env.response ?? {}) as Record<string, unknown>;
  if (response.accepted !== true || env.ccm === undefined) {
    throw new Error(String(response.reason ?? env.error ?? "quote rejected"));
  }
  const ccm = env.ccm as Omit<ItemQuote, "quote_expires_at" | "negotiation_hash">;
  return {
    ...ccm,
    quote_expires_at: Number(response.quote_expires_at ?? env.quote_expires_at ?? 0),
    negotiation_hash: String(env.negotiation_hash ?? ""),
  };
}

export async function notifyFunded(jobId: bigint): Promise<Record<string, unknown>> {
  return a2a({ skill: "notify_funded", job_id: jobId.toString() });
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${AGENT_URL}${path}`, init);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export interface QuotePreview {
  lines: QuoteLine[];
  bundle: ItemQuote["bundle"];
  subtotal_usd: string;
  list_total_usd: string;
  price_scale: string;
  total_usd: string;
  monthly_list_usd: string;
  amounts: Array<QuoteAsset & { amount_atomic: string }>;
}

/** Unsigned preview with the exact same engine as the signed quote. */
export const previewQuote = (order: Record<string, unknown>) => getJson<QuotePreview>("/api/quote", post(order));

export type UiStatus = "pendiente" | "pagado" | "provisionado" | "fallido";

export interface OrderLineStatus {
  order_id: string;
  line: number;
  item_id: string;
  region: string;
  term: string;
  qty: number | null;
  state: string;
  error: string | null;
  resource: {
    resourceId: string;
    endpoint: string;
    consoleUrl: string | null;
    region: string;
    expiresAt: string;
    details: Record<string, unknown>;
    mock: boolean;
  } | null;
  task: { task_id: string; state: string; notes: string[]; updated_at: string } | null;
  metered_hours_billed: number | null;
}

export interface OrderStatus {
  id: string;
  payment: "chain" | "credits";
  job_id?: number;
  status: UiStatus;
  chain_status?: string;
  buyer: string;
  budget_atomic?: string;
  payment_token?: string | null;
  expired_at?: number;
  bundle_id?: string | null;
  total_usd?: string;
  planned_lines?: Array<{ itemId: string; region: string; term: string; qty: number }>;
  lines: OrderLineStatus[];
  error: string | null;
  submit_tx?: string | null;
  deliverable_url?: string | null;
}

export const orderStatus = (ref: number | bigint | string) => getJson<OrderStatus>(`/api/orders/${ref}`);

export const buyerOrders = (buyer: string) =>
  getJson<{ orders: Array<{ id: string; payment: string; item_id: string }> }>(`/api/orders?buyer=${buyer}`);

export const credentialsMessage = (ref: string) =>
  getJson<{ message: string; issued_at: string }>(`/api/orders/${ref}/credentials-message`);

export const fetchCredentials = (ref: string, signature: string, issuedAt: string) =>
  getJson<{ lines: Array<{ line: number; item_id: string; credentials: Record<string, string> }> }>(
    `/api/orders/${ref}/credentials`,
    post({ signature, issued_at: issuedAt }),
  );

export const agentConfig = () =>
  getJson<{ provider: string; chain_id: number; network: string; assets: QuoteAsset[] }>("/api/config");

// ── advisor ────────────────────────────────────────────────────────────────

export interface AdvisorOption {
  provider: "aws" | "azure" | "huawei";
  provider_name: string;
  lines: Array<{ item_id: string; category: string; service: string; plan: string; region: string; term: string; qty: number; list_usd_month: string; need: string; meets: boolean }>;
  monthly_list_usd: string;
  total_usd: string;
  unmet: string[];
  cart: Array<{ item_id: string; region: string; term: "monthly"; qty: number }>;
}

export interface Recommendation {
  requirements: Record<string, unknown>;
  extraction?: string;
  options: AdvisorOption[];
  comparison?: Array<Record<string, string>>;
  recommended: "aws" | "azure" | "huawei" | null;
  savings_usd_month?: string;
  reasoning: string;
  reasoning_source?: "llm" | "rules";
}

export const recommend = (description: string, explain: boolean) =>
  getJson<Recommendation>("/api/recommend", post({ description, explain }));

// ── credits ────────────────────────────────────────────────────────────────

export const creditsBalance = (buyer: string) =>
  getJson<{ balance_usd: string; entries: Array<{ ts: string; amount_usd: string; reason: string }> }>(`/api/credits/${buyer}`);

export const creditsQuote = (buyer: string, order: Record<string, unknown>) =>
  getJson<{ nonce: string; message: string; total_usd: string; balance_usd: string }>("/api/credits/quote", post({ buyer, ...order }));

export const creditsPurchase = (nonce: string, signature: string) =>
  getJson<{ group_id: string }>("/api/credits/purchase", post({ nonce, signature }));
