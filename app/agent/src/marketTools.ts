/**
 * Read-only marketplace queries: `list_catalog`, `get_quote`, `order_status`,
 * `recommend_provider`, `credits_balance`.
 *
 * Shared by the MCP tools, the LLM tools (support assistant) and the web
 * storefront's HTTP API. None of these sign, spend or return secrets.
 * `get_quote` is an UNSIGNED preview — a binding quote only comes from the
 * `negotiate` operation (fixed code in signing.ts).
 */

import { z } from "zod";
import { CATEGORIES, bundleRegions, loadCatalog, priceCart, resolveBundle } from "./catalog.js";
import { creditsSummary } from "./credits.js";
import { creditOrderStatus, orderStatus } from "./orders.js";
import { type OrderInput, previewOrder, sellerPricing } from "./pricing.js";

const lineSchema = z.object({
  item_id: z.string(),
  region: z.string().optional(),
  term: z.enum(["monthly", "annual", "hourly", "metered", "once"]).optional(),
  qty: z.number().int().optional(),
});

export const MARKET_TOOL_CATALOG = {
  list_catalog: {
    description:
      "List CloudCryptoMarket catalog items and bundles (cloud services for sale), optionally filtered by provider (aws|azure|huawei|ccm) and category. Prices are USD list prices; hourly GPU items also have price_usd_hour; annual prepay is 10% off, bundles 15% off.",
    inputSchema: {
      provider: z.enum(["aws", "azure", "huawei", "ccm"]).optional(),
      category: z.enum(CATEGORIES).optional(),
    },
  },
  get_quote: {
    description:
      "Unsigned price preview: one item (item_id, region?, term?, qty?), a cart (lines) or a bundle (bundle_id + provider + region + term?). Returns the exact USD total (incl. discounts and network price scale) and the atomic amount per stablecoin. Use `negotiate` for a binding signed quote.",
    inputSchema: {
      item_id: z.string().optional().describe("catalog item id, e.g. aws-s3-1tb"),
      region: z.string().optional(),
      term: z.enum(["monthly", "annual", "hourly", "metered", "once"]).optional(),
      qty: z.number().int().optional().describe("hours for hourly terms"),
      lines: z.array(lineSchema).optional(),
      bundle_id: z.string().optional(),
      provider: z.enum(["aws", "azure", "huawei"]).optional(),
    },
  },
  order_status: {
    description:
      "Status of an order by its ERC-8183 job id (or credit order id cr-…): pendiente | pagado | provisionado | fallido, plus per-line state, consulting task state, submit tx and provisioned resources (never credentials).",
    inputSchema: {
      job_id: z.number().int().optional().describe("on-chain job id"),
      order_id: z.string().optional().describe("credit order id (cr-…)"),
    },
  },
  recommend_provider: {
    description:
      "Read-only cost advisor: describe a workload (e.g. 'app web con 2 TB de archivos, 4 vCPU, base de datos y tráfico alto') and get the best option per provider with monthly totals, an AWS vs Azure vs Huawei comparison, a reasoned recommendation and a ready cart for negotiate. Never signs or moves money.",
    inputSchema: { description: z.string().min(3).max(2000) },
  },
  credits_balance: {
    description: "Prepaid credits balance and recent movements of a buyer wallet (read-only).",
    inputSchema: { buyer: z.string().regex(/^0x[0-9a-fA-F]{40}$/) },
  },
} as const;

export function listCatalog(filter: { provider?: string; category?: string } = {}) {
  const catalog = loadCatalog();
  const { network } = sellerPricing();
  const clouds = ["aws", "azure", "huawei"] as const;
  return {
    providers: catalog.providers,
    categories: catalog.categories,
    discounts: catalog.discounts,
    price_scale: catalog.price_scale?.[network] ?? "1",
    bundles: (catalog.bundles ?? []).map((b) => ({
      ...b,
      per_provider: clouds.map((p) => {
        const regions = bundleRegions(b.id, p);
        const r = regions[0] ? resolveBundle(b.id, p, regions[0]) : null;
        const price = r?.ok ? priceCart(r.lines, b.id, network) : null;
        return {
          provider: p,
          regions,
          items: r?.ok ? r.lines.map((l) => l.itemId) : [],
          list_usd_month: price?.ok ? price.price.list_total_usd : null,
          subtotal_usd_month: price?.ok ? price.price.subtotal_usd : null,
          total_usd: price?.ok ? price.price.total_usd : null,
        };
      }),
    })),
    items: catalog.items.filter(
      (i) =>
        (filter.provider === undefined || i.provider === filter.provider) &&
        (filter.category === undefined || i.category === filter.category),
    ),
  };
}

export function getQuote(input: OrderInput | string): Record<string, unknown> {
  const r = previewOrder(typeof input === "string" ? { item_id: input } : input, { allowMetered: true });
  if (!r.ok) return { error: r.reason };
  const { lines, ...rest } = r.preview;
  return {
    ...rest,
    lines: lines.map(({ item, ...l }) => ({ ...l, service: item.service, plan: item.plan, provider: item.provider, category: item.category })),
    // v1 fields
    item: lines[0]?.item,
    price_usd: r.preview.total_usd,
    signed: false,
    note: "binding quote: call negotiate with the same order",
  };
}

export async function getOrderStatus(ref: number | string): Promise<Record<string, unknown>> {
  if (typeof ref === "string" && ref.startsWith("cr-")) {
    return creditOrderStatus(ref) ?? { error: `order ${ref} not found` };
  }
  return orderStatus(Number(ref));
}

export function creditsBalance(buyer: string) {
  return creditsSummary(buyer);
}
