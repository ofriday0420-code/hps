import { createServer } from "node:http";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { checkDatabase, databaseConfigured } from "./db.js";
import {
  createOrder as createPostgresOrder,
  createDesignForUser as createPostgresDesign,
  createDesignVersionForUser as createPostgresDesignVersion,
  createSession as createPostgresSession,
  createUser as createPostgresUser,
  createAddressForUser as createPostgresAddress,
  deleteAddressForUser as deletePostgresAddress,
  deleteSession as deletePostgresSession,
  findUserByEmail,
  findUserBySession,
  getDesignForUser as getPostgresDesign,
  listAddressesForUser as listPostgresAddresses,
  listDesignsForUser as listPostgresDesigns,
  listOrdersForUser,
  updateAddressForUser as updatePostgresAddress
} from "./repositories.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const products = JSON.parse(await readFile(path.join(root, "data", "products.json"), "utf8"));
const ordersPath = path.join(root, "data", "orders.json");
const usersPath = path.join(root, "data", "users.json");
const designsPath = path.join(root, "data", "designs.json");
const addressesPath = path.join(root, "data", "addresses.json");
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
  if (databaseConfigured()) return findUserBySession(token);
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
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16 * 1024 * 1024) {
      const error = new Error("Request body exceeds the 16 MB limit.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
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

function validateDesign(body) {
  const productId = typeof body?.productId === "string" ? body.productId : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const editorState = body?.editorState;
  const qualityStatus = body?.qualityStatus ?? "not_started";
  if (!productById.has(productId)) return { error: "Choose a valid product for this design." };
  if (!name || name.length > 120) return { error: "Design name must be between 1 and 120 characters." };
  if (!editorState || typeof editorState !== "object" || Array.isArray(editorState)) {
    return { error: "Design editorState must be a JSON object." };
  }
  if (Buffer.byteLength(JSON.stringify(editorState), "utf8") > 10 * 1024 * 1024) {
    return { error: "Design editorState exceeds the 10 MB limit." };
  }
  if (!["not_started", "excellent", "good", "low"].includes(qualityStatus)) {
    return { error: "Quality status must be not_started, excellent, good, or low." };
  }
  return { value: { productId, name, editorState, qualityStatus } };
}

async function readLocalDesigns() {
  return readCollection(designsPath);
}

function validateAddress(body) {
  const recipientName = typeof body?.recipientName === "string" ? body.recipientName.trim() : "";
  const phone = typeof body?.phone === "string" ? body.phone.replace(/[\s-]/g, "") : "";
  const addressLine = typeof body?.addressLine === "string" ? body.addressLine.trim() : "";
  const label = typeof body?.label === "string" ? body.label.trim() : "Delivery address";
  const optional = (value) => typeof value === "string" ? value.trim() : "";
  if (!recipientName || recipientName.length > 120) return { error: "Recipient name must be between 1 and 120 characters." };
  if (!/^(?:\+8801|01)\d{9}$/.test(phone)) return { error: "Enter a valid Bangladesh mobile number." };
  if (!addressLine || addressLine.length > 500) return { error: "Address must be between 1 and 500 characters." };
  if (!label || label.length > 60) return { error: "Address label must be between 1 and 60 characters." };
  for (const value of [body?.division, body?.district, body?.area]) {
    if (value !== undefined && typeof value !== "string") return { error: "Address location fields must be text." };
    if (typeof value === "string" && value.trim().length > 120) return { error: "Address location fields must be 120 characters or fewer." };
  }
  return {
    value: {
      label,
      recipientName,
      phone,
      division: optional(body.division) || null,
      district: optional(body.district) || null,
      area: optional(body.area) || null,
      addressLine
    }
  };
}

async function handleRequest(request, response) {
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
    let user;
    if (databaseConfigured()) {
      try {
        user = await createPostgresUser(email, hashPassword(password));
      } catch (error) {
        if (error.code !== "23505") throw error;
        sendJson(response, 409, { error: "An account with this email already exists." });
        return;
      }
    } else {
      const users = await readCollection(usersPath);
      if (users.some((candidate) => candidate.email === email)) {
        sendJson(response, 409, { error: "An account with this email already exists." });
        return;
      }
      user = { id: `USR-${randomBytes(8).toString("hex")}`, email, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
      users.push(user);
      await saveCollection(usersPath, users);
    }
    sendJson(response, 201, { user: { id: user.id, email: user.email } });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(request);
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const users = databaseConfigured() ? null : await readCollection(usersPath);
    const user = databaseConfigured()
      ? await findUserByEmail(email)
      : users.find((candidate) => candidate.email === email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      sendJson(response, 401, { error: "Invalid email or password." });
      return;
    }
    const token = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 7;
    if (databaseConfigured()) await createPostgresSession(token, user.id, expiresAt);
    else sessions.set(token, { userId: user.id, expiresAt });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "set-cookie": `hps_session=${token}; HttpOnly; SameSite=Lax; Max-Age=604800`, "access-control-allow-origin": "null", "access-control-allow-credentials": "true" });
    response.end(JSON.stringify({ user: { id: user.id, email: user.email } }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = requestCookies(request).hps_session;
    if (token) {
      if (databaseConfigured()) await deletePostgresSession(token);
      else sessions.delete(token);
    }
    response.writeHead(204, { "set-cookie": "hps_session=; HttpOnly; SameSite=Lax; Max-Age=0", "access-control-allow-origin": "null", "access-control-allow-credentials": "true" });
    response.end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    const user = await currentUser(request);
    sendJson(response, 200, { user: user ? { id: user.id, email: user.email } : null });
    return;
  }
  if (url.pathname === "/api/addresses" && ["GET", "POST"].includes(request.method)) {
    const user = await currentUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Sign in to access saved addresses." });
      return;
    }
    if (request.method === "GET") {
      const addresses = databaseConfigured()
        ? await listPostgresAddresses(user.id)
        : (await readCollection(addressesPath))
          .filter((address) => address.userId === user.id)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      sendJson(response, 200, { addresses });
      return;
    }
    const body = await readJson(request);
    if (body === null) {
      sendJson(response, 400, { error: "Request body must be valid JSON." });
      return;
    }
    const validated = validateAddress(body);
    if (validated.error) {
      sendJson(response, 400, { error: validated.error });
      return;
    }
    const address = databaseConfigured()
      ? await createPostgresAddress(user.id, validated.value)
      : { id: randomUUID(), userId: user.id, ...validated.value, createdAt: new Date().toISOString() };
    if (!databaseConfigured()) {
      const addresses = await readCollection(addressesPath);
      addresses.push(address);
      await saveCollection(addressesPath, addresses);
    }
    sendJson(response, 201, { address });
    return;
  }
  const addressMatch = url.pathname.match(/^\/api\/addresses\/([0-9a-f-]+)$/i);
  if (addressMatch && ["PUT", "DELETE"].includes(request.method)) {
    const user = await currentUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Sign in to manage saved addresses." });
      return;
    }
    const addressId = addressMatch[1];
    if (request.method === "DELETE") {
      const deleted = databaseConfigured()
        ? await deletePostgresAddress(user.id, addressId)
        : await (async () => {
            const addresses = await readCollection(addressesPath);
            const remaining = addresses.filter((address) => !(address.id === addressId && address.userId === user.id));
            if (remaining.length === addresses.length) return false;
            await saveCollection(addressesPath, remaining);
            return true;
          })();
      sendJson(response, deleted ? 204 : 404, deleted ? undefined : { error: "Address not found." });
      return;
    }
    const body = await readJson(request);
    if (body === null) {
      sendJson(response, 400, { error: "Request body must be valid JSON." });
      return;
    }
    const validated = validateAddress(body);
    if (validated.error) {
      sendJson(response, 400, { error: validated.error });
      return;
    }
    if (databaseConfigured()) {
      const address = await updatePostgresAddress(user.id, addressId, validated.value);
      if (!address) {
        sendJson(response, 404, { error: "Address not found." });
        return;
      }
      sendJson(response, 200, { address });
      return;
    }
    const addresses = await readCollection(addressesPath);
    const index = addresses.findIndex((address) => address.id === addressId && address.userId === user.id);
    if (index < 0) {
      sendJson(response, 404, { error: "Address not found." });
      return;
    }
    addresses[index] = { ...addresses[index], ...validated.value };
    await saveCollection(addressesPath, addresses);
    sendJson(response, 200, { address: addresses[index] });
    return;
  }
  if (url.pathname === "/api/designs" && ["GET", "POST"].includes(request.method)) {
    const user = await currentUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Sign in to access saved designs." });
      return;
    }
    if (request.method === "GET") {
      const designs = databaseConfigured()
        ? await listPostgresDesigns(user.id)
        : (await readLocalDesigns())
          .filter((design) => design.userId === user.id)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      sendJson(response, 200, { designs });
      return;
    }
    const body = await readJson(request);
    if (body === null) {
      sendJson(response, 400, { error: "Request body must be valid JSON." });
      return;
    }
    const validated = validateDesign(body);
    if (validated.error) {
      sendJson(response, 400, { error: validated.error });
      return;
    }
    const design = databaseConfigured()
      ? await createPostgresDesign(user.id, validated.value)
      : (() => {
          const now = new Date().toISOString();
          return {
            id: randomUUID(),
            userId: user.id,
            ...validated.value,
            currentVersion: 1,
            versions: [{ version: 1, editorState: validated.value.editorState, qualityStatus: validated.value.qualityStatus, createdAt: now }],
            createdAt: now,
            updatedAt: now
          };
        })();
    if (!databaseConfigured()) {
      const designs = await readLocalDesigns();
      designs.push(design);
      await saveCollection(designsPath, designs);
    }
    sendJson(response, 201, { design });
    return;
  }
  const designMatch = url.pathname.match(/^\/api\/designs\/([0-9a-f-]+)$/i);
  const designVersionMatch = url.pathname.match(/^\/api\/designs\/([0-9a-f-]+)\/versions$/i);
  if ((designMatch && request.method === "GET") || (designVersionMatch && request.method === "POST")) {
    const user = await currentUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Sign in to access saved designs." });
      return;
    }
    const designId = (designMatch || designVersionMatch)[1];
    if (databaseConfigured()) {
      if (designMatch) {
        const design = await getPostgresDesign(user.id, designId);
        if (!design) {
          sendJson(response, 404, { error: "Design not found." });
          return;
        }
        sendJson(response, 200, { design });
        return;
      }
      const body = await readJson(request);
      if (body === null) {
        sendJson(response, 400, { error: "Request body must be valid JSON." });
        return;
      }
      const existing = await getPostgresDesign(user.id, designId);
      if (!existing) {
        sendJson(response, 404, { error: "Design not found." });
        return;
      }
      const validated = validateDesign({
        ...body,
        productId: existing.productId,
        name: typeof body.name === "string" ? body.name : existing.name
      });
      if (validated.error) {
        sendJson(response, 400, { error: validated.error });
        return;
      }
      const design = await createPostgresDesignVersion(user.id, designId, validated.value);
      if (!design) {
        sendJson(response, 404, { error: "Design not found." });
        return;
      }
      sendJson(response, 201, { design });
      return;
    }
    const designs = await readLocalDesigns();
    const index = designs.findIndex((design) => design.id === designId && design.userId === user.id);
    if (index < 0) {
      sendJson(response, 404, { error: "Design not found." });
      return;
    }
    if (designMatch) {
      sendJson(response, 200, { design: designs[index] });
      return;
    }
    const body = await readJson(request);
    if (body === null) {
      sendJson(response, 400, { error: "Request body must be valid JSON." });
      return;
    }
    const validated = validateDesign({
      ...body,
      productId: designs[index].productId,
      name: typeof body.name === "string" ? body.name : designs[index].name
    });
    if (validated.error) {
      sendJson(response, 400, { error: validated.error });
      return;
    }
    const now = new Date().toISOString();
    const version = designs[index].currentVersion + 1;
    designs[index] = {
      ...designs[index],
      name: typeof body.name === "string" ? body.name.trim() : designs[index].name,
      currentVersion: version,
      qualityStatus: validated.value.qualityStatus,
      editorState: validated.value.editorState,
      versions: [...designs[index].versions, { version, editorState: validated.value.editorState, qualityStatus: validated.value.qualityStatus, createdAt: now }],
      updatedAt: now
    };
    await saveCollection(designsPath, designs);
    sendJson(response, 201, { design: designs[index] });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/orders") {
    const user = await currentUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Sign in to view your orders." });
      return;
    }
    if (databaseConfigured()) {
      sendJson(response, 200, { orders: await listOrdersForUser(user.id) });
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
    if (databaseConfigured()) await createPostgresOrder(order, body.items);
    else await saveOrder(order);
    sendJson(response, 201, { order: { id: order.id, status: order.status, total: order.total, paymentMethod: order.paymentMethod } });
    return;
  }
  sendJson(response, 404, { error: "Route not found." });
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error(`[hps-api] Request failed: ${error.message}`);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : "The server could not complete this request." });
  });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, "127.0.0.1", () => {
  console.log(`HPS API listening on http://127.0.0.1:${port}`);
});
