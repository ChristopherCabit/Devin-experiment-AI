import { LlmClient } from "../llm/client.js";
import { SpendMeter } from "../llm/spend.js";
import { WorldStore } from "../world/store.js";
import { buildApp } from "./app.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const store = new WorldStore(process.env.DB_PATH ?? "/data/game.db");
const meter = new SpendMeter(store, Number(process.env.MONTHLY_CAP_USD ?? "14"));
const llm = new LlmClient({ apiKey: required("OPENROUTER_API_KEY"), meter });
const app = await buildApp({
  store,
  meter,
  llm,
  origin: required("APP_ORIGIN"),
  setupCode: required("APP_SETUP_CODE"),
  accessLog: (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`),
});
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? "8080") });
process.stdout.write("listening\n");
