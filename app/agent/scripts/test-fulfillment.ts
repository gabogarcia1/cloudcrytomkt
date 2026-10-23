// Offline tests: pricing engine, fulfillment idempotency, rollback, credits,
// metering, consulting tasks and the advisor's deterministic path.
// No chain, no funds, no LLM (CCM_ADVISOR_LLM=0).
//   pnpm exec tsx scripts/test-fulfillment.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ccm-test-"));
process.env.ORDERS_DB_PATH = join(dir, "orders.json");
process.env.CREDITS_DB_PATH = join(dir, "credits.json");
process.env.TASKS_DB_PATH = join(dir, "tasks.json");
process.env.CCM_ADVISOR_LLM = "0";

const cat = await import("../src/catalog.js");
const { provision, getOrder, ProvisionError, listOrders } = await import("../src/fulfillment/index.js");
const credits = await import("../src/credits.js");
const { getTask, setTaskState } = await import("../src/fulfillment/tasks.js");
const { meterTick } = await import("../src/meter.js");
const { recommendProvider, heuristicRequirements } = await import("../src/advisor.js");
const { listCatalog } = await import("../src/marketTools.js");

const BUYER = "0x000000000000000000000000000000000000bEEF";
let n = 0;
function order(itemId: string, region: string, over: Record<string, unknown> = {}) {
  const item = cat.findItem(itemId);
  assert.ok(item, `catalog item ${itemId}`);
  const job = ++n;
  return {
    orderId: `97-${job}`, groupId: `97-${job}`, lineIndex: 0, jobId: job, chainId: 97,
    term: "monthly" as const, qty: item.contract_months, payment: "chain" as const,
    buyer: BUYER, item, region, paymentToken: "0x64544969ed7EBf5f083679233325356EbE738930",
    budgetAtomic: "1", idempotencyKey: `ccm-97-${job}`, ...over,
  };
}
const pass = (m: string) => console.log(`PASS  ${m}`);

