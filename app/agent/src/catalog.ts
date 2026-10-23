/**
 * CloudCryptoMarket catalog + deterministic pricing engine.
 *
 * `catalog.json` (next to package.json) is the single source of truth for
 * what this seller offers and what it costs; the web storefront imports the
 * same file. Everything here is pure, deterministic code: the quote path
 * prices an order from the catalog — never from the buyer, never from the
 * LLM — and `signing.ts` converts the USD total to the selected token's
 * atomic units before signing.
 *
 * Billing models (per order line):
 *   monthly  price_usd_month × contract_months
 *   annual   price_usd_month × 12 × (1 − annual_prepay_pct)   (prepaid year)
 *   hourly   price_usd_hour × hours                           (prepaid hours)
 *   metered  price_usd_hour per elapsed hour, debited from prepaid credits
 *   once     price_usd                                        (credit packs, consulting)
 * Bundles apply `discount_pct` to the sum of their lines. The network's
 * `price_scale` (testnet) multiplies the final total. All math is integer
 * micro-USD; each discount/scale step rounds DOWN to 1 micro-USD (in the
 * buyer's favour), so every party recomputes the exact same number.
 *
 * The order is encoded in the job's `task_description` (see orderTask). That
 * string is covered by the provider signature and anchored on-chain, so
 * delivery reads back exactly the lines the seller quoted.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

const decimalUsd = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, "must be a decimal USD string (max 6 decimals)");
const pct = z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, "percent 0-99.99");

export const PROVIDERS = ["aws", "azure", "huawei", "ccm"] as const;
export const CATEGORIES = [
  "storage", "compute", "ai-agents", "database", "cdn-dns", "backup",
  "gpu", "kubernetes", "security", "credits", "consulting",
] as const;
export const TERMS = ["monthly", "annual", "hourly", "metered", "once"] as const;

const ItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  provider: z.enum(PROVIDERS),
  category: z.enum(CATEGORIES),
  service: z.string().min(1),
  plan: z.string().min(1),
  specs: z.record(z.union([z.string(), z.number(), z.boolean()])),
  regions: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1),
  price_usd_month: decimalUsd.optional(),
  price_usd_hour: decimalUsd.optional(),
  price_usd: decimalUsd.optional(),
  /** Credit packs: credits granted (USD, before the network price scale). */
  credits_usd: decimalUsd.optional(),
  contract_months: z.number().int().min(1).max(36),
});

const BundleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  profile: z.string(),
  description: z.string(),
  discount_pct: pct,
  components: z.array(z.object({ category: z.enum(CATEGORIES), plan: z.string() })).min(1),
});

const CatalogSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  currency: z.literal("USD"),
  /** Per-network price multiplier (e.g. cheap test purchases on bsc-testnet). */
  price_scale: z.record(decimalUsd).optional(),
  discounts: z.object({ annual_prepay_pct: pct, bundle_pct: pct }).optional(),
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      full_name: z.string(),
      tagline: z.string(),
      regions: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
  categories: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
  bundles: z.array(BundleSchema).optional(),
  items: z.array(ItemSchema),
});

export type CatalogItem = z.infer<typeof ItemSchema>;
export type Bundle = z.infer<typeof BundleSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;
export type ProviderId = CatalogItem["provider"];
export type CloudProviderId = Exclude<ProviderId, "ccm">;
export type Term = (typeof TERMS)[number];

let cached: Catalog | null = null;

/** Load + validate `catalog.json` once (CATALOG_PATH overrides the location). */
export function loadCatalog(): Catalog {
  if (cached !== null) return cached;
  const path = process.env.CATALOG_PATH
    ? process.env.CATALOG_PATH
    : new URL("../catalog.json", import.meta.url);
  const parsed = CatalogSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
  const ids = new Set<string>();
  for (const item of parsed.items) {
    if (ids.has(item.id)) throw new Error(`duplicate catalog item id: ${item.id}`);
    ids.add(item.id);
    if (termsFor(item).length === 0) throw new Error(`item ${item.id} has no price`);
  }
  cached = parsed;
  return parsed;
}

/** Test seam: drop the cached catalog. */
export function _resetCatalog(): void {
  cached = null;
}

export function findItem(itemId: string): CatalogItem | null {
  return loadCatalog().items.find((i) => i.id === itemId) ?? null;
}

export function findBundle(bundleId: string): Bundle | null {
  return loadCatalog().bundles?.find((b) => b.id === bundleId) ?? null;
}

