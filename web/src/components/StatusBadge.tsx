import type { UiStatus } from "../agent";

const LABEL: Record<UiStatus, string> = {
  pendiente: "Pendiente",
  pagado: "Pagado",
  provisionado: "Provisionado",
  fallido: "Fallido",
};

export function StatusBadge({ status }: { status: UiStatus }) {
  return <span className={`badge badge-${status}`}>{LABEL[status]}</span>;
}
