import { Link, useParams, useSearchParams } from "react-router-dom";
import { CATALOG, type CategoryId, providerOf } from "../catalog";
import { PlanCard } from "../components/PlanCard";

export function ProviderPage() {
  const { providerId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const provider = providerOf(providerId);
  if (provider === null) return <p>Proveedor no encontrado. <Link to="/">Volver</Link></p>;

  const tabs = CATALOG.categories.filter((c) => CATALOG.items.some((i) => i.provider === provider.id && i.category === c.id));
  const tab = (params.get("cat") as CategoryId | null) ?? tabs[0]?.id ?? "storage";
  const items = CATALOG.items.filter((i) => i.provider === provider.id && i.category === tab);

  return (
    <>
      <div className="page-head">
        <Link to="/" className="back">← Proveedores</Link>
        <h1>{provider.full_name}</h1>
        <Link to="/comparar" className="btn btn-ghost">Comparar con otros proveedores</Link>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map((c) => (
          <button key={c.id} role="tab" aria-selected={tab === c.id} className={`tab ${tab === c.id ? "active" : ""}`} onClick={() => setParams({ cat: c.id })}>
            {c.name}
          </button>
        ))}
      </div>
      <p className="muted">{CATALOG.categories.find((c) => c.id === tab)?.description}</p>
      <div className="plan-grid">
        {items.map((item) => <PlanCard key={item.id} item={item} />)}
      </div>
    </>
  );
}
