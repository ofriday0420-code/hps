import { createHash, randomUUID } from "node:crypto";
import { getPool } from "./db.js";

function database() {
  const pool = getPool();
  if (!pool) throw new Error("PostgreSQL storage is not configured.");
  return pool;
}

function mapUser(row) {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at.toISOString()
  };
}

export async function findUserByEmail(email) {
  const result = await database().query(
    "SELECT id, email, password_hash, created_at FROM users WHERE email = $1",
    [email]
  );
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function createUser(email, passwordHash) {
  const result = await database().query(
    "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email, password_hash, created_at",
    [randomUUID(), email, passwordHash]
  );
  return mapUser(result.rows[0]);
}

function sessionHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(token, userId, expiresAt) {
  await database().query(
    "INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    [sessionHash(token), userId, new Date(expiresAt)]
  );
}

export async function findUserBySession(token) {
  const result = await database().query(
    `SELECT users.id, users.email, users.password_hash, users.created_at
     FROM auth_sessions
     JOIN users ON users.id = auth_sessions.user_id
     WHERE auth_sessions.token_hash = $1 AND auth_sessions.expires_at > NOW()`,
    [sessionHash(token)]
  );
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function deleteSession(token) {
  await database().query("DELETE FROM auth_sessions WHERE token_hash = $1", [sessionHash(token)]);
}

const paymentMethods = {
  "Cash on Delivery": "cod",
  bKash: "bkash",
  Nagad: "nagad",
  Card: "card"
};

const paymentMethodLabels = {
  cod: "Cash on Delivery",
  bkash: "bKash",
  nagad: "Nagad",
  card: "Card"
};

function mapOrderStatus(status) {
  return status === "received" ? "pending" : status;
}

export async function createOrder(order, sourceItems) {
  const pool = database();
  const client = await pool.connect();
  const internalOrderId = randomUUID();
  try {
    await client.query("BEGIN");
    const slugs = [...new Set(order.items.map((item) => item.productId))];
    const productResult = await client.query(
      "SELECT id, slug FROM products WHERE slug = ANY($1::text[]) AND active = TRUE",
      [slugs]
    );
    const productIds = new Map(productResult.rows.map((row) => [row.slug, row.id]));
    if (slugs.some((slug) => !productIds.has(slug))) {
      throw new Error("Order contains a product missing from the PostgreSQL catalog. Run npm run db:seed.");
    }

    await client.query(
      `INSERT INTO orders
        (id, public_id, user_id, status, payment_method, subtotal, delivery_fee, total, customer_snapshot)
       VALUES ($1, $2, $3, 'received', $4, $5, $6, $7, $8::jsonb)`,
      [
        internalOrderId,
        order.id,
        order.userId,
        paymentMethods[order.paymentMethod] || "cod",
        order.subtotal,
        order.deliveryFee,
        order.total,
        JSON.stringify(order.customer)
      ]
    );

    for (let index = 0; index < order.items.length; index += 1) {
      const item = order.items[index];
      const source = sourceItems[index];
      await client.query(
        `INSERT INTO order_items
          (id, order_id, product_id, product_name_snapshot, variant_snapshot, quantity, unit_price, line_total)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [
          randomUUID(),
          internalOrderId,
          productIds.get(item.productId),
          item.name,
          JSON.stringify({
            size: source?.size,
            color: source?.color,
            printSides: source?.printSides ?? [],
            express: Boolean(source?.express)
          }),
          item.quantity,
          item.unitPrice,
          item.lineTotal
        ]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listOrdersForUser(userId) {
  const result = await database().query(
    `SELECT orders.public_id AS id, orders.status, orders.payment_method, orders.total,
            orders.created_at, COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'productId', products.slug,
                  'name', order_items.product_name_snapshot,
                  'quantity', order_items.quantity,
                  'unitPrice', order_items.unit_price,
                  'lineTotal', order_items.line_total,
                  'size', order_items.variant_snapshot->>'size',
                  'color', order_items.variant_snapshot->>'color',
                  'printSides', order_items.variant_snapshot->'printSides',
                  'express', order_items.variant_snapshot->'express'
                )
              ) FILTER (WHERE order_items.id IS NOT NULL),
              '[]'::jsonb
            ) AS items
     FROM orders
     LEFT JOIN order_items ON order_items.order_id = orders.id
     LEFT JOIN products ON products.id = order_items.product_id
     WHERE orders.user_id = $1
     GROUP BY orders.id
     ORDER BY orders.created_at DESC`,
    [userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    status: mapOrderStatus(row.status),
    paymentMethod: paymentMethodLabels[row.payment_method] || row.payment_method,
    total: Number(row.total),
    createdAt: row.created_at.toISOString(),
    items: row.items
  }));
}

function mapDesign(row) {
  return {
    id: row.id,
    productId: row.product_slug,
    name: row.name,
    currentVersion: row.current_version,
    qualityStatus: row.quality_status,
    editorState: row.editor_state,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export async function listDesignsForUser(userId) {
  const result = await database().query(
    `SELECT designs.id, products.slug AS product_slug, designs.name, designs.current_version,
            designs.created_at, designs.updated_at, design_versions.quality_status,
            design_versions.editor_state
     FROM designs
     JOIN products ON products.id = designs.product_id
     LEFT JOIN design_versions
       ON design_versions.design_id = designs.id
      AND design_versions.version = designs.current_version
     WHERE designs.user_id = $1
     ORDER BY designs.updated_at DESC`,
    [userId]
  );
  return result.rows.map(mapDesign);
}

export async function getDesignForUser(userId, designId) {
  const result = await database().query(
    `SELECT designs.id, products.slug AS product_slug, designs.name, designs.current_version,
            designs.created_at, designs.updated_at, design_versions.quality_status,
            design_versions.editor_state
     FROM designs
     JOIN products ON products.id = designs.product_id
     LEFT JOIN design_versions
       ON design_versions.design_id = designs.id
      AND design_versions.version = designs.current_version
     WHERE designs.user_id = $1 AND designs.id = $2`,
    [userId, designId]
  );
  return result.rows[0] ? mapDesign(result.rows[0]) : null;
}

export async function createDesignForUser(userId, { productId, name, editorState, qualityStatus }) {
  const client = await database().connect();
  const designId = randomUUID();
  try {
    await client.query("BEGIN");
    const product = await client.query(
      "SELECT id FROM products WHERE slug = $1 AND active = TRUE",
      [productId]
    );
    if (!product.rows[0]) {
      const error = new Error("Product is not available in the PostgreSQL catalog. Run npm run db:seed.");
      error.code = "PRODUCT_NOT_FOUND";
      throw error;
    }
    await client.query(
      "INSERT INTO designs (id, user_id, product_id, name, current_version) VALUES ($1, $2, $3, $4, 1)",
      [designId, userId, product.rows[0].id, name]
    );
    await client.query(
      `INSERT INTO design_versions (id, design_id, version, editor_state, quality_status)
       VALUES ($1, $2, 1, $3::jsonb, $4)`,
      [randomUUID(), designId, JSON.stringify(editorState), qualityStatus]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return getDesignForUser(userId, designId);
}

export async function createDesignVersionForUser(userId, designId, { name, editorState, qualityStatus }) {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const design = await client.query(
      "SELECT current_version FROM designs WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [designId, userId]
    );
    if (!design.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    const version = design.rows[0].current_version + 1;
    await client.query(
      `INSERT INTO design_versions (id, design_id, version, editor_state, quality_status)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [randomUUID(), designId, version, JSON.stringify(editorState), qualityStatus]
    );
    await client.query(
      "UPDATE designs SET current_version = $1, name = $2, updated_at = NOW() WHERE id = $3",
      [version, name, designId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return getDesignForUser(userId, designId);
}

function mapAddress(row) {
  return {
    id: row.id,
    label: row.label,
    recipientName: row.recipient_name,
    phone: row.phone,
    division: row.division,
    district: row.district,
    area: row.area,
    addressLine: row.address_line,
    createdAt: row.created_at.toISOString()
  };
}

export async function listAddressesForUser(userId) {
  const result = await database().query(
    `SELECT id, label, recipient_name, phone, division, district, area, address_line, created_at
     FROM addresses WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows.map(mapAddress);
}

export async function createAddressForUser(userId, address) {
  const result = await database().query(
    `INSERT INTO addresses
      (id, user_id, label, recipient_name, phone, division, district, area, address_line)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, label, recipient_name, phone, division, district, area, address_line, created_at`,
    [
      randomUUID(),
      userId,
      address.label,
      address.recipientName,
      address.phone,
      address.division,
      address.district,
      address.area,
      address.addressLine
    ]
  );
  return mapAddress(result.rows[0]);
}

export async function updateAddressForUser(userId, addressId, address) {
  const result = await database().query(
    `UPDATE addresses
     SET label = $1, recipient_name = $2, phone = $3, division = $4,
         district = $5, area = $6, address_line = $7
     WHERE id = $8 AND user_id = $9
     RETURNING id, label, recipient_name, phone, division, district, area, address_line, created_at`,
    [
      address.label,
      address.recipientName,
      address.phone,
      address.division,
      address.district,
      address.area,
      address.addressLine,
      addressId,
      userId
    ]
  );
  return result.rows[0] ? mapAddress(result.rows[0]) : null;
}

export async function deleteAddressForUser(userId, addressId) {
  const result = await database().query(
    "DELETE FROM addresses WHERE id = $1 AND user_id = $2 RETURNING id",
    [addressId, userId]
  );
  return result.rowCount > 0;
}
