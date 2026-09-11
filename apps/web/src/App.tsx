import { Route, Routes } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import { Home } from "./pages/Home";
import { LandingPage } from "./pages/Landing";
import { LoginPage } from "./pages/Login";
import { SignupPage } from "./pages/Signup";
import { ForgotPasswordPage } from "./pages/ForgotPassword";
import { ResetPasswordPage } from "./pages/ResetPassword";
import { DashboardPage } from "./pages/Dashboard";
import { OrdersPage } from "./pages/Orders";
import { DispatchBoardPage } from "./pages/delivery/DispatchBoard";
import { DeliveryAnalyticsPage } from "./pages/delivery/DeliveryAnalytics";
import { DriversPage } from "./pages/delivery/Drivers";
import { DriverAppPage } from "./pages/delivery/DriverApp";
import { PosPage } from "./pages/Pos";
import { TablesPage } from "./pages/Tables";
import { KdsPage } from "./pages/Kds";
import { ProductsPage } from "./pages/Products";
import { CustomersPage } from "./pages/Customers";
import { CouponsPage } from "./pages/Coupons";
import { StockPage } from "./pages/Stock";
import { FinancePage } from "./pages/Finance";
import { ReportsPage } from "./pages/Reports";
import { SettingsPage } from "./pages/Settings";
import { WhatsAppPage } from "./pages/WhatsApp";
import { PublicMenuPage } from "./pages/menu/PublicMenu";
import { ReviewPage } from "./pages/menu/ReviewPage";
import { TrackOrderPage } from "./pages/menu/TrackOrder";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/vendas" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/cadastro" element={<SignupPage />} />
      <Route path="/esqueci-senha" element={<ForgotPasswordPage />} />
      <Route path="/redefinir-senha" element={<ResetPasswordPage />} />
      <Route path="/motoboy" element={<DriverAppPage />} />
      <Route path="/cardapio/:slug" element={<PublicMenuPage />} />
      <Route path="/cardapio/:slug/pedido/:orderId" element={<TrackOrderPage />} />
      <Route path="/cardapio/:slug/avaliar/:orderId" element={<ReviewPage />} />
      <Route element={<AppShell />}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/pedidos" element={<OrdersPage />} />
        <Route path="/entregas" element={<DispatchBoardPage />} />
        <Route path="/entregas-metricas" element={<DeliveryAnalyticsPage />} />
        <Route path="/entregadores" element={<DriversPage />} />
        <Route path="/pdv" element={<PosPage />} />
        <Route path="/mesas" element={<TablesPage />} />
        <Route path="/kds" element={<KdsPage />} />
        <Route path="/whatsapp" element={<WhatsAppPage />} />
        <Route path="/produtos" element={<ProductsPage />} />
        <Route path="/clientes" element={<CustomersPage />} />
        <Route path="/cupons" element={<CouponsPage />} />
        <Route path="/estoque" element={<StockPage />} />
        <Route path="/financeiro" element={<FinancePage />} />
        <Route path="/relatorios" element={<ReportsPage />} />
        <Route path="/configuracoes" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
