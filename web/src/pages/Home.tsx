import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { cartStore } from "../cart";
import {
  CATALOG,
  CLOUDS,
  type CloudId,
  IS_SCALED,
  PRICE_SCALE,
  bundleItem,
  bundleRegions,
  headline,
  providerName,
  usd,
} from "../catalog";
import { PlanCard } from "../components/PlanCard";

export function Home() {
  const navigate = useNavigate();
  const consulting = CATALOG.items.filter((i) => i.category === "consulting");
  const services = [...new Set(consulting.map((i) => i.service))];
  const credits = CATALOG.items.filter((i) => i.category === "credits");

  return (
    <>
      <section className="hero">
        <h1>Servicios cloud, pagados en stablecoins</h1>
        <p>
          Elige proveedor, servicio y plan. Pagas en U, USDC o USDT en BNB Chain; el pago queda en escrow hasta que el
          agente vendedor aprovisiona tu servicio.
        </p>
        <div className="hero-actions">
          <Link to="/asesor" className="btn">Asesor de costos</Link>
          <Link to="/comparar" className="btn btn-ghost">Comparar proveedores</Link>
        </div>
      </section>

      <section className="provider-grid">
        {CATALOG.providers.map((p) => {
          const items = CATALOG.items.filter((i) => i.provider === p.id && i.price_usd_month);
          const from = items.map((i) => Number(headline(i).value)).reduce((m, v) => Math.min(m, v), Infinity);
          const cats = new Set(items.map((i) => i.category)).size;
          return (
            <Link key={p.id} to={`/proveedor/${p.id}`} className={`provider-card provider-${p.id}`}>
              <div className="provider-logo">{p.name}</div>
              <div className="provider-full">{p.full_name}</div>
              <p className="provider-tagline">{p.tagline}</p>
              <div className="provider-meta">
                <span>{cats} categorías · {items.length} planes</span>
                <span>desde {usd(from)}/mes</span>
              </div>
              <span className="provider-cta">Ver planes →</span>
            </Link>
          );
        })}
      </section>

      <h2 className="section-title" id="paquetes">Paquetes <span className="pill">−15%</span></h2>
      <div className="bundle-grid">
        {(CATALOG.bundles ?? []).map((b) => <BundleCard key={b.id} bundleId={b.id} onBuy={() => navigate("/carrito")} />)}
      </div>

      <h2 className="section-title">Servicios profesionales</h2>
      <p className="muted">Horas de consultoría con seguimiento: cada paquete crea una tarea (pendiente → en curso → entregada) visible en Mis pedidos.</p>
      <div className="plan-grid">
        {services.map((s) => {
          const opts = consulting.filter((i) => i.service === s);
          return <ServiceCard key={s} name={s} items={opts} onBuy={() => navigate("/carrito")} />;
        })}
      </div>

      <h2 className="section-title">Créditos prepagos</h2>
      <p className="muted">Compra saldo y el agente descuenta por uso (por ejemplo, GPU por hora). Las recargas pequeñas también se pueden pagar por x402.</p>
      <div className="plan-grid">
        {credits.map((i) => <PlanCard key={i.id} item={i} />)}
      </div>
    </>
  );
}

function BundleCard({ bundleId, onBuy }: { bundleId: string; onBuy: () => void }) {
  const b = CATALOG.bundles!.find((x) => x.id === bundleId)!;
  const [provider, setProvider] = useState<CloudId>("aws");
  const totals = Object.fromEntries(CLOUDS.map((p) => {
    const parts = b.components.map((c) => bundleItem(p, c));
    const sum = parts.reduce((s, i) => s + Number(i?.price_usd_month ?? 0), 0);
    return [p, { list: sum, net: sum * (1 - Number(b.discount_pct) / 100), parts }];
  })) as Record<CloudId, { list: number; net: number; parts: ReturnType<typeof bundleItem>[] }>;
  const t = totals[provider];
  return (
    <article className="plan-card bundle-card">
      <div className="plan-service">{b.profile}</div>
      <h3 className="plan-name">{b.name}</h3>
      <div className="segmented small-seg">
        {CLOUDS.map((p) => <button key={p} className={provider === p ? "active" : ""} onClick={() => setProvider(p)}>{providerName(p)}</button>)}
      </div>
      <div className="plan-price">{usd((t.net * Number(PRICE_SCALE)).toFixed(6))}<span>/mes</span></div>
      <div className="real-price"><s>{usd(t.list.toFixed(2))}</s> → {usd(t.net.toFixed(2))} precio de lista{IS_SCALED ? ` · prueba ×${PRICE_SCALE}` : ""}</div>
      <ul className="line-list">
        {t.parts.map((i, k) => <li key={k}>{i ? `${i.service} · ${i.plan}` : "—"}</li>)}
      </ul>
      <button className="btn btn-block" onClick={() => { cartStore.setBundle({ id: b.id, provider, region: bundleRegions(b, provider)[0]!, term: "monthly" }); onBuy(); }}>
        Comprar paquete
      </button>
    </article>
  );
}

function ServiceCard({ name, items, onBuy }: { name: string; items: typeof CATALOG.items; onBuy: () => void }) {
  const [id, setId] = useState(items[0]!.id);
  const item = items.find((i) => i.id === id)!;
  return (
    <article className="plan-card">
      <div className="plan-service">Consultoría</div>
      <h3 className="plan-name">{name}</h3>
      <div className="segmented small-seg">
        {items.map((i) => <button key={i.id} className={id === i.id ? "active" : ""} onClick={() => setId(i.id)}>{i.plan}</button>)}
      </div>
      <div className="plan-price">{usd(headline(item).value)}</div>
      {IS_SCALED && <div className="real-price">Precio real {usd(item.price_usd)} · {usd(String(item.specs.rate_usd_hour))}/h</div>}
      <p className="muted small">{String(item.specs.entrega)}</p>
      <button className="btn btn-block" onClick={() => { cartStore.setLines([{ item_id: item.id, region: "global", term: "once", qty: 1 }]); onBuy(); }}>Contratar</button>
    </article>
  );
}
