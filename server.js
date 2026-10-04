require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('Set JWT_SECRET to a random secret of at least 32 characters.'); process.exit(1);
}
if (!process.env.ADMIN_PASSWORD_HASH || !process.env.ADMIN_PASSWORD_HASH.startsWith('$2')) {
  console.error('Set ADMIN_PASSWORD_HASH to a bcrypt password hash.'); process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to your managed PostgreSQL connection string.'); process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : (process.env.NODE_ENV === 'production' || process.env.PGSSL === 'require' ? { rejectUnauthorized: process.env.PGSSL === 'require-ca' } : undefined),
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
pool.on('error', err => console.error('Unexpected PostgreSQL pool error:', err.message));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS membership_applications (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL,
      department TEXT NOT NULL, year TEXT NOT NULL, interest TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS helpdesk_requests (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, contact TEXT NOT NULL,
      year TEXT NOT NULL, category TEXT NOT NULL, message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS departments (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
      head_name TEXT NOT NULL DEFAULT '', contact_email TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS member_profiles (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'Member',
      department_id BIGINT REFERENCES departments(id) ON DELETE SET NULL, semester TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '', photo_url TEXT NOT NULL DEFAULT '', contact_public TEXT NOT NULL DEFAULT '',
      published BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS notices (
      id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General', published BOOLEAN NOT NULL DEFAULT TRUE,
      pinned BOOLEAN NOT NULL DEFAULT FALSE, publish_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      venue TEXT NOT NULL DEFAULT '', starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'upcoming', image_url TEXT NOT NULL DEFAULT '',
      published BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_profiles_published ON member_profiles(published);
    CREATE INDEX IF NOT EXISTS idx_notices_published ON notices(published, pinned);
    CREATE INDEX IF NOT EXISTS idx_events_published ON events(published, starts_at);
  `);
  const departments = [
    ['Administration', 'Coordination, records, internal governance and member support.'],
    ['Media', 'Photography, video, design and community storytelling.'],
    ['Advertisement & Outreach', 'Sponsorship, partnerships, promotions and outreach.'],
    ['Management', 'Event operations, logistics and volunteer coordination.'],
    ['Sports', 'Sports activities, fitness and recreational events.'],
    ['Esports', 'Gaming tournaments, esports operations and fair play.'],
    ['Academic', 'Academic resources, peer learning, notes and student guidance.'],
    ['Cultural', 'Cultural programmes, open mics and creative activities.'],
    ['Welfare & Helpdesk', 'Student support, welfare initiatives and helpdesk coordination.'],
    ['Technical', 'Website, digital tools, registrations and technical support.']
  ];
  for (const [name, description] of departments) {
    await pool.query('INSERT INTO departments(name, description) VALUES($1,$2) ON CONFLICT(name) DO NOTHING', [name, description]);
  }
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

const clean = (v, max = 1000) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const required = (body, keys) => keys.every(k => clean(body[k], k === 'message' || k === 'note' || k === 'body' ? 5000 : 200).length > 0);
const fail = (res, message, status = 400) => res.status(status).json({ ok: false, message });
const asBool = value => value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
const asId = value => /^\d+$/.test(String(value || '')) && Number(value) > 0 ? Number(value) : null;
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1'); res.json({ ok: true, service: 'VSS API', database: 'postgresql' });
}));

app.post('/api/membership', asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!required(b, ['name', 'phone', 'department', 'year', 'interest'])) return fail(res, 'Please complete all required membership fields.');
  const phone = clean(b.phone, 30);
  if (!/^[+()\-\d\s]{8,20}$/.test(phone)) return fail(res, 'Please enter a valid contact number.');
  const { rows } = await pool.query(`INSERT INTO membership_applications(name,phone,department,year,interest,note) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [clean(b.name,120),phone,clean(b.department,100),clean(b.year,50),clean(b.interest,100),clean(b.note,3000)]);
  res.status(201).json({ ok: true, id: rows[0].id, message: 'Membership application received.' });
}));
app.post('/api/helpdesk', asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!required(b, ['name','contact','year','category','message'])) return fail(res, 'Please complete all required helpdesk fields.');
  const { rows } = await pool.query('INSERT INTO helpdesk_requests(name,contact,year,category,message) VALUES($1,$2,$3,$4,$5) RETURNING id', [clean(b.name,120),clean(b.contact,120),clean(b.year,50),clean(b.category,100),clean(b.message,3000)]);
  res.status(201).json({ ok: true, id: rows[0].id, message: 'Helpdesk request received.' });
}));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false });
app.post('/api/admin/login', loginLimiter, asyncRoute(async (req, res) => {
  const email = clean(req.body?.email, 200).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const validEmail = email && email === clean(process.env.ADMIN_EMAIL, 200).toLowerCase();
  const validPassword = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
  if (!validEmail || !validPassword) return fail(res, 'Invalid credentials.', 401);
  const token = jwt.sign({ sub: email, role: 'admin' }, JWT_SECRET, { expiresIn: '2h', issuer: 'vss-api', audience: 'vss-admin' });
  res.json({ ok: true, token, expiresIn: 7200 });
}));
function requireAdmin(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return fail(res, 'Admin authentication required.', 401);
  try { req.admin = jwt.verify(token, JWT_SECRET, { issuer: 'vss-api', audience: 'vss-admin' }); next(); }
  catch { return fail(res, 'Session expired or invalid. Please log in again.', 401); }
}
const admin = fn => [requireAdmin, asyncRoute(fn)];
const limit = req => Math.min(200, Math.max(1, Number(req.query.limit) || 100));