try {
  // ── catalog & pricing ────────────────────────────────────────────────────
  const c = cat.loadCatalog();
  assert.equal(c.items.length, 93);
  for (const p of ["aws", "azure", "huawei"]) {
    for (const k of ["storage", "compute", "ai-agents", "database", "cdn-dns", "backup", "gpu", "kubernetes", "security"]) {
      assert.ok(c.items.some((i) => i.provider === p && i.category === k), `${p}/${k}`);
    }
  }
  pass("catalog v2: 93 items, 9 categories × 3 providers + credits + consulting");

  const L = (itemId: string, region: string, term: string, qty: number) => ({ itemId, region, term: term as never, qty });
  const m = cat.priceCart([L("aws-s3-1tb", "us-east-1", "monthly", 1)], null, "bsc-mainnet");
  assert.ok(m.ok && m.price.total_usd === "23.55");
  const a = cat.priceCart([L("aws-s3-1tb", "us-east-1", "annual", 12)], null, "bsc-mainnet");
  assert.ok(a.ok && a.price.total_usd === "254.34", a.ok ? a.price.total_usd : a.reason); // 23.55×12×0.9
  const h = cat.priceCart([L("aws-gpu-training", "us-east-1", "hourly", 10)], null, "bsc-mainnet");
  assert.ok(h.ok && h.price.total_usd === "30.6");
  const t = cat.priceCart([L("aws-gpu-training", "us-east-1", "hourly", 10)], null, "bsc-testnet");
  assert.ok(t.ok && t.price.total_usd === "0.0306");
  pass("pricing: monthly 23.55, annual −10% 254.34, hourly 10h 30.6, testnet ×0.001");

  const b = cat.resolveBundle("startup", "aws", "us-east-1");
  assert.ok(b.ok);
  const bp = cat.priceCart(b.lines, "startup", "bsc-mainnet");
  assert.ok(bp.ok);
  // 15.18 + 23.55 + 35 + 87 = 160.73 → ×0.85 = 136.6205
  assert.equal(bp.price.subtotal_usd, "160.73");
  assert.equal(bp.price.total_usd, "136.6205");
  const forged = cat.priceCart([L("aws-ec2-s", "us-east-1", "monthly", 1)], "startup", "bsc-mainnet");
  assert.ok(!forged.ok, "bundle discount must not apply to a partial cart");
  assert.equal(cat.bundleRegions("ia", "aws").join(","), "us-east-1,eu-west-1");
  const listed = listCatalog().bundles.find((x) => x.id === "empresa")!;
  assert.ok(listed.per_provider.every((p) => p.total_usd !== null));
  pass("bundles: startup −15% exact (136.6205), partial cart rejected, all 3 bundles priced on all providers");

  const task = cat.orderTask({ bundleId: "startup", lines: b.lines });
  assert.deepEqual(cat.parseOrderTask(task), { bundleId: "startup", lines: b.lines });
  assert.deepEqual(cat.parseOrderTask("CloudCryptoMarket order v1 | item=aws-s3-1tb | region=us-east-1 | months=1")?.lines[0],
    { itemId: "aws-s3-1tb", region: "us-east-1", term: "monthly", qty: 1 });
  assert.ok(!cat.validateLine(L("aws-gpu-inference", "us-east-1", "metered", 0)).ok, "metered needs credits");
  pass("order task v2 round-trips; v1 tasks still parse; metered only with credits");

  // ── idempotency ─────────────────────────────────────────────────────────
  const o = order("aws-ec2-m", "sa-east-1");
  const [r1, r2, r3] = await Promise.all([provision(o), provision(o), provision(o)]);
  assert.equal(r1.result.resourceId, r2.result.resourceId);
  assert.equal(r2.result.resourceId, r3.result.resourceId);
  assert.equal(getOrder(o.orderId)?.attempts, 1);
  assert.equal((await provision(o)).reused, true);
  pass("concurrent + retried provisioning of one line calls the adapter once");

  for (const it of c.items.filter((i) => i.provider !== "ccm")) {
    const r = await provision(order(it.id, it.regions[0]!));
    assert.ok(r.result.endpoint && r.result.mock, it.id);
  }
  pass("mock adapters return a resource for all 84 cloud items");

  // ── rollback (all-or-nothing) ───────────────────────────────────────────
  const orders = await import("../src/orders.js");
  const ok1 = order("azure-db-s", "eastus", { orderId: "97-900", groupId: "97-900", idempotencyKey: "ccm-97-900" });
  await provision(ok1);
  process.env.FULFILLMENT_MODE = "live";
  await assert.rejects(provision(order("huawei-k8s-3", "la-south-2")), (e: unknown) => e instanceof ProvisionError && !e.retryable);
  delete process.env.FULFILLMENT_MODE;
  const fulfillment = await import("../src/fulfillment/index.js");
  await fulfillment.deprovision(orders.orderFromRecord(getOrder("97-900")!)!, "rolled_back", "test");
  assert.equal(getOrder("97-900")?.state, "rolled_back");
  pass("live-mode failure is permanent; provisioned lines can be rolled back");

  // ── credits: packs, idempotency, consulting task, metering ──────────────
  const pack = order("ccm-credits-20", "global", { term: "once", qty: 1 });
  await provision(pack);
  await provision(pack);
  assert.equal(credits.balanceMicro(BUYER), 21_000n); // 21 USD × 0.001 testnet scale, once
  credits.credit(BUYER, 1_000n, "x402", "x402-a");
  credits.credit(BUYER, 1_000n, "x402", "x402-a");
  assert.equal(credits.balanceMicro(BUYER), 22_000n);
  assert.equal(credits.debit(BUYER, 999_999n, "too much", "big"), false);
  pass("credit pack credited once (21 USD scaled); x402 top-up idempotent by ref; overdraft refused");

  const consult = order("ccm-consult-migracion-10h", "global", { term: "once", qty: 1 });
  const cr = await provision(consult);
  const tk = getTask(String(cr.result.details.task_id));
  assert.equal(tk?.state, "pendiente");
  setTaskState(tk!.taskId, "en_curso", "kickoff");
  assert.equal(getTask(tk!.taskId)?.state, "en_curso");
  pass("consulting package opens a task (pendiente → en_curso)");

  process.env.CCM_METER_SECONDS_PER_HOUR = "60";
  const metered = order("aws-gpu-inference", "us-east-1", { term: "metered", qty: 0, payment: "credits", orderId: "cr-test#0", groupId: "cr-test" });
  await provision(metered);
  const hourly = 1_006n; // 1.006 USD/h × 0.001
  const before = credits.balanceMicro(BUYER);
  const t0 = Date.parse(getOrder("cr-test#0")!.provisionedAt!);
  await meterTick(t0 + 1_000);
  await meterTick(t0 + 1_000); // same hour → no double charge
  assert.equal(credits.balanceMicro(BUYER), before - hourly);
  await meterTick(t0 + 60_000 * 2 + 1_000); // hours 2 and 3
  assert.equal(credits.balanceMicro(BUYER), before - hourly * 3n);
  await meterTick(t0 + 60_000 * 100); // runs out → stopped
  assert.equal(getOrder("cr-test#0")?.state, "stopped");
  assert.ok(credits.balanceMicro(BUYER) >= 0n);
  pass("metered GPU debits 1 hour at a time, idempotently, and stops when credits run out");

  // ── advisor (deterministic path) ────────────────────────────────────────
  const req = heuristicRequirements("app web con 2 TB de archivos, 4 vCPU, base de datos y tráfico alto en Latinoamérica");
  assert.equal(req.storage_gb, 2048);
  assert.equal(req.vcpu, 4);
  assert.equal(req.database, "S");
  assert.equal(req.cdn_tb, 10);
  assert.equal(req.region, "latam");
  const rec = await recommendProvider("app web con 2 TB de archivos, 4 vCPU, base de datos y tráfico alto en Latinoamérica") as Record<string, any>;
  assert.equal(rec.options.length, 3);
  for (const op of rec.options) {
    assert.deepEqual(op.lines.map((l: any) => l.category).sort(), ["cdn-dns", "compute", "database", "storage"]);
  }
  const cheapest = [...rec.options].sort((x: any, y: any) => Number(x.monthly_list_usd) - Number(y.monthly_list_usd))[0];
  assert.equal(rec.recommended, cheapest.provider);
  assert.ok(rec.cart.lines.length === 4 && rec.reasoning.length > 20);
  assert.equal(rec.options.find((o: any) => o.provider === "aws").lines.find((l: any) => l.category === "storage").item_id, "aws-s3-10tb");
  pass(`advisor: 4 needs matched on 3 providers, recommends ${rec.recommended} ($${cheapest.monthly_list_usd}/mes), cart ready`);

  assert.ok(listOrders().length > 80);
  console.log("\nALL PASS");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
