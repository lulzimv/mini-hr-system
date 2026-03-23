const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const db = new sqlite3.Database('/app/hr.db');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set('trust proxy', 1);

app.use(session({
  name: 'minihr.sid',
  secret: 'minihr-super-secret-change-this',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    path: '/',
    maxAge: 1000 * 60 * 60 * 8
  }
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function auth(req, res, next) {
  if (!req.session.user) {
    if (req.originalUrl.startsWith('/api/')) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return res.redirect('/login.html');
  }
  next();
}

function adminOnly(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

function calculateDays(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  if (isNaN(s) || isNaN(e) || e < s) return 0;
  return Math.floor((e - s) / (1000 * 60 * 60 * 24)) + 1;
}

const payslipStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = '/app/uploads/payslips';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '_' + safeName);
  }
});

const upload = multer({
  storage: payslipStorage,
  limits: { fileSize: 5 * 1024 * 1024 }
});

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

  db.run(`
    CREATE TABLE IF NOT EXISTS payslips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      file_name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.get(`SELECT * FROM users WHERE username='admin'`, (err, row) => {
    if (!row) {
      db.run(
        `INSERT INTO users (username, password_hash, role, annual_leave)
         VALUES ('admin', ?, 'admin', 25)`,
        [hashPassword('admin123')]
      );
      console.log('Admin bootstrap user created');
    }
  });
});

app.get('/', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login.html');
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
      if (err) return res.status(500).json({ error: 'db error' });
      if (!user) return res.status(401).json({ error: 'login failed' });

      req.session.user = user;
      req.session.save((e) => {
        if (e) return res.status(500).json({ error: 'session error' });
        return res.json({ success: true });
      });
    }
  );
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login.html'));
});

app.get('/api/me', auth, (req, res) => {
  db.get(
    `SELECT annual_leave FROM users WHERE username = ?`,
    [req.session.user.username],
    (err, row) => {
      res.json({
        username: req.session.user.username,
        role: req.session.user.role,
        annual_leave: row ? row.annual_leave : req.session.user.annual_leave
      });
    }
  );
});

app.get('/api/stats', auth, (req, res) => {
  db.get(
    `SELECT annual_leave FROM users WHERE username = ?`,
    [req.session.user.username],
    (err, row) => {
      const annual = row ? row.annual_leave : 0;

      db.get(
        `SELECT COALESCE(SUM(days),0) AS approved_days
         FROM leaves
         WHERE username = ? AND status = 'approved'`,
        [req.session.user.username],
        (e2, row2) => {
          const approved = row2 ? row2.approved_days : 0;
          const remaining = annual - approved;
          res.json({
            annual_leave: annual,
            approved_days: approved,
            remaining_leave: remaining
          });
        }
      );
    }
  );
});

app.get('/api/leaves', auth, (req, res) => {
  const sql = req.session.user.role === 'admin'
    ? `SELECT * FROM leaves ORDER BY id DESC`
    : `SELECT * FROM leaves WHERE username = ? ORDER BY id DESC`;

  const params = req.session.user.role === 'admin'
    ? []
    : [req.session.user.username];

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'db error' });
    res.json(rows);
  });
});

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
        `SELECT COALESCE(SUM(days),0) AS approved_days
         FROM leaves
         WHERE username = ? AND status = 'approved'`,
        [req.session.user.username],
        (e2, usedRow) => {
          if (e2) return res.status(500).json({ error: 'Balance lookup failed' });

          const approved = usedRow ? usedRow.approved_days : 0;
          const remaining = userRow.annual_leave - approved;

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
  db.run(
    `UPDATE leaves SET status = 'approved' WHERE id = ?`,
    [req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: 'Update failed' });
      res.json({ status: 'approved' });
    }
  );
});

app.post('/api/leave/:id/reject', auth, adminOnly, (req, res) => {
  db.run(
    `UPDATE leaves SET status = 'rejected' WHERE id = ?`,
    [req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: 'Update failed' });
      res.json({ status: 'rejected' });
    }
  );
});

app.get('/api/users', auth, adminOnly, (req, res) => {
  db.all(
    `SELECT id, username, role, annual_leave FROM users ORDER BY id ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'db error' });
      res.json(rows);
    }
  );
});

app.post('/api/users', auth, adminOnly, (req, res) => {
  const { username, password, role, annual_leave } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  const safeRole = role === 'admin' ? 'admin' : 'employee';
  const leave = parseInt(annual_leave, 10) || 25;

  db.run(
    `INSERT INTO users(username,password_hash,role,annual_leave)
     VALUES(?,?,?,?)`,
    [username, hashPassword(password), safeRole, leave],
    function(err) {
      if (err) return res.status(500).json({ error: 'user insert failed' });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  db.get(`SELECT username FROM users WHERE id = ?`, [req.params.id], (err, row) => {
    if (!row) return res.status(404).json({ error: 'user not found' });
    if (row.username === req.session.user.username) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    db.run(`DELETE FROM users WHERE id = ?`, [req.params.id], function(e2) {
      if (e2) return res.status(500).json({ error: 'delete failed' });
      res.json({ ok: true });
    });
  });
});

app.post('/api/payslips/upload', auth, adminOnly, upload.single('payslip'), (req, res) => {
  const username = req.body.username;

  if (!username) return res.status(400).json({ error: 'username required' });
  if (!req.file) return res.status(400).json({ error: 'file required' });

  db.run(
    `INSERT INTO payslips(username,file_name,original_name)
     VALUES(?,?,?)`,
    [username, req.file.filename, req.file.originalname],
    function(err) {
      if (err) return res.status(500).json({ error: 'upload failed' });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

app.get('/api/payslips', auth, (req, res) => {
  const sql = req.session.user.role === 'admin'
    ? `SELECT * FROM payslips ORDER BY id DESC`
    : `SELECT * FROM payslips WHERE username = ? ORDER BY id DESC`;

  const params = req.session.user.role === 'admin'
    ? []
    : [req.session.user.username];

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'db error' });
    res.json(rows);
  });
});

app.get('/api/payslips/:id/download', auth, (req, res) => {
  db.get(`SELECT * FROM payslips WHERE id = ?`, [req.params.id], (err, row) => {
    if (!row) return res.status(404).send('Not found');

    if (req.session.user.role !== 'admin' && row.username !== req.session.user.username) {
      return res.status(403).send('Forbidden');
    }

    const filePath = path.join(__dirname, 'uploads', 'payslips', row.file_name);
    if (!fs.existsSync(filePath)) return res.status(404).send('File missing');

    return res.download(filePath, row.original_name);
  });
});

app.listen(5050, '0.0.0.0', () => {
  console.log('Mini HR v7 running on port 5050');
});
