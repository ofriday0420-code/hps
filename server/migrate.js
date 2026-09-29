import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, getPool } from "./db.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "database");
const migrationFiles = (await readdir(migrationDirectory))
  .filter((file) => /^\d+_[a-z0-9_]+\.sql$/i.test(file))
  .sort();
const pool = getPool();

if (!pool) {
  console.error("DATABASE_URL is required to run migrations. Copy .env.example and configure PostgreSQL.");
  process.exitCode = 1;
} else {
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    for (const file of migrationFiles) {
      const version = path.basename(file, ".sql");
      const applied = await pool.query("SELECT version FROM schema_migrations WHERE version = $1", [version]);
      if (applied.rowCount > 0) {
        console.log(`Migration ${version} is already applied.`);
        continue;
      }
      const migration = await readFile(path.join(migrationDirectory, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(migration);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
        console.log(`Applied migration ${version}.`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  } catch (error) {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
