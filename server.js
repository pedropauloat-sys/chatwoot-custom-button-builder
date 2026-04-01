require('dotenv').config();
const http = require('http');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ═══════════════════════════════════════════════════════════
// DATABASE INIT
// ═══════════════════════════════════════════════════════════
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brk_buttons (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      icon TEXT DEFAULT '🔘',
      description TEXT DEFAULT '',
      action_type TEXT DEFAULT 'webhook',
      action_url TEXT DEFAULT '',
      http_method TEXT DEFAULT 'POST',
      color TEXT DEFAULT '#1f93ff',
      modal_html TEXT DEFAULT '',
      new_tab BOOLEAN DEFAULT true,
      active BOOLEAN DEFAULT true,
      dynamic BOOLEAN DEFAULT false,
      single_use BOOLEAN DEFAULT false,
      visible_to TEXT[] DEFAULT '{}',
      conditions JSONB DEFAULT '[]',
      sort_order INTEGER DEFAULT 0,
      group_name TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS brk_button_groups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS brk_button_clicks (
      id SERIAL PRIMARY KEY,
      button_id TEXT NOT NULL,
      user_email TEXT DEFAULT '',
      clicked_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('[DB] Tables ready');
}

// ═══════════════════════════════════════════════════════════
// CORS + JSON HELPERS
// ═══════════════════════════════════════════════════════════
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}
function json(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════
// STATIC FILES
// ═══════════════════════════════════════════════════════════
const MIME = { '.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml' };

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const full = path.join(__dirname, 'public', filePath);
  if (!fs.existsSync(full)) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
  fs.createReadStream(full).pipe(res);
}

