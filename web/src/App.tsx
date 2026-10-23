import { Link, NavLink, Route, Routes } from "react-router-dom";
import { cartSize, useCart } from "./cart";
import { WalletBalances } from "./components/WalletBalances";
import { WalletButton } from "./components/WalletButton";
import { CHAIN } from "./config";
import { Advisor } from "./pages/Advisor";
import { Cart } from "./pages/Cart";
import { Checkout } from "./pages/Checkout";
import { Compare } from "./pages/Compare";
import { Home } from "./pages/Home";
import { Orders } from "./pages/Orders";
import { ProviderPage } from "./pages/ProviderPage";

export function App() {
  const cart = useCart();
  const n = cartSize(cart);
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">◆</span> CloudCryptoMarket
        </Link>
        <nav className="nav">
          <NavLink to="/" end>Proveedores</NavLink>
          <NavLink to="/comparar">Comparar</NavLink>
          <NavLink to="/asesor">Asesor</NavLink>
          <NavLink to="/carrito">Carrito{n > 0 ? ` (${n})` : ""}</NavLink>
          <NavLink to="/pedidos">Mis pedidos</NavLink>
        </nav>
        <WalletBalances />
        <WalletButton />
      </header>
      {CHAIN.chainId !== 56 && (
        <div className="banner">Red de pruebas BNB Chain Testnet: los pagos usan tokens de prueba sin valor (precios ×0.001).</div>
      )}
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/proveedor/:providerId" element={<ProviderPage />} />
          <Route path="/comparar" element={<Compare />} />
          <Route path="/asesor" element={<Advisor />} />
          <Route path="/carrito" element={<Cart />} />
          <Route path="/checkout/:itemId" element={<Checkout />} />
          <Route path="/pedidos" element={<Orders />} />
        </Routes>
      </main>
      <footer className="footer">
        Pagos en escrow ERC-8183 sobre BNB Chain · tu wallet firma, la web nunca ve tus claves.
      </footer>
    </div>
  );
}
