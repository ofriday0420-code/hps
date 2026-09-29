import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, getPool } from "./db.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = await readFile(path.join(root, "database", "001_initial_schema.sql"), "utf8");
const pool = getPool();

if (!pool) {
  console.error("DATABASE_URL is required to run migrations. Copy .env.example and configure PostgreSQL.");
  process.exitCode = 1;
} else {
  try {
    await pool.query("BEGIN");
    await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    const applied = await pool.query("SELECT version FROM schema_migrations WHERE version = $1", ["001_initial_schema"]);
    if (applied.rowCount === 0) {
      await pool.query(migration);
      await pool.query("INSERT INTO schema_migrations (version) VALUES ($1)", ["001_initial_schema"]);
      console.log("Applied migration 001_initial_schema.");
    } else {
      console.log("Migration 001_initial_schema is already applied.");
    }
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
