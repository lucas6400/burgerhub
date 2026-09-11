import "dotenv/config";
import { createApp } from "./app.js";
import { env } from "./config/env.js";

const app = createApp();

app.listen(env.port, () => {
  console.log(`🍔 BurgerHub API rodando em http://localhost:${env.port}`);
});