app.get('/api/admin/memberships', ...admin(async (req,res) => { const r=await pool.query('SELECT * FROM membership_applications ORDER BY id DESC LIMIT $1',[limit(req)]); res.json({ok:true,data:r.rows}); }));
app.patch('/api/admin/memberships/:id/status', ...admin(async (req,res) => {
  const id=asId(req.params.id), status=clean(req.body?.status,30); if(!id)return fail(res,'Invalid application ID.');
  if(!['pending','approved','rejected','contacted'].includes(status))return fail(res,'Unsupported status.');
  const r=await pool.query('UPDATE membership_applications SET status=$1 WHERE id=$2',[status,id]); if(!r.rowCount)return fail(res,'Application not found.',404); res.json({ok:true});
}));
app.get('/api/admin/helpdesk', ...admin(async (req,res) => { const r=await pool.query('SELECT * FROM helpdesk_requests ORDER BY id DESC LIMIT $1',[limit(req)]); res.json({ok:true,data:r.rows}); }));
app.patch('/api/admin/helpdesk/:id/status', ...admin(async (req,res) => {
  const id=asId(req.params.id), status=clean(req.body?.status,30); if(!id)return fail(res,'Invalid request ID.');
  if(!['open','in_progress','resolved','closed'].includes(status))return fail(res,'Unsupported status.');
  const r=await pool.query('UPDATE helpdesk_requests SET status=$1 WHERE id=$2',[status,id]); if(!r.rowCount)return fail(res,'Request not found.',404); res.json({ok:true});
}));

app.get('/api/departments', asyncRoute(async (_req,res) => { const r=await pool.query(`SELECT d.*, (SELECT COUNT(*) FROM member_profiles p WHERE p.department_id=d.id AND p.published=TRUE) AS member_count FROM departments d ORDER BY d.name`); res.json({ok:true,data:r.rows}); }));
app.get('/api/profiles', asyncRoute(async (_req,res) => { const r=await pool.query(`SELECT p.id,p.name,p.role,p.semester,p.bio,p.photo_url,p.contact_public,d.name AS department FROM member_profiles p LEFT JOIN departments d ON d.id=p.department_id WHERE p.published=TRUE ORDER BY p.name LIMIT 300`); res.json({ok:true,data:r.rows}); }));
app.get('/api/notices', asyncRoute(async (_req,res) => { const r=await pool.query(`SELECT id,title,body,category,pinned,publish_date,created_at FROM notices WHERE published=TRUE ORDER BY pinned DESC,publish_date DESC,id DESC LIMIT 100`); res.json({ok:true,data:r.rows}); }));
app.get('/api/events', asyncRoute(async (_req,res) => { const r=await pool.query(`SELECT id,title,description,venue,starts_at,ends_at,status,image_url FROM events WHERE published=TRUE ORDER BY starts_at DESC LIMIT 100`); res.json({ok:true,data:r.rows}); }));
app.get('/api/admin/overview', ...admin(async (_req,res) => {
  const r=await pool.query(`SELECT (SELECT COUNT(*) FROM membership_applications) AS applications,(SELECT COUNT(*) FROM membership_applications WHERE status='pending') AS "pendingApplications",(SELECT COUNT(*) FROM helpdesk_requests WHERE status IN ('open','in_progress')) AS "helpdeskOpen",(SELECT COUNT(*) FROM member_profiles) AS profiles,(SELECT COUNT(*) FROM departments) AS departments,(SELECT COUNT(*) FROM notices) AS notices,(SELECT COUNT(*) FROM events) AS events`);
  res.json({ok:true,data:r.rows[0]});
}));

