/**
 * Read-only price resolution: order lines → USD total (catalog.ts) → per-asset
 * atomic amount. No signing here; `signing.ts` reuses these helpers for the
 * signed quote and `get_quote` uses them for an unsigned preview.
 */

import { getAsset, resolveAssetAlias } from "@bnbagent/sdk/networks";
import { loadStudioToml } from "@bnbagent/studio-runtime/config";
import { erc8183Network } from "@bnbagent/studio-runtime/erc8183";
import { usdPriceToAtomic } from "@bnbagent/studio-runtime/networks";
import { resolveSellerPolicy } from "@bnbagent/studio-runtime/policy";
import {
  type CartPrice,
  type CloudProviderId,
  type OrderLine,
  type Term,
  defaultQty,
  findItem,
  priceCart,
  resolveBundle,
  termsFor,
} from "./catalog.js";

export interface SellerAssetInfo {
  assetId: string;
  symbol: string;
  address: string;
  decimals: number;
}

export interface SellerPricing {
  network: string;
  chainId: number;
  assets: SellerAssetInfo[];
}

/** The seller's network + accepted assets from `[payments.seller]`. */
export function sellerPricing(): SellerPricing {
  const resolved = resolveSellerPolicy(loadStudioToml(), "erc8183");
  if (resolved.source !== "canonical") {
    throw new Error("CloudCryptoMarket requires canonical [payments.seller] config");
  }
  const network = resolved.policy.network;
  const chainId = erc8183Network(network).chainId;
  const assets = resolved.policy.assets.map((assetId) => {
    const a = getAsset(chainId, assetId);
    return { assetId: a.assetId, symbol: a.symbol, address: a.address, decimals: a.decimals };
  });
  return { network, chainId, assets };
}

/**
 * Resolve a buyer's asset choice ("USDC", "TEST_USDC" or a token address) to
 * one of the seller's accepted assets, or null.
 */
export function resolveSellerAsset(
  pricing: SellerPricing,
  requested: string | undefined,
): SellerAssetInfo | null {
  if (requested === undefined || requested === "") return pricing.assets[0] ?? null;
  const r = requested.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(r)) {
    return pricing.assets.find((a) => a.address.toLowerCase() === r.toLowerCase()) ?? null;
  }
  let assetId: string;
  try {
    assetId = resolveAssetAlias(pricing.chainId, r);
  } catch {
    assetId = r.toUpperCase();
  }
  return pricing.assets.find((a) => a.assetId === assetId) ?? null;
}

/** Atomic amount of `totalUsd` in every accepted asset. */
export function atomicAmounts(pricing: SellerPricing, totalUsd: string) {
  return pricing.assets.map((a) => ({
    ...a,
    amount_atomic: usdPriceToAtomic(pricing.network, a.assetId as never, totalUsd).toString(),
  }));
}

// ── order input normalisation (shared by negotiate, get_quote, credits) ────

export interface OrderInput {
  item_id?: string;
  region?: string;
  term?: string;
  qty?: number | string;
  lines?: Array<{ item_id?: string; region?: string; term?: string; qty?: number | string }>;
  bundle_id?: string;
  provider?: string;
}

/**
 * Turn a buyer request — one item, explicit lines, or a bundle — into order
 * lines. Defaults: first region, first billing term, default quantity.
 */
export function normalizeOrder(
  input: OrderInput,
): { ok: true; lines: OrderLine[]; bundleId: string | null } | { ok: false; reason: string } {
  if (typeof input.bundle_id === "string" && input.bundle_id !== "") {
    const provider = String(input.provider ?? "") as CloudProviderId;
    if (!["aws", "azure", "huawei"].includes(provider)) {
      return { ok: false, reason: "bundle orders need provider: aws | azure | huawei" };
    }
    const term = input.term === "annual" ? "annual" : "monthly";
    const r = resolveBundle(input.bundle_id, provider, String(input.region ?? ""), term);
    return r.ok ? { ok: true, lines: r.lines, bundleId: input.bundle_id } : r;
  }
  const raw = Array.isArray(input.lines)
    ? input.lines
    : [{ item_id: input.item_id, region: input.region, term: input.term, qty: input.qty }];
  const lines: OrderLine[] = [];
  for (const l of raw) {
    const item = findItem(String(l.item_id ?? ""));
    if (item === null) return { ok: false, reason: `unknown item_id: ${String(l.item_id)}` };
    const term = (l.term ?? termsFor(item)[0]) as Term;
    const qty = l.qty === undefined || l.qty === "" ? defaultQty(item, term) : Number(l.qty);
    lines.push({ itemId: item.id, region: String(l.region ?? item.regions[0]), term, qty });
  }
  return { ok: true, lines, bundleId: null };
}

export interface CartPreview extends CartPrice {
  network: string;
  chain_id: number;
  amounts: Array<SellerAssetInfo & { amount_atomic: string }>;
}

/** Unsigned price preview for any order input, in every accepted asset. */
export function previewOrder(
  input: OrderInput,
  opts: { allowMetered?: boolean } = {},
): { ok: true; preview: CartPreview } | { ok: false; reason: string } {
  const n = normalizeOrder(input);
  if (!n.ok) return n;
  const pricing = sellerPricing();
  const p = priceCart(n.lines, n.bundleId, pricing.network, opts);
  if (!p.ok) return p;
  return {
    ok: true,
    preview: { ...p.price, network: pricing.network, chain_id: pricing.chainId, amounts: atomicAmounts(pricing, p.price.total_usd) },
  };
}

/** v1-compatible single-item preview (default term). */
export function previewPrice(itemId: string) {
  const r = previewOrder({ item_id: itemId });
  if (!r.ok) return null;
  const line = r.preview.lines[0]!;
  return { item: line.item, price_usd: r.preview.total_usd, ...r.preview };
}