// ═══════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════
async function handleAPI(req, res, url, method) {
  cors(res);
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Bloqueio de Segurança: Apenas botões ativos e cliques são públicos. O painel requer ADMIN_TOKEN.
  const isPublicRoute = (url === '/api/buttons/active' && method === 'GET') || 
                        (url === '/api/analytics/click' && method === 'POST');

  if (!isPublicRoute) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    // Se o ADMIN_TOKEN não estiver configurado no .env, libera o acesso (fallback inseguro)
    // Recomendável configurar ADMIN_TOKEN o mais rápido possível
    if (process.env.ADMIN_TOKEN && token !== process.env.ADMIN_TOKEN) {
      return json(res, { error: 'Unauthorized' }, 401);
    }
  }

  // GET /api/buttons — lista todos os botões
  if (url === '/api/buttons' && method === 'GET') {
    const { rows } = await pool.query('SELECT * FROM brk_buttons ORDER BY sort_order ASC, created_at ASC');
    return json(res, { data: rows });
  }

  // POST /api/buttons — cria botão
  if (url === '/api/buttons' && method === 'POST') {
    const b = await parseBody(req);
    const id = b.id || 'btn_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
    await pool.query(`
      INSERT INTO brk_buttons (id,label,icon,description,action_type,action_url,http_method,color,modal_html,new_tab,active,dynamic,single_use,visible_to,conditions,sort_order,group_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    `, [id, b.label||'', b.icon||'🔘', b.description||'', b.action_type||'webhook', b.action_url||'', b.http_method||'POST', b.color||'#1f93ff', b.modal_html||'', b.new_tab!==false, b.active!==false, !!b.dynamic, !!b.single_use, b.visible_to||[], JSON.stringify(b.conditions||[]), b.sort_order||0, b.group_name||'']);
    return json(res, { id, success: true }, 201);
  }

  // PUT /api/buttons/:id — atualiza botão
  const putMatch = url.match(/^\/api\/buttons\/(.+)$/);
  if (putMatch && method === 'PUT') {
    const b = await parseBody(req);
    await pool.query(`
      UPDATE brk_buttons SET label=$1,icon=$2,description=$3,action_type=$4,action_url=$5,http_method=$6,color=$7,modal_html=$8,new_tab=$9,active=$10,dynamic=$11,single_use=$12,visible_to=$13,conditions=$14,sort_order=$15,group_name=$16,updated_at=NOW()
      WHERE id=$17
    `, [b.label||'', b.icon||'🔘', b.description||'', b.action_type||'webhook', b.action_url||'', b.http_method||'POST', b.color||'#1f93ff', b.modal_html||'', b.new_tab!==false, b.active!==false, !!b.dynamic, !!b.single_use, b.visible_to||[], JSON.stringify(b.conditions||[]), b.sort_order||0, b.group_name||'', putMatch[1]]);
    return json(res, { success: true });
  }

  // DELETE /api/buttons/:id
  const delMatch = url.match(/^\/api\/buttons\/(.+)$/);
  if (delMatch && method === 'DELETE') {
    await pool.query('DELETE FROM brk_buttons WHERE id=$1', [delMatch[1]]);
    return json(res, { success: true });
  }

  // GET /api/buttons/active — botões ativos (para o widget)
  if (url === '/api/buttons/active' && method === 'GET') {
    const { rows } = await pool.query('SELECT id,label,icon,description,action_type,action_url,http_method,color,modal_html,new_tab,dynamic,single_use,visible_to,conditions,group_name FROM brk_buttons WHERE active=true ORDER BY sort_order ASC');
    return json(res, { data: rows });
  }

  // POST /api/buttons/reorder — reordena
  if (url === '/api/buttons/reorder' && method === 'POST') {
    const { order } = await parseBody(req);
    if (Array.isArray(order)) {
      for (let i = 0; i < order.length; i++) {
        await pool.query('UPDATE brk_buttons SET sort_order=$1 WHERE id=$2', [i, order[i]]);
      }
    }
    return json(res, { success: true });
  }

  // GET /api/groups
  if (url === '/api/groups' && method === 'GET') {
    const { rows } = await pool.query('SELECT * FROM brk_button_groups ORDER BY sort_order ASC');
    return json(res, { data: rows });
  }

  // POST /api/groups
  if (url === '/api/groups' && method === 'POST') {
    const { name } = await parseBody(req);
    await pool.query('INSERT INTO brk_button_groups (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
    return json(res, { success: true });
  }

  // POST /api/analytics/click
  if (url === '/api/analytics/click' && method === 'POST') {
    const { button_id, user_email } = await parseBody(req);
    if (!button_id) return json(res, { error: 'Missing button_id' }, 400);
    pool.query('INSERT INTO brk_button_clicks (button_id, user_email) VALUES ($1, $2)', [button_id, user_email || '']).catch(console.error);
    return json(res, { success: true });
  }

  // GET /api/analytics/stats
  if (url === '/api/analytics/stats' && method === 'GET') {
    try {
      const totalAll = await pool.query('SELECT COUNT(*) FROM brk_button_clicks');
      const totalMonth = await pool.query("SELECT COUNT(*) FROM brk_button_clicks WHERE clicked_at >= date_trunc('month', CURRENT_DATE)");
      const totalToday = await pool.query('SELECT COUNT(*) FROM brk_button_clicks WHERE clicked_at >= CURRENT_DATE');
      
      const topButtons = await pool.query(`
        SELECT c.button_id, b.label, b.icon, COUNT(*) as clicks
        FROM brk_button_clicks c
        LEFT JOIN brk_buttons b ON c.button_id = b.id
        GROUP BY c.button_id, b.label, b.icon
        ORDER BY clicks DESC LIMIT 10
      `);

      const topUsers = await pool.query(`
        SELECT user_email, COUNT(*) as clicks
        FROM brk_button_clicks
        WHERE user_email != ''
        GROUP BY user_email
        ORDER BY clicks DESC LIMIT 10
      `);

      return json(res, {
        totals: {
          all: parseInt(totalAll.rows[0].count),
          month: parseInt(totalMonth.rows[0].count),
          today: parseInt(totalToday.rows[0].count)
        },
        buttons: topButtons.rows,
        users: topUsers.rows
      });
    } catch (err) {
      console.error(err);
      return json(res, { error: 'Failed' }, 500);
    }
  }

  // GET /widget.js — script que injeta botões no Chatwoot
  if (url === '/widget.js' && method === 'GET') {
    const widgetPath = path.join(__dirname, 'public', 'widget.js');
    if (fs.existsSync(widgetPath)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
      fs.createReadStream(widgetPath).pipe(res);
      return;
    }
  }

  json(res, { error: 'Not found' }, 404);
}

// ═══════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const method = req.method;

  try {
    if (url.startsWith('/api/') || url === '/widget.js') {
      await handleAPI(req, res, url, method);
    } else if (url === '/' || url === '/index.html') {
      serveStatic(res, 'index.html');
    } else {
      serveStatic(res, url);
    }
  } catch (err) {
    console.error('[ERROR]', err);
    json(res, { error: err.message }, 500);
  }
});

initDB().then(() => {
  server.listen(PORT, () => console.log(`[BRK Buttons] Running on port ${PORT}`));
}).catch(err => {
  console.error('[DB ERROR]', err);
  process.exit(1);
});