app.get('/api/admin/departments', ...admin(async (_req,res)=>{const r=await pool.query('SELECT * FROM departments ORDER BY name');res.json({ok:true,data:r.rows});}));
app.post('/api/admin/departments', ...admin(async (req,res)=>{const b=req.body||{},name=clean(b.name,100);if(!name)return fail(res,'Department name is required.');try{const r=await pool.query('INSERT INTO departments(name,description,head_name,contact_email) VALUES($1,$2,$3,$4) RETURNING id',[name,clean(b.description,1000),clean(b.head_name,120),clean(b.contact_email,200)]);res.status(201).json({ok:true,id:r.rows[0].id});}catch(e){if(e.code==='23505')return fail(res,'A department with that name already exists.');throw e;}}));
app.patch('/api/admin/departments/:id', ...admin(async (req,res)=>{const id=asId(req.params.id),b=req.body||{},name=clean(b.name,100);if(!id||!name)return fail(res,'Valid department ID and name are required.');try{const r=await pool.query('UPDATE departments SET name=$1,description=$2,head_name=$3,contact_email=$4 WHERE id=$5',[name,clean(b.description,1000),clean(b.head_name,120),clean(b.contact_email,200),id]);if(!r.rowCount)return fail(res,'Department not found.',404);res.json({ok:true});}catch(e){if(e.code==='23505')return fail(res,'A department with that name already exists.');throw e;}}));
app.delete('/api/admin/departments/:id', ...admin(async (req,res)=>{const id=asId(req.params.id);if(!id)return fail(res,'Invalid department ID.');const r=await pool.query('DELETE FROM departments WHERE id=$1',[id]);if(!r.rowCount)return fail(res,'Department not found.',404);res.json({ok:true});}));

