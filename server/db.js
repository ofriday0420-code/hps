import pg from "pg";
import "dotenv/config";

const { Pool } = pg;
let pool;

export function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool() {
  if (!databaseConfigured()) return null;
  pool ||= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : undefined
  });
  return pool;
}

export async function checkDatabase() {
  const database = getPool();
  if (!database) return { configured: false, connected: false };
  const client = await database.connect();
  try {
    await client.query("SELECT 1");
    return { configured: true, connected: true };
  } finally {
    client.release();
  }
}

export async function closeDatabase() {
  if (pool) await pool.end();
}