/** Billing terms an item supports. */
export function termsFor(item: CatalogItem): Term[] {
  const t: Term[] = [];
  if (item.price_usd_month !== undefined) t.push("monthly", "annual");
  if (item.price_usd_hour !== undefined) t.push("hourly", "metered");
  if (item.price_usd !== undefined) t.push("once");
  return t;
}

// ── exact decimal arithmetic (no floats near money) ─────────────────────────

const SCALE = 6;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

export function toMicro(usd: string): bigint {
  const [whole, frac = ""] = usd.split(".");
  return BigInt(whole ?? "0") * SCALE_FACTOR + BigInt(frac.padEnd(SCALE, "0"));
}

export function fromMicro(micro: bigint): string {
  const whole = micro / SCALE_FACTOR;
  const frac = (micro % SCALE_FACTOR).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

/** `micro × (100 − pct) / 100`, rounded down to 1 micro-USD. */
function discount(micro: bigint, pctStr: string): bigint {
  const keep = 100n * 100n - (toMicro(pctStr) * 100n) / SCALE_FACTOR; // basis points kept
  return (micro * keep) / 10_000n;
}

function scaleFor(network: string): string {
  return loadCatalog().price_scale?.[network] ?? "1";
}

/** Apply the network price scale (rounded down to 1 micro-USD). */
export function scaleMicro(micro: bigint, network: string): bigint {
  return (micro * toMicro(scaleFor(network))) / SCALE_FACTOR;
}

// ── order lines ─────────────────────────────────────────────────────────────

export interface OrderLine {
  itemId: string;
  region: string;
  term: Term;
  /** months (monthly), 12 (annual), hours (hourly), 1 (once), 0 (metered). */
  qty: number;
}

export interface PricedLine extends OrderLine {
  item: CatalogItem;
  /** List price of the line before bundle discount / network scale. */
  list_usd: string;
  annual_discount_usd: string;
}

export interface CartPrice {
  lines: PricedLine[];
  bundle: { id: string; name: string; discount_pct: string; discount_usd: string } | null;
  subtotal_usd: string;
  /** Total at list prices (what mainnet charges). */
  list_total_usd: string;
  price_scale: string;
  /** Binding total on `network` (list total × price_scale). */
  total_usd: string;
  /** Monthly-equivalent run rate at list prices (for comparisons). */
  monthly_list_usd: string;
}

const MAX_LINES = 8;

/** Default quantity for a term (months / hours / units). */
export function defaultQty(item: CatalogItem, term: Term): number {
  switch (term) {
    case "monthly": return item.contract_months;
    case "annual": return 12;
    case "hourly": return 24;
    case "metered": return 0;
    case "once": return 1;
  }
}

/** Validate one line against the catalog; returns the item or a reason. */
export function validateLine(
  line: OrderLine,
  opts: { allowMetered?: boolean } = {},
): { ok: true; item: CatalogItem } | { ok: false; reason: string } {
  const item = findItem(line.itemId);
  if (item === null) return { ok: false, reason: `unknown item_id: ${line.itemId}` };
  if (!item.regions.includes(line.region)) {
    return { ok: false, reason: `region ${line.region} not offered for ${item.id} (choose one of ${item.regions.join(", ")})` };
  }
  if (!termsFor(item).includes(line.term)) {
    return { ok: false, reason: `term ${line.term} not available for ${item.id} (use ${termsFor(item).join(", ")})` };
  }
  if (line.term === "metered" && !opts.allowMetered) {
    return { ok: false, reason: "metered (pay-as-you-go) billing is only available when paying with credits" };
  }
  const q = line.qty;
  const okQty =
    (line.term === "monthly" && q === item.contract_months) ||
    (line.term === "annual" && q === 12) ||
    (line.term === "hourly" && Number.isInteger(q) && q >= 1 && q <= 744) ||
    (line.term === "metered" && q === 0) ||
    (line.term === "once" && q === 1);
  if (!okQty) return { ok: false, reason: `invalid quantity ${q} for ${line.term} on ${item.id}` };
  return { ok: true, item };
}

function lineListMicro(item: CatalogItem, line: OrderLine): { list: bigint; annualDiscount: bigint } {
  switch (line.term) {
    case "monthly":
      return { list: toMicro(item.price_usd_month!) * BigInt(line.qty), annualDiscount: 0n };
    case "annual": {
      const full = toMicro(item.price_usd_month!) * 12n;
      const pctStr = loadCatalog().discounts?.annual_prepay_pct ?? "0";
      const net = discount(full, pctStr);
      return { list: net, annualDiscount: full - net };
    }
    case "hourly":
      return { list: toMicro(item.price_usd_hour!) * BigInt(line.qty), annualDiscount: 0n };
    case "metered":
      return { list: 0n, annualDiscount: 0n }; // billed per hour from credits
    case "once":
      return { list: toMicro(item.price_usd!), annualDiscount: 0n };
  }
}

function monthlyRunRate(item: CatalogItem, line: OrderLine): bigint {
  if (line.term === "monthly" || line.term === "annual") return toMicro(item.price_usd_month!);
  if (line.term === "hourly" || line.term === "metered") return toMicro(item.price_usd_hour!) * 730n;
  return 0n;
}

/**
 * Price a cart deterministically. `bundleId` must match the lines exactly
 * (see resolveBundle) for its discount to apply.
 */
export function priceCart(
  lines: OrderLine[],
  bundleId: string | null,
  network: string,
  opts: { allowMetered?: boolean } = {},
): { ok: true; price: CartPrice } | { ok: false; reason: string } {
  if (lines.length === 0) return { ok: false, reason: "empty order" };
  if (lines.length > MAX_LINES) return { ok: false, reason: `at most ${MAX_LINES} lines per order` };
  const priced: PricedLine[] = [];
  let subtotal = 0n;
  let monthly = 0n;
  for (const line of lines) {
    const v = validateLine(line, opts);
    if (!v.ok) return v;
    const { list, annualDiscount } = lineListMicro(v.item, line);
    subtotal += list;
    monthly += monthlyRunRate(v.item, line);
    priced.push({ ...line, item: v.item, list_usd: fromMicro(list), annual_discount_usd: fromMicro(annualDiscount) });
  }

  let bundle: CartPrice["bundle"] = null;
  let listTotal = subtotal;
  if (bundleId !== null) {
    const b = findBundle(bundleId);
    if (b === null) return { ok: false, reason: `unknown bundle: ${bundleId}` };
    const provider = priced[0]?.item.provider;
    if (provider === undefined || provider === "ccm") return { ok: false, reason: "bundle needs a cloud provider" };
    const expected = resolveBundle(b.id, provider, priced[0]!.region, priced[0]!.term === "annual" ? "annual" : "monthly");
    if (!expected.ok || !sameLines(expected.lines, lines)) {
      return { ok: false, reason: `lines do not match bundle ${b.id} for ${provider}` };
    }
    listTotal = discount(subtotal, b.discount_pct);
    bundle = { id: b.id, name: b.name, discount_pct: b.discount_pct, discount_usd: fromMicro(subtotal - listTotal) };
    monthly = discount(monthly, b.discount_pct);
  }

  const total = scaleMicro(listTotal, network);
  const hasMetered = lines.some((l) => l.term === "metered");
  if (total <= 0n && !hasMetered) return { ok: false, reason: "order total rounds to zero" };
  return {
    ok: true,
    price: {
      lines: priced,
      bundle,
      subtotal_usd: fromMicro(subtotal),
      list_total_usd: fromMicro(listTotal),
      price_scale: scaleFor(network),
      total_usd: fromMicro(total),
      monthly_list_usd: fromMicro(monthly),
    },
  };
}

function sameLines(a: OrderLine[], b: OrderLine[]): boolean {
  return a.length === b.length && a.every((l, i) => {
    const o = b[i]!;
    return l.itemId === o.itemId && l.region === o.region && l.term === o.term && l.qty === o.qty;
  });
}

/** Expand a bundle into concrete lines for one provider + region. */
export function resolveBundle(
  bundleId: string,
  provider: CloudProviderId,
  region: string,
  term: "monthly" | "annual" = "monthly",
): { ok: true; bundle: Bundle; lines: OrderLine[] } | { ok: false; reason: string } {
  const b = findBundle(bundleId);
  if (b === null) return { ok: false, reason: `unknown bundle: ${bundleId}` };
  const lines: OrderLine[] = [];
  for (const c of b.components) {
    const item = loadCatalog().items.find((i) => i.provider === provider && i.category === c.category && i.plan === c.plan);
    if (item === undefined) return { ok: false, reason: `bundle ${b.id}: no ${c.category} ${c.plan} on ${provider}` };
    if (!item.regions.includes(region)) return { ok: false, reason: `bundle ${b.id}: ${item.id} not in ${region}` };
    lines.push({ itemId: item.id, region, term, qty: defaultQty(item, term) });
  }
  return { ok: true, bundle: b, lines };
}

/** Regions where every component of a bundle is offered by `provider`. */
export function bundleRegions(bundleId: string, provider: CloudProviderId): string[] {
  const b = findBundle(bundleId);
  if (b === null) return [];
  const sets = b.components.map((c) =>
    loadCatalog().items.find((i) => i.provider === provider && i.category === c.category && i.plan === c.plan)?.regions ?? []);
  return (sets[0] ?? []).filter((r) => sets.every((s) => s.includes(r)));
}

// ── order <-> on-chain task description ─────────────────────────────────────

export interface ParsedOrder {
  lines: OrderLine[];
  bundleId: string | null;
}

const V1_RE = /^CloudCryptoMarket order v1 \| item=([a-z0-9-]+) \| region=([a-z0-9-]+) \| months=(\d+)$/;
const V2_RE = /^CloudCryptoMarket order v2 \| bundle=([a-z0-9-]+|-) \| lines=(.+)$/;
const LINE_RE = /^([a-z0-9-]+)@([a-z0-9-]+)~(monthly|annual|hourly|metered|once)~(\d+)$/;

/** The canonical task line anchored on-chain for an order. */
export function orderTask(order: ParsedOrder): string {
  const lines = order.lines.map((l) => `${l.itemId}@${l.region}~${l.term}~${l.qty}`).join(";");
  return `CloudCryptoMarket order v2 | bundle=${order.bundleId ?? "-"} | lines=${lines}`;
}

/** Parse a v1 or v2 task line back into lines (null if it is not ours). */
export function parseOrderTask(task: string): ParsedOrder | null {
  const t = task.trim();
  const v1 = V1_RE.exec(t);
  if (v1 !== null) {
    return { bundleId: null, lines: [{ itemId: v1[1]!, region: v1[2]!, term: "monthly", qty: Number(v1[3]) }] };
  }
  const v2 = V2_RE.exec(t);
  if (v2 === null) return null;
  const lines: OrderLine[] = [];
  for (const raw of v2[2]!.split(";")) {
    const m = LINE_RE.exec(raw);
    if (m === null) return null;
    lines.push({ itemId: m[1]!, region: m[2]!, term: m[3] as Term, qty: Number(m[4]) });
  }
  return { bundleId: v2[1] === "-" ? null : v2[1]!, lines };
}

/**
 * Build the ERC-8183 negotiation request for an order. `currency` is the
 * selected payment-token address; the SDK's multi-asset handler uses it to
 * pick the matching per-asset offer.
 */
export function orderRequest(order: ParsedOrder, price: CartPrice, currency: string): Record<string, unknown> {
  const summary = price.lines.map((l) => `${l.item.service} ${l.item.plan} (${l.region}, ${l.term}${l.term === "hourly" ? ` ${l.qty}h` : ""})`).join("; ");
  return {
    task_description: orderTask(order),
    terms: {
      deliverables: `Provision and deliver endpoint + access for: ${summary}`.slice(0, 900),
      quality_standards:
        "Each resource is reachable at its delivered endpoint with the delivered " +
        "credentials and matches the catalog specs; consulting lines are tracked as tasks.",
      success_criteria: price.lines.slice(0, MAX_LINES).map((l) => `${l.item.id}: ${JSON.stringify(l.item.specs)}`.slice(0, 200)),
      currency,
    },
  };
}

// ── backward-compatible helpers (single-item v1 API) ────────────────────────

export interface OrderSelection {
  itemId: string;
  region: string;
}

/** v1 helper kept for callers that quote one monthly item. */
export function validateSelection(
  sel: OrderSelection,
): { ok: true; item: CatalogItem } | { ok: false; reason: string } {
  const item = findItem(sel.itemId);
  if (item === null) return { ok: false, reason: `unknown item_id: ${sel.itemId}` };
  const term = termsFor(item)[0] ?? "monthly";
  return validateLine({ itemId: sel.itemId, region: sel.region, term, qty: defaultQty(item, term) });
}

/** Total of a single item at its default term on `network`. */
export function itemTotalUsd(item: CatalogItem, network: string): string {
  const term = termsFor(item)[0]!;
  const r = priceCart([{ itemId: item.id, region: item.regions[0]!, term, qty: defaultQty(item, term) }], null, network);
  if (!r.ok) throw new Error(r.reason);
  return r.price.total_usd;
}
