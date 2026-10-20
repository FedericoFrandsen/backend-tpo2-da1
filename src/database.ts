import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { config } from "./config";

export function createDatabase(path = config.databasePath) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const client = new Database(path, { create: true });
  client.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") client.exec("PRAGMA journal_mode = WAL;");
  const db = drizzle({ client });
  try {
    migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  } catch (error) {
    client.close();
    throw error;
  }
  return db;
}

export type AppDatabase = ReturnType<typeof createDatabase>;
export type Store = Pick<AppDatabase, "select" | "insert" | "update" | "delete">;
