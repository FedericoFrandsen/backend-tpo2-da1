import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { config } from "./config";

export function createDatabase(path = config.databasePath) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const client = new Database(path, { create: true });
  const db = drizzle({ client });
  db.run(sql`PRAGMA foreign_keys = ON`);
  migrate(db, { migrationsFolder: resolve("drizzle") });
  return db;
}

export type AppDatabase = ReturnType<typeof createDatabase>;
