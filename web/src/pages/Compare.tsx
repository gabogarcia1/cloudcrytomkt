import { Fragment } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { cartStore } from "../cart";
import {
  CATALOG,
  CLOUDS,
  type CategoryId,
  type CatalogItem,
  IS_SCALED,
  bundleItem,
  bundleRegions,
  defaultQty,
  providerName,
  specList,
  termsFor,
  usd,
} from "../catalog";

const CLOUD_CATEGORIES = CATALOG.categories.filter((c) => !["credits", "consulting"].includes(c.id));

function listMonthly(i: CatalogItem): number {
  return Number(i.price_usd_month ?? Number(i.price_usd_hour ?? 0) * 730);
}

export function Compare() {
  const [params, setParams] = useSearchParams();
  const cat = (params.get("cat") as CategoryId | null) ?? "compute";
  const items = CATALOG.items.filter((i) => i.category === cat);
  const plans = [...new Set(items.map((i) => i.plan))];

  return (
    <>
      <div className="page-head">
        <h1>Comparar proveedores</h1>
        <Link to="/asesor" className="btn btn-ghost">¿No sabes qué elegir? Asesor de costos →</Link>
      </div>
      <div className="tabs" role="tablist">
        {CLOUD_CATEGORIES.map((c) => (
          <button key={c.id} role="tab" aria-selected={cat === c.id} className={`tab ${cat === c.id ? "active" : ""}`} onClick={() => setParams({ cat: c.id })}>{c.name}</button>
        ))}
      </div>
      <p className="muted small">
        Precios de lista mensuales (GPU: precio mensual; también se vende por hora).
        {IS_SCALED && " En testnet se cobra el precio de prueba (×0.001)."} En verde, la opción más económica de cada fila.
      </p>
      <div className="table-wrap">
        <table className="compare">
          <thead>
            <tr><th>Plan</th>{CLOUDS.map((p) => <th key={p} className={`th-${p}`}>{providerName(p)}</th>)}</tr>
          </thead>
          <tbody>
            {plans.map((plan) => {
              const row = CLOUDS.map((p) => items.find((i) => i.provider === p && i.plan === plan) ?? null);
              const min = Math.min(...row.filter(Boolean).map((i) => listMonthly(i!)));
              return (
                <tr key={plan}>
                  <th scope="row">{plan}</th>
                  {row.map((it, k) => (
                    <td key={k} className={it && listMonthly(it) === min ? "best" : ""}>
                      {it ? (
                        <>
                          <div className="cell-service">{it.service}</div>
                          <div className="cell-price">{usd(it.price_usd_month ?? it.price_usd)}<span>/mes</span></div>
                          {it.price_usd_hour && <div className="cell-sub">{usd(it.price_usd_hour)}/hora</div>}
                          <div className="cell-sub">{specList(it).slice(0, 3).map(([k2, v]) => `${k2}: ${v}`).join(" · ")}</div>
                          <button className="link-btn" onClick={() => { const t = termsFor(it)[0]!; cartStore.addLine({ item_id: it.id, region: it.regions[0]!, term: t, qty: defaultQty(it, t) }); }}>+ carrito</button>
                        </>
                      ) : "—"}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2 className="section-title">Paquetes (−15%)</h2>
      <div className="table-wrap">
        <table className="compare">
          <thead><tr><th>Paquete</th>{CLOUDS.map((p) => <th key={p} className={`th-${p}`}>{providerName(p)}</th>)}</tr></thead>
          <tbody>
            {(CATALOG.bundles ?? []).map((b) => {
              const totals = CLOUDS.map((p) => {
                const parts = b.components.map((c) => bundleItem(p, c));
                return parts.every(Boolean) ? parts.reduce((s, i) => s + Number(i!.price_usd_month ?? 0), 0) * (1 - Number(b.discount_pct) / 100) : null;
              });
              const min = Math.min(...totals.filter((t): t is number => t !== null));
              return (
                <tr key={b.id}>
                  <th scope="row">{b.name}<div className="cell-sub">{b.description}</div></th>
                  {CLOUDS.map((p, k) => (
                    <td key={p} className={totals[k] === min ? "best" : ""}>
                      {totals[k] !== null ? (
                        <Fragment>
                          <div className="cell-price">{usd(totals[k]!.toFixed(2))}<span>/mes</span></div>
                          <button className="link-btn" onClick={() => cartStore.setBundle({ id: b.id, provider: p, region: bundleRegions(b, p)[0]!, term: "monthly" })}>Elegir</button>
                        </Fragment>
                      ) : "—"}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">Precios de lista orientativos; el monto exacto lo firma el agente al cotizar.</p>
    </>
  );
}
