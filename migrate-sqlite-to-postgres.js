/* One-time importer. Usage: SQLITE_PATH=./data/vss.sqlite DATABASE_URL=... npm run migrate:sqlite */
require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const sqlitePath = path.resolve(process.env.SQLITE_PATH || './data/vss.sqlite');
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL before running migration.'); process.exit(1); }
let sqlite;
try { sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true }); }
catch (e) { console.error(`Cannot open SQLite database at ${sqlitePath}: ${e.message}`); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const tables = {
  departments: ['id','name','description','head_name','contact_email','created_at'],
  membership_applications: ['id','name','phone','department','year','interest','note','status','created_at'],
  helpdesk_requests: ['id','name','contact','year','category','message','status','created_at'],
  member_profiles: ['id','name','role','department_id','semester','bio','photo_url','contact_public','published','created_at'],
  notices: ['id','title','body','category','published','pinned','publish_date','created_at'],
  events: ['id','title','description','venue','starts_at','ends_at','status','image_url','published','created_at']
};
const schema = `
CREATE TABLE IF NOT EXISTS departments(id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL UNIQUE,description TEXT NOT NULL DEFAULT '',head_name TEXT NOT NULL DEFAULT '',contact_email TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS membership_applications(id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL,department TEXT NOT NULL,year TEXT NOT NULL,interest TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS helpdesk_requests(id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,contact TEXT NOT NULL,year TEXT NOT NULL,category TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS member_profiles(id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'Member',department_id BIGINT REFERENCES departments(id) ON DELETE SET NULL,semester TEXT NOT NULL DEFAULT '',bio TEXT NOT NULL DEFAULT '',photo_url TEXT NOT NULL DEFAULT '',contact_public TEXT NOT NULL DEFAULT '',published BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS notices(id BIGSERIAL PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,category TEXT NOT NULL DEFAULT 'General',published BOOLEAN NOT NULL DEFAULT TRUE,pinned BOOLEAN NOT NULL DEFAULT FALSE,publish_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS events(id BIGSERIAL PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',venue TEXT NOT NULL DEFAULT '',starts_at TIMESTAMPTZ NOT NULL,ends_at TIMESTAMPTZ,status TEXT NOT NULL DEFAULT 'upcoming',image_url TEXT NOT NULL DEFAULT '',published BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
`;
const boolFields = new Set(['published','pinned']);
(async()=>{
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query(schema);
    for (const [table, cols] of Object.entries(tables)) {
      const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!exists) { console.log(`Skipping absent SQLite table: ${table}`); continue; }
      const rows = sqlite.prepare(`SELECT ${cols.map(c=>`"${c}"`).join(',')} FROM "${table}" ORDER BY id`).all();
      for (const row of rows) {
        const values = cols.map(c => boolFields.has(c) ? Boolean(row[c]) : row[c]);
        const placeholders = cols.map((_,i)=>`$${i+1}`).join(',');
        await client.query(`INSERT INTO "${table}" (${cols.map(c=>`"${c}"`).join(',')}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`, values);
      }
      console.log(`${table}: imported ${rows.length} row(s)`);
      await client.query(`SELECT setval(pg_get_serial_sequence('"${table}"','id'), GREATEST(COALESCE((SELECT MAX(id) FROM "${table}"),1),1), EXISTS(SELECT 1 FROM "${table}"))`);
    }
    await client.query('COMMIT'); console.log('SQLite import completed. Verify records before switching production traffic.');
  } catch (e) { await client.query('ROLLBACK'); console.error('Migration failed; transaction rolled back:',e.message); process.exitCode=1; }
  finally { client.release(); sqlite.close(); await pool.end(); }
})();
