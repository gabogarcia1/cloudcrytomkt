import { useEffect } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { cartStore } from "../cart";
import { defaultQty, findItem, termsFor } from "../catalog";

/** Legacy /checkout/:itemId links → single-item cart. */
export function Checkout() {
  const { itemId = "" } = useParams();
  const navigate = useNavigate();
  const item = findItem(itemId);
  useEffect(() => {
    if (item) {
      const term = termsFor(item)[0]!;
      cartStore.setLines([{ item_id: item.id, region: item.regions[0]!, term, qty: defaultQty(item, term) }]);
      navigate("/carrito", { replace: true });
    }
  }, [item, navigate]);
  return item ? null : <Navigate to="/" replace />;
}
