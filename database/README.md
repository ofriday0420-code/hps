# HPS database migrations

The initial migration in `001_initial_schema.sql` defines the relational model described in the implementation plan.

It covers:

- Customer and staff identity
- Products, variants and print-area profiles
- Saved designs and immutable design versions
- Persistent carts and addresses
- Orders, payments and order items
- Production jobs and shipments
- Reviews, notifications and audit logs

The current Node API still uses JSON files as a development transition layer. Apply this migration to PostgreSQL before wiring production persistence. Do not place database credentials in source control; use environment or secret management.
