const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');

const app = express();
const db = new sqlite3.Database('/app/hr.db');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'minihr-super-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));
app.use(express.static(path.join(__dirname, 'public')));

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function auth(req, res, next) {
  if (!req.session.user) return res.redirect('/login.html');
  next();
}

function adminOnly(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
}

function calculateDays(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  if (isNaN(s) || isNaN(e) || e < s) return 0;
  const diff = Math.floor((e - s) / (1000 * 60 * 60 * 24)) + 1;
  return diff;
}

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','employee')),
      annual_leave INTEGER NOT NULL DEFAULT 25
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS leaves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      days INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.get(`SELECT COUNT(*) AS count FROM users`, (err, row) => {
    if (err) {
      console.error(err);
      return;
    }
    if (row.count === 0) {
      const stmt = db.prepare(`
        INSERT INTO users (username, password_hash, role, annual_leave)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run('admin', hashPassword('admin123'), 'admin', 25);
      stmt.run('user1', hashPassword('user123'), 'employee', 25);
      stmt.run('user2', hashPassword('user123'), 'employee', 25);
      stmt.finalize();
      console.log('Default users created.');
    }
  });
});

app.get('/api/me', auth, (req, res) => {
  res.json(req.session.user);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const passwordHash = hashPassword(password || '');

  db.get(
    `SELECT id, username, role, annual_leave
     FROM users
     WHERE username = ? AND password_hash = ?`,
    [username, passwordHash],
    (err, user) => {
      if (err) return res.status(500).send('Database error');
      if (!user) return res.status(401).send('Login failed');
      req.session.user = user;
      res.redirect('/');
    }
  );
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login.html'));
});

app.get('/', auth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/balance', auth, (req, res) => {
  db.get(
    `SELECT COALESCE(SUM(days), 0) AS used
     FROM leaves
     WHERE username = ? AND status = 'approved'`,
    [req.session.user.username],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      const used = row.used || 0;
      const annual = req.session.user.annual_leave;
      const remaining = annual - used;
      res.json({ annual, used, remaining });
    }
  );
});

app.get('/api/leaves', auth, (req, res) => {
  const isAdmin = req.session.user.role === 'admin';
  const sql = isAdmin
    ? `SELECT * FROM leaves ORDER BY id DESC`
    : `SELECT * FROM leaves WHERE username = ? ORDER BY id DESC`;
  const params = isAdmin ? [] : [req.session.user.username];

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows);
  });
});

app.get('/api/calendar', auth, (req, res) => {
  const isAdmin = req.session.user.role === 'admin';
  const sql = isAdmin
    ? `SELECT id, username, start_date, end_date, status FROM leaves WHERE status = 'approved'`
    : `SELECT id, username, start_date, end_date, status FROM leaves WHERE username = ? AND status = 'approved'`;
  const params = isAdmin ? [] : [req.session.user.username];

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    const events = rows.map(r => ({
      id: r.id,
      title: `${r.username} (${r.status})`,
      start: r.start_date,
      end: addOneDay(r.end_date)
    }));
    res.json(events);
  });
});

function addOneDay(dateStr) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

app.post('/api/leave', auth, (req, res) => {
  const { start_date, end_date } = req.body;
  const days = calculateDays(start_date, end_date);

  if (!start_date || !end_date || days <= 0) {
    return res.status(400).json({ error: 'Invalid dates' });
  }

  db.get(
    `SELECT annual_leave FROM users WHERE username = ?`,
    [req.session.user.username],
    (err, userRow) => {
      if (err || !userRow) return res.status(500).json({ error: 'User lookup failed' });

      db.get(
        `SELECT COALESCE(SUM(days), 0) AS used
         FROM leaves
         WHERE username = ? AND status = 'approved'`,
        [req.session.user.username],
        (err2, usedRow) => {
          if (err2) return res.status(500).json({ error: 'Balance lookup failed' });

          const used = usedRow.used || 0;
          const remaining = userRow.annual_leave - used;

          if (days > remaining) {
            return res.status(400).json({
              error: `Not enough balance. Requested ${days}, remaining ${remaining}`
            });
          }

          db.run(
            `INSERT INTO leaves (username, start_date, end_date, days, status)
             VALUES (?, ?, ?, ?, 'pending')`,
            [req.session.user.username, start_date, end_date, days],
            function(insertErr) {
              if (insertErr) return res.status(500).json({ error: 'Insert failed' });
              res.json({ status: 'requested', id: this.lastID, days });
            }
          );
        }
      );
    }
  );
});

app.post('/api/leave/:id/approve', auth, adminOnly, (req, res) => {
  db.run(`UPDATE leaves SET status = 'approved' WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'Update failed' });
    res.json({ status: 'approved' });
  });
});

app.post('/api/leave/:id/reject', auth, adminOnly, (req, res) => {
  db.run(`UPDATE leaves SET status = 'rejected' WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'Update failed' });
    res.json({ status: 'rejected' });
  });
});

app.get('/api/users', auth, adminOnly, (req, res) => {
  db.all(
    `SELECT id, username, role, annual_leave FROM users ORDER BY id ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json(rows);
    }
  );
});

app.post('/api/users', auth, adminOnly, (req, res) => {
  const { username, password, annual_leave, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const annual = parseInt(annual_leave, 10) || 25;
  const safeRole = role === 'admin' ? 'admin' : 'employee';

  db.run(
    `INSERT INTO users (username, password_hash, role, annual_leave)
     VALUES (?, ?, ?, ?)`,
    [username, hashPassword(password), safeRole, annual],
    function(err) {
      if (err) return res.status(500).json({ error: 'User insert failed. Maybe username exists.' });
      res.json({ status: 'user added', id: this.lastID });
    }
  );
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  if (parseInt(req.params.id, 10) === req.session.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }

  db.run(`DELETE FROM users WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'Delete failed' });
    res.json({ status: 'user deleted' });
  });
});

app.get('/export.csv', auth, adminOnly, (req, res) => {
  db.all(`SELECT * FROM leaves ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).send('Export failed');

    let csv = 'id,username,start_date,end_date,days,status,created_at\n';
    for (const r of rows) {
      csv += `${r.id},${r.username},${r.start_date},${r.end_date},${r.days},${r.status},${r.created_at}\n`;
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leave-report.csv"');
    res.send(csv);
  });
});

app.listen(5050, '0.0.0.0', () => {
  console.log('Mini HR v3 running on port 5050');
});
