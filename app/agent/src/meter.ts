/**
 * Usage meter for pay-as-you-go ("metered") lines paid with credits.
 *
 * Each started billing hour of a running metered resource debits its
 * `price_usd_hour` (× the network price scale) from the buyer's credits,
 * idempotently (`ref = meter-<orderId>-<hour>`). When the balance cannot
 * cover the next hour, the resource is stopped (deprovisioned, state
 * "stopped"). The loop also retries credit orders left incomplete by a
 * transient provisioning failure.
 *
 * CCM_METER_SECONDS_PER_HOUR (default 3600) lets a demo compress time, e.g.
 * 60 → one billed "hour" per real minute. No chain access, no signing.
 */

import { scaleMicro, toMicro } from "./catalog.js";
import { debit } from "./credits.js";
import { deprovision, listOrders, updateOrder } from "./fulfillment/index.js";
import { orderFromRecord, retryIncompleteCreditOrders } from "./orders.js";
import { sellerPricing } from "./pricing.js";

export function secondsPerHour(): number {
  const v = Number(process.env.CCM_METER_SECONDS_PER_HOUR ?? 3600);
  return Number.isFinite(v) && v >= 10 ? v : 3600;
}

export async function meterTick(now = Date.now()): Promise<void> {
  const network = sellerPricing().network;
  const period = secondsPerHour() * 1000;
  for (const rec of listOrders()) {
    if (rec.term !== "metered" || !["provisioned", "delivered"].includes(rec.state) || !rec.provisionedAt) continue;
    const order = orderFromRecord(rec);
    if (order === null || order.item.price_usd_hour === undefined) continue;
    const hourly = scaleMicro(toMicro(order.item.price_usd_hour), network);
    // Hours are billed at their START: hour 1 as soon as it is running.
    const due = Math.floor((now - Date.parse(rec.provisionedAt)) / period) + 1;
    let billed = rec.meteredHoursBilled ?? 0;
    while (billed < due) {
      const next = billed + 1;
      if (!debit(rec.buyer, hourly, `uso ${order.item.id} hora ${next}`, `meter-${rec.orderId}-${next}`)) {
        await deprovision(order, "stopped", `credits exhausted after ${billed} h`);
        break;
      }
      billed = next;
      updateOrder(rec.orderId, { meteredHoursBilled: billed });
    }
  }
  await retryIncompleteCreditOrders();
}

/** Start the background loop (dev + deployed runtime). */
export function startMeter(): () => void {
  const everyMs = Math.min(secondsPerHour(), 60) * 1000;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    meterTick()
      .catch((e) => console.error("[meter] tick failed", e instanceof Error ? e.message : e))
      .finally(() => { running = false; });
  };
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}
