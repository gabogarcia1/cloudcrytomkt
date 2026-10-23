/**
 * Single-checkout cart (per browser). Either free lines or one bundle.
 * Only catalog references are stored — prices always come from the agent.
 */
import { useSyncExternalStore } from "react";
import type { CloudId, Term } from "./catalog";

export interface CartLine {
  item_id: string;
  region: string;
  term: Term;
  qty: number;
}

export interface Cart {
  lines: CartLine[];
  bundle: { id: string; provider: CloudId; region: string; term: "monthly" | "annual" } | null;
  /** Where the cart came from (shown as a hint), e.g. "Asesor de costos". */
  source?: string;
}

const KEY = "ccm.cart.v1";
const EMPTY: Cart = { lines: [], bundle: null };
let current: Cart = load();
const listeners = new Set<() => void>();

function load(): Cart {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) ?? "null") as Cart | null;
    return c && Array.isArray(c.lines) ? c : EMPTY;
  } catch {
    return EMPTY;
  }
}

function save(next: Cart): void {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable — cart lives in memory for this tab
  }
  for (const l of listeners) l();
}

export const cartStore = {
  get: () => current,
  setLines(lines: CartLine[], source?: string) { save({ lines: lines.slice(0, 8), bundle: null, source }); },
  addLine(line: CartLine) {
    const base = current.bundle ? [] : current.lines;
    save({ lines: [...base, line].slice(0, 8), bundle: null });
  },
  updateLine(i: number, patch: Partial<CartLine>) {
    save({ ...current, lines: current.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  },
  removeLine(i: number) { save({ ...current, lines: current.lines.filter((_, j) => j !== i) }); },
  setBundle(bundle: NonNullable<Cart["bundle"]>) { save({ lines: [], bundle, source: "Paquete" }); },
  updateBundle(patch: Partial<NonNullable<Cart["bundle"]>>) {
    if (current.bundle) save({ ...current, bundle: { ...current.bundle, ...patch } });
  },
  clear() { save(EMPTY); },
};

export function useCart(): Cart {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => current,
  );
}

export const cartSize = (c: Cart) => (c.bundle ? 1 : c.lines.length);

/** The order payload the agent understands (negotiate / quote / credits). */
export function orderPayload(c: Cart): Record<string, unknown> {
  return c.bundle
    ? { bundle_id: c.bundle.id, provider: c.bundle.provider, region: c.bundle.region, term: c.bundle.term }
    : { lines: c.lines };
}
