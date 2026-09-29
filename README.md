# HPS Custom Print & Design

HPS is a custom-printing storefront prototype for Bangladesh. The current application is intentionally kept as a lightweight browser prototype while the production architecture is built in vertical slices.

## Current build

Phase 1 has established the first brand and design-system layer:

- Responsive HPS brand header and navigation
- Accessible skip link and keyboard focus states
- Mobile navigation drawer
- Conversion-focused homepage hero
- Product and design workflow preserved from the original prototype
- Responsive design tokens, cards, buttons and section hierarchy
- Existing Fabric.js customization, cart and order interactions preserved
- Structured product catalog with descriptions, categories and supported colors
- Product search and category/price filters
- Product detail panel connected to the Design Studio
- Live print-quality status with safe-area warnings
- Front/back artwork state with device-local save/load preparation
- Cart persistence across refresh with item quantity controls
- Checkout validation for Bangladesh mobile numbers and required address fields
- Initial Node.js API foundation with product and server-side cart quote endpoints
- Browser cart connected to the server quote endpoint with authoritative-total status
- Checkout orders persisted by the API with backend-generated order IDs
- PostgreSQL migration schema covering commerce, designs, payments, production and delivery
- Environment-based PostgreSQL client and migration command

The implementation reference is [HPS_Custom_Print_Design_Final_Project_Implementation_Plan.pdf](./HPS_Custom_Print_Design_Final_Project_Implementation_Plan.pdf).

## Run locally

Open `index.html` in a modern browser. The current prototype loads Fabric.js from the CDN, so an internet connection is required for the design editor.

To run the initial API foundation:

```bash
npm start
```

The API exposes `GET /api/health`, `GET /api/products`, and `POST /api/cart/quote`. Product prices, variant validation, print surcharges, express fees and delivery fees are calculated by the server.

When PostgreSQL is configured, customer accounts, sessions, orders and order items are stored in PostgreSQL. Without it, users and orders use the JSON development files. Catalog and quote calculation remain based on `data/products.json`.

Authentication endpoints are available at `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, and `GET /api/auth/me`. Passwords are hashed with Node's `scrypt`, and login creates an HttpOnly session cookie. User records are currently stored in `data/users.json` for development only.

`GET /api/orders` requires an authenticated session and returns only orders belonging to that customer. The storefront includes the initial account panel for sign-in, registration and order-history display.

Signed-in customers can also use `GET /api/designs`, `POST /api/designs`, `GET /api/designs/:id`, and `POST /api/designs/:id/versions` to keep design editor state with their account. The Design Studio saves locally first and syncs to the account when signed in; account backups preserve immutable versions and can be loaded on another device. JSON mode stores these designs in the ignored development file `data/designs.json`.

Signed-in address book endpoints are `GET/POST /api/addresses` and `PUT/DELETE /api/addresses/:id`. Checkout can select a saved address, create one, or update the selected address. JSON mode stores these in the ignored development file `data/addresses.json`.

## PostgreSQL setup

1. Copy `.env.example` to `.env` and set `DATABASE_URL`.
2. Install dependencies with `npm install`.
3. Run `npm run db:migrate`.
4. Run `npm run db:seed` to populate products and variants required by order foreign keys.
5. Start the API with `npm start`.

Without `DATABASE_URL`, the API explicitly reports `json-development` storage and continues using the temporary JSON transition layer. Do not commit `.env` or database credentials.

## Planned build sequence

1. Brand and design system
2. Storefront and product data
3. Reusable Design Studio module
4. Persistent cart and checkout
5. Backend, database and authentication
6. Payments, order management and production workflow
7. Security hardening, testing and deployment
