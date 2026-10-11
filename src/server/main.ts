import { join } from "node:path";
import Database from "better-sqlite3";
import { LlmClient } from "../llm/client.js";
import { SpendMeter } from "../llm/spend.js";
import { buildApp, seedWorld } from "./app.js";
import { SaveManager } from "./saves.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const dataDir = process.env.DATA_DIR ?? "/data";
const mainDb = new Database(join(dataDir, "main.db"));
mainDb.pragma("journal_mode = WAL");
const saves = new SaveManager(mainDb, dataDir, seedWorld);
saves.migrateLegacy(join(dataDir, "game.db"));
const meter = new SpendMeter(mainDb, Number(process.env.MONTHLY_CAP_USD ?? "14"));
const llm = new LlmClient({ apiKey: required("OPENROUTER_API_KEY"), meter });
const app = await buildApp({
  mainDb,
  saves,
  meter,
  llm,
  origin: required("APP_ORIGIN"),
  setupCode: required("APP_SETUP_CODE"),
  accessLog: (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`),
});
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? "8080") });
process.stdout.write("listening\n");