app.get('/api/admin/profiles', ...admin(async (_req,res)=>{const r=await pool.query('SELECT p.*,d.name AS department FROM member_profiles p LEFT JOIN departments d ON d.id=p.department_id ORDER BY p.id DESC');res.json({ok:true,data:r.rows});}));
app.post('/api/admin/profiles', ...admin(async (req,res)=>{const b=req.body||{};if(!required(b,['name','role']))return fail(res,'Name and role are required.');const dep=asId(b.department_id);const r=await pool.query('INSERT INTO member_profiles(name,role,department_id,semester,bio,photo_url,contact_public,published) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[clean(b.name,120),clean(b.role,100),dep,clean(b.semester,80),clean(b.bio,1500),clean(b.photo_url,500),clean(b.contact_public,150),asBool(b.published)]);res.status(201).json({ok:true,id:r.rows[0].id});}));
app.patch('/api/admin/profiles/:id', ...admin(async (req,res)=>{const id=asId(req.params.id),b=req.body||{};if(!id||!required(b,['name','role']))return fail(res,'Name and role are required.');const r=await pool.query('UPDATE member_profiles SET name=$1,role=$2,department_id=$3,semester=$4,bio=$5,photo_url=$6,contact_public=$7,published=$8 WHERE id=$9',[clean(b.name,120),clean(b.role,100),asId(b.department_id),clean(b.semester,80),clean(b.bio,1500),clean(b.photo_url,500),clean(b.contact_public,150),asBool(b.published),id]);if(!r.rowCount)return fail(res,'Profile not found.',404);res.json({ok:true});}));
app.delete('/api/admin/profiles/:id', ...admin(async (req,res)=>{const id=asId(req.params.id);if(!id)return fail(res,'Invalid profile ID.');const r=await pool.query('DELETE FROM member_profiles WHERE id=$1',[id]);if(!r.rowCount)return fail(res,'Profile not found.',404);res.json({ok:true});}));

app.get('/api/admin/notices', ...admin(async (_req,res)=>{const r=await pool.query('SELECT * FROM notices ORDER BY id DESC');res.json({ok:true,data:r.rows});}));
app.post('/api/admin/notices', ...admin(async (req,res)=>{const b=req.body||{};if(!required(b,['title','body']))return fail(res,'Notice title and body are required.');const date=clean(b.publish_date,40)||null;const r=await pool.query('INSERT INTO notices(title,body,category,published,pinned,publish_date) VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamptz,NOW())) RETURNING id',[clean(b.title,200),clean(b.body,5000),clean(b.category,100)||'General',b.published===undefined?true:asBool(b.published),asBool(b.pinned),date]);res.status(201).json({ok:true,id:r.rows[0].id});}));
app.patch('/api/admin/notices/:id', ...admin(async (req,res)=>{const id=asId(req.params.id),b=req.body||{};if(!id||!required(b,['title','body']))return fail(res,'Notice title and body are required.');const date=clean(b.publish_date,40)||null;const r=await pool.query('UPDATE notices SET title=$1,body=$2,category=$3,published=$4,pinned=$5,publish_date=COALESCE($6::timestamptz,publish_date) WHERE id=$7',[clean(b.title,200),clean(b.body,5000),clean(b.category,100)||'General',asBool(b.published),asBool(b.pinned),date,id]);if(!r.rowCount)return fail(res,'Notice not found.',404);res.json({ok:true});}));
app.delete('/api/admin/notices/:id', ...admin(async (req,res)=>{const id=asId(req.params.id);if(!id)return fail(res,'Invalid notice ID.');const r=await pool.query('DELETE FROM notices WHERE id=$1',[id]);if(!r.rowCount)return fail(res,'Notice not found.',404);res.json({ok:true});}));

app.get('/api/admin/events', ...admin(async (_req,res)=>{const r=await pool.query('SELECT * FROM events ORDER BY starts_at DESC');res.json({ok:true,data:r.rows});}));
app.post('/api/admin/events', ...admin(async (req,res)=>{const b=req.body||{};if(!required(b,['title','starts_at']))return fail(res,'Event title and start date are required.');const status=clean(b.status,30)||'upcoming';if(!['upcoming','ongoing','completed','cancelled'].includes(status))return fail(res,'Unsupported event status.');const r=await pool.query('INSERT INTO events(title,description,venue,starts_at,ends_at,status,image_url,published) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[clean(b.title,200),clean(b.description,3000),clean(b.venue,250),clean(b.starts_at,40),clean(b.ends_at,40)||null,status,clean(b.image_url,500),b.published===undefined?true:asBool(b.published)]);res.status(201).json({ok:true,id:r.rows[0].id});}));
app.patch('/api/admin/events/:id', ...admin(async (req,res)=>{const id=asId(req.params.id),b=req.body||{};if(!id||!required(b,['title','starts_at']))return fail(res,'Event title and start date are required.');const status=clean(b.status,30)||'upcoming';if(!['upcoming','ongoing','completed','cancelled'].includes(status))return fail(res,'Unsupported event status.');const r=await pool.query('UPDATE events SET title=$1,description=$2,venue=$3,starts_at=$4,ends_at=$5,status=$6,image_url=$7,published=$8 WHERE id=$9',[clean(b.title,200),clean(b.description,3000),clean(b.venue,250),clean(b.starts_at,40),clean(b.ends_at,40)||null,status,clean(b.image_url,500),asBool(b.published),id]);if(!r.rowCount)return fail(res,'Event not found.',404);res.json({ok:true});}));
app.delete('/api/admin/events/:id', ...admin(async (req,res)=>{const id=asId(req.params.id);if(!id)return fail(res,'Invalid event ID.');const r=await pool.query('DELETE FROM events WHERE id=$1',[id]);if(!r.rowCount)return fail(res,'Event not found.',404);res.json({ok:true});}));

app.use('/api', (_req,res)=>res.status(404).json({ok:false,message:'API endpoint not found.'}));
app.use((err,_req,res,_next)=>{console.error(err.message);res.status(500).json({ok:false,message:process.env.NODE_ENV==='production'?'Internal server error.':'Unexpected server error.'});});

initDb().then(() => app.listen(PORT, () => console.log(`VSS API listening on port ${PORT}`))).catch(err => { console.error('Database initialization failed:',err.message); process.exit(1); });
process.on('SIGTERM', async()=>{await pool.end();process.exit(0);});
