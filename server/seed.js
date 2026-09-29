import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, getPool } from "./db.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const products = JSON.parse(await readFile(path.join(root, "data", "products.json"), "utf8"));
const pool = getPool();

if (!pool) {
  console.error("DATABASE_URL is required to seed PostgreSQL. Configure it in .env.");
  process.exitCode = 1;
} else {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const categories = new Map();
    for (const product of products) {
      const categoryName = product.category === "accessories" ? "Accessories" : "Apparel";
      const categorySlug = product.category === "accessories" ? "accessories" : "apparel";
      if (!categories.has(categorySlug)) {
        const category = await client.query(
          `INSERT INTO categories (id, name, slug) VALUES ($1, $2, $3)
           ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [randomUUID(), categoryName, categorySlug]
        );
        categories.set(categorySlug, category.rows[0].id);
      }

      await client.query(
        `INSERT INTO products (id, category_id, name, slug, base_price, active)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         ON CONFLICT (slug) DO UPDATE
         SET category_id = EXCLUDED.category_id, name = EXCLUDED.name,
             base_price = EXCLUDED.base_price, active = TRUE`,
        [randomUUID(), categories.get(categorySlug), product.name, product.id, product.basePrice]
      );
      const productResult = await client.query("SELECT id FROM products WHERE slug = $1", [product.id]);
      for (const size of product.sizes) {
        for (const color of product.colors) {
          const adjustment = size === "XXL" ? 50 : size === "3XL" ? 80 : 0;
          await client.query(
            `INSERT INTO product_variants (id, product_id, size, color, price_adjustment, active)
             VALUES ($1, $2, $3, $4, $5, TRUE)
             ON CONFLICT (product_id, size, color) DO UPDATE
             SET price_adjustment = EXCLUDED.price_adjustment, active = TRUE`,
            [randomUUID(), productResult.rows[0].id, size, color, adjustment]
          );
        }
      }
    }
    await client.query("COMMIT");
    console.log(`Seeded ${products.length} products and their variants.`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`Catalog seed failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await closeDatabase();
  }
}
