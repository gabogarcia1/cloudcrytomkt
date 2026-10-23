import { useNavigate } from "react-router-dom";
import { cartStore } from "../cart";
import {
  type CatalogItem,
  IS_SCALED,
  PRICE_SCALE,
  defaultQty,
  headline,
  regionName,
  scaled,
  specList,
  termsFor,
  usd,
} from "../catalog";

export function PlanCard({ item }: { item: CatalogItem }) {
  const navigate = useNavigate();
  const h = headline(item);
  const term = termsFor(item)[0]!;
  const line = { item_id: item.id, region: item.regions[0]!, term, qty: defaultQty(item, term) };

  return (
    <article className="plan-card">
      <div className="plan-service">{item.service}</div>
      <h3 className="plan-name">{item.plan}</h3>
      <div className="plan-price">{usd(h.value)}<span>{h.unit}</span></div>
      {item.price_usd_hour !== undefined && item.price_usd_month !== undefined && (
        <div className="plan-alt">o {usd(scaled(item.price_usd_hour))}/hora</div>
      )}
      {item.price_usd_month !== undefined && <div className="plan-alt">Anual prepago −10%</div>}
      {IS_SCALED && <div className="real-price">Precio real {usd(h.list)}{h.unit} · prueba ×{PRICE_SCALE}</div>}
      <dl className="specs">
        {specList(item).map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
        {item.provider !== "ccm" && (
          <div><dt>Regiones</dt><dd>{item.regions.map((r) => regionName(item.provider, r)).join(", ")}</dd></div>
        )}
      </dl>
      <div className="card-actions">
        <button className="btn btn-ghost" onClick={() => cartStore.addLine(line)}>Agregar</button>
        <button className="btn" onClick={() => { cartStore.setLines([line]); navigate("/carrito"); }}>Comprar</button>
      </div>
    </article>
  );
}
