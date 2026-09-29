# HPS database migrations

The migrations define the relational model described in the implementation plan. `001_initial_schema.sql` creates the commerce schema; `002_auth_sessions.sql` adds persistent, hashed authentication sessions.

It covers:

- Customer and staff identity
- Products, variants and print-area profiles
- Saved designs and immutable design versions
- Persistent carts and addresses
- Orders, payments and order items
- Production jobs and shipments
- Reviews, notifications and audit logs

Run `npm run db:migrate` to apply pending migrations. Run `npm run db:seed` to upsert the development product catalog and variants before creating PostgreSQL-backed orders. Do not place database credentials in source control; use environment or secret management.

Authenticated design endpoints persist the editor state as immutable rows in `design_versions`; each save advances `designs.current_version`. Seed the catalog before saving designs because each design references a product.

Authenticated address book endpoints persist delivery destinations in `addresses`. User ownership is enforced by every read, update, and delete query.
