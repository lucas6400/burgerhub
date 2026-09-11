import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { errorHandler } from "./middlewares/error.js";
import { rateLimit } from "./middlewares/rateLimit.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { categoriesRoutes } from "./modules/catalog/categories.routes.js";
import { productsRoutes } from "./modules/catalog/products.routes.js";
import { addonsRoutes } from "./modules/catalog/addons.routes.js";
import { ordersRoutes } from "./modules/orders/orders.routes.js";
import { customersRoutes } from "./modules/customers/customers.routes.js";
import { couponsRoutes } from "./modules/coupons/coupons.routes.js";
import { dashboardRoutes } from "./modules/dashboard/dashboard.routes.js";
import { reviewsRoutes } from "./modules/reviews/reviews.routes.js";
import { stockRoutes } from "./modules/stock/stock.routes.js";
import { financeRoutes } from "./modules/finance/finance.routes.js";
import { settingsRoutes } from "./modules/settings/settings.routes.js";
import { publicRoutes } from "./modules/public/public.routes.js";
import { whatsappRoutes } from "./modules/whatsapp/whatsapp.routes.js";
import { paymentsRoutes } from "./modules/payments/payments.routes.js";
import { uploadsRoutes } from "./modules/uploads/uploads.routes.js";
import { tablesRoutes } from "./modules/tables/tables.routes.js";
import { loyaltyRoutes } from "./modules/loyalty/loyalty.routes.js";
import { driversRoutes } from "./modules/delivery/driver.routes.js";
import { deliveriesRoutes } from "./modules/delivery/delivery.routes.js";
import { driverSelfRoutes } from "./modules/delivery/driver-self.routes.js";

export function createApp() {
  const app = express();

  app.use(cors({ origin: env.publicWebUrl }));
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", rateLimit(300, 60_000));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.use("/api/auth", authRoutes);
  app.use("/api/categories", categoriesRoutes);
  app.use("/api/products", productsRoutes);
  app.use("/api/addon-groups", addonsRoutes);
  app.use("/api/orders", ordersRoutes);
  app.use("/api/customers", customersRoutes);
  app.use("/api/coupons", couponsRoutes);
  app.use("/api/dashboard", dashboardRoutes);
  app.use("/api/reviews", reviewsRoutes);
  app.use("/api/stock", stockRoutes);
  app.use("/api/finance", financeRoutes);
  app.use("/api/settings", settingsRoutes);
  app.use("/api/public", publicRoutes);
  app.use("/api/whatsapp", whatsappRoutes);
  app.use("/api/payments", paymentsRoutes);
  app.use("/api/uploads", uploadsRoutes);
  app.use("/api/tables", tablesRoutes);
  app.use("/api/loyalty", loyaltyRoutes);
  app.use("/api/drivers", driversRoutes);
  app.use("/api/deliveries", deliveriesRoutes);
  app.use("/api/driver", driverSelfRoutes);

  app.use(errorHandler);
  return app;
}
