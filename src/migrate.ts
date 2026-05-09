import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { config } from "./config.ts";
import * as schema from "./db/schema.ts";

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.database.url,
});

const migrationsFolder = process.env.MIGRATIONS_DIR ?? "./drizzle";

try {
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder });
  console.log("Database migrations completed.");
} finally {
  await pool.end();
}
