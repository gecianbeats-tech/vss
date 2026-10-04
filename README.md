# VSS Student Portal — PostgreSQL Edition

Full-stack starter for the independent VSS student community, based on the supplied VSS website. Node.js 20+, Express, managed PostgreSQL, JWT admin authentication, bcrypt password verification, and vanilla HTML/CSS/JavaScript.

## Included

- Original VSS homepage at `/`.
- Public portal at `/portal.html`: departments, published member profiles, notices and events.
- Admin console at `/admin.html`: dashboard, CRUD for departments/profiles/notices/events, membership review and helpdesk status updates.
- Public forms: `POST /api/membership`, `POST /api/helpdesk`.
- PostgreSQL database schema initialized on startup; VSS departments seeded automatically.
- Public endpoints only expose published profiles, notices and events.
- Optional one-time SQLite-to-PostgreSQL import script for an existing local database.

## Run locally

1. Install Node.js 20+.
2. Create a PostgreSQL database (local or managed).
3. Copy `.env.example` to `.env` and set `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, and a unique random `JWT_SECRET` (32+ characters).
4. Generate a bcrypt password hash:
   ```bash
   node -e "require('bcryptjs').hash('USE-A-LONG-UNIQUE-PASSWORD',12).then(console.log)"
   ```
5. Install and run:
   ```bash
   npm install
   npm run check
   npm start
   ```
6. Visit `http://localhost:3000`, `/portal.html`, and `/admin.html`.

`DATABASE_URL` should be the provider's PostgreSQL connection string. Use SSL for hosted databases. Keep `.env` private and never commit secrets.

## Free-tier deployment outline

A common pattern is a free-tier Node web service (for example, Render) connected to a managed PostgreSQL database (for example, Neon or Supabase). Free plans, quotas, sleeping behavior, connection limits, backup options, and terms change; check current provider details before selecting a plan. This project is provider-neutral and is not deployed automatically by this package.

For a Render-style Node service:
- Build command: `npm install`
- Start command: `npm start`
- Runtime: Node 20 or newer
- Add environment variables from `.env.example` in the host dashboard. Do not upload `.env`.
- Set `NODE_ENV=production`, `DATABASE_URL`, `PGSSL=require`, `JWT_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD_HASH`.
- Use a pooled PostgreSQL URL if the provider recommends one for serverless/free web services; confirm pool/connection limits.
- After deploy, check `/api/health`, then sign in at `/admin.html`.

A managed database is separate from the web host. Confirm its persistence, backup/export options and free-tier limits; do not assume free-tier services provide production-grade backups or uptime guarantees.

## Import data from an existing SQLite database

Only if you have an old SQLite database with records to preserve:

1. Make a backup of the `.sqlite` file.
2. Set `SQLITE_PATH` to its path and `DATABASE_URL` to the target PostgreSQL database.
3. Install the optional SQLite driver if it is not installed: `npm install --save-dev better-sqlite3@^11.8.1`.
4. Run `npm run migrate:sqlite`.
5. Check counts and sample records in PostgreSQL before using the new database. The importer skips duplicate IDs; run it against a fresh/empty target for the cleanest migration.

The importer does not delete or modify the source SQLite file. It imports the six application tables and preserves their IDs where possible.

## API overview

Public: `GET /api/health`, `POST /api/membership`, `POST /api/helpdesk`, `GET /api/departments`, `GET /api/profiles`, `GET /api/notices`, `GET /api/events`.

Admin (send `Authorization: Bearer <token>`): `POST /api/admin/login`, `GET /api/admin/overview`; memberships/helpdesk listing and status updates; CRUD routes for departments, profiles, notices and events. Full route list remains compatible with the portal frontend.

## Before launch

- Use unique production secrets and a strong admin password; rotate credentials if they were ever shared.
- Confirm TLS, database backup/restore, retention and provider limits.
- Only publish profiles/contact details with the member's consent.
- Consider separate admin accounts/roles, audit logs, CAPTCHA, email notifications, and automated backups before handling real student data.
- VSS is an independent student community; this website does not imply affiliation with government officials or any authority.

## Current limitations

No public member self-service account/login, file uploads, email/WhatsApp notifications, audit trail, password reset, or live deployment is included. Admin-created profiles remain separate from membership applications; an administrator should review an application before creating/publishing a profile.
