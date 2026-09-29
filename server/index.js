import { createServer } from "node:http";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { checkDatabase } from "./db.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const products = JSON.parse(await readFile(path.join(root, "data", "products.json"), "utf8"));
const ordersPath = path.join(root, "data", "orders.json");
const usersPath = path.join(root, "data", "users.json");
const sessions = new Map();
const productById = new Map(products.map((product) => [product.id, product]));
const sizeSurcharges = { XXL: 50, "3XL": 80 };
const printSurcharge = 100;
const deliveryFee = 100;
const expressSurcharge = 100;

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "null",
    "access-control-allow-credentials": "true"
  });
  response.end(JSON.stringify(body));
}

async function readCollection(filePath) {
  try {
    const data = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function saveCollection(filePath, records) {
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(records, null, 2), "utf8");
  await rename(temporaryPath, filePath);
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored).split(":");
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requestCookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").filter(Boolean).map((part) => {
    const [key, ...value] = part.trim().split("=");
    return [key, decodeURIComponent(value.join("="))];
  }));
}

async function currentUser(request) {
  const token = requestCookies(request).hps_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  const users = await readCollection(usersPath);
  return users.find((user) => user.id === session.userId) || null;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

async function saveOrder(order) {
  let orders = [];
  try {
    orders = JSON.parse(await readFile(ordersPath, "utf8"));
    if (!Array.isArray(orders)) orders = [];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  orders.push(order);
  const temporaryPath = `${ordersPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(orders, null, 2), "utf8");
  await rename(temporaryPath, ordersPath);
}

function quoteCart(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { error: "Cart must contain at least one item." };
  }
  const normalized = [];
  for (const item of items) {
    const product = productById.get(item.productId);
    const quantity = Number(item.quantity);
    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      return { error: "Each cart item must contain a valid product and quantity." };
    }
    if (!product.sizes.includes(item.size) || !product.colors.includes(item.color)) {
      return { error: `Invalid variant for ${product.name}.` };
    }
    const sides = Array.isArray(item.printSides) ? [...new Set(item.printSides)] : [];
    if (sides.some((side) => !product.printSides.includes(side))) {
      return { error: `Invalid print side for ${product.name}.` };
    }
    const unitPrice = product.basePrice
      + (sizeSurcharges[item.size] || 0)
      + sides.length * printSurcharge
      + (item.express ? expressSurcharge : 0);
    normalized.push({ productId: product.id, name: product.name, quantity, unitPrice, lineTotal: unitPrice * quantity });
  }

  const subtotal = normalized.reduce((total, item) => total + item.lineTotal, 0);
  return { items: normalized, subtotal, deliveryFee, total: subtotal + deliveryFee };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (request.method === "OPTIONS") {
    response.writeHead(204, { "access-control-allow-origin": "null", "access-control-allow-credentials": "true", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" });
    response.end();
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/auth/register") {
    const body = await readJson(request);
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
      sendJson(response, 400, { error: "Use a valid email and a password of at least 8 characters." });
      return;
    }
    const users = await readCollection(usersPath);
    if (users.some((user) => user.email === email)) {
      sendJson(response, 409, { error: "An account with this email already exists." });
      return;
    }
    const user = { id: `USR-${randomBytes(8).toString("hex")}`, email, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
    users.push(user);
    await saveCollection(usersPath, users);
    sendJson(response, 201, { user: { id: user.id, email: user.email } });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(request);
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const users = await readCollection(usersPath);
    const user = users.find((candidate) => candidate.email === email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      sendJson(response, 401, { error: "Invalid email or password." });
      return;
    }
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7 });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "set-cookie": `hps_session=${token}; HttpOnly; SameSite=Lax; Max-Age=604800`, "access-control-allow-origin": "null", "access-control-allow-credentials": "true" });
    response.end(JSON.stringify({ user: { id: user.id, email: user.email } }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = requestCookies(request).hps_session;
    if (token) sessions.delete(token);
    response.writeHead(204, { "set-cookie": "hps_session=; HttpOnly; SameSite=Lax; Max-Age=0", "access-control-allow-origin": "null", "access-control-allow-credentials": "true" });
    response.end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    const user = await currentUser(request);
    sendJson(response, 200, { user: user ? { id: user.id, email: user.email } : null });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/orders") {
    const user = await currentUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Sign in to view your orders." });
      return;
    }
    const orders = await readCollection(ordersPath);
    sendJson(response, 200, { orders: orders.filter((order) => order.userId === user.id).map(({ id, status, paymentMethod, total, createdAt, items }) => ({ id, status, paymentMethod, total, createdAt, items })) });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    let database = { configured: false, connected: false };
    try {
      database = await checkDatabase();
    } catch (error) {
      database = { configured: true, connected: false, error: error.message };
    }
    sendJson(response, 200, { status: "ok", service: "hps-api", version: "0.1.0", storage: database.configured ? "postgresql" : "json-development", database });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/products") {
    sendJson(response, 200, { data: products });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/cart/quote") {
    const body = await readJson(request);
    if (body === null) {
      sendJson(response, 400, { error: "Request body must be valid JSON." });
      return;
    }
    const result = quoteCart(body.items);
    sendJson(response, result.error ? 400 : 200, result);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/orders") {
    const body = await readJson(request);
    if (body === null) {
      sendJson(response, 400, { error: "Request body must be valid JSON." });
      return;
    }
    const quote = quoteCart(body.items);
    const phone = typeof body.customer?.phone === "string" ? body.customer.phone.replace(/[\s-]/g, "") : "";
    if (quote.error || typeof body.customer?.name !== "string" || !body.customer.name.trim() || !/^(?:\+8801|01)\d{9}$/.test(phone) || typeof body.customer.address !== "string" || !body.customer.address.trim()) {
      sendJson(response, 400, { error: quote.error || "Customer name, valid Bangladesh phone and address are required." });
      return;
    }
    const user = await currentUser(request);
    const order = {
      id: `HPS-${Date.now().toString(36).toUpperCase()}`,
      status: "pending",
      paymentMethod: body.paymentMethod === "bKash" || body.paymentMethod === "Nagad" || body.paymentMethod === "Card" ? body.paymentMethod : "Cash on Delivery",
      customer: { name: body.customer.name.trim(), phone, address: body.customer.address.trim() },
      userId: user?.id || null,
      items: quote.items,
      subtotal: quote.subtotal,
      deliveryFee: quote.deliveryFee,
      total: quote.total,
      createdAt: new Date().toISOString()
    };
    await saveOrder(order);
    sendJson(response, 201, { order: { id: order.id, status: order.status, total: order.total, paymentMethod: order.paymentMethod } });
    return;
  }
  sendJson(response, 404, { error: "Route not found." });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, "127.0.0.1", () => {
  console.log(`HPS API listening on http://127.0.0.1:${port}`);
});
