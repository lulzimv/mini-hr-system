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
  secret: 'minihr-super-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 1000 * 60 * 60 * 8
  }
}));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

function hashPassword(p) {
  return crypto.createHash('sha256').update(p).digest('hex');
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

function daysBetween(s, e) {
  return Math.floor((new Date(e) - new Date(s)) / (1000 * 60 * 60 * 24)) + 1;
}

function toNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  return parseFloat(String(val).replace(/,/g, '')) || 0;
}

/* ================= FILE UPLOAD ================= */

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = '/app/uploads/payslips';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "_" + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'));
  }
});

const upload = multer({ storage });

/* ================= DB ================= */

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password_hash TEXT,
      role TEXT,
	  team TEXT DEFAULT 'general',
      annual_leave INTEGER DEFAULT 20,
      sick_leave INTEGER DEFAULT 10,
      salary_bruto REAL DEFAULT 0,
      salary_neto REAL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS leaves(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      start_date TEXT,
      end_date TEXT,
      days INTEGER,
      status TEXT DEFAULT 'pending',
      type TEXT DEFAULT 'annual',
      medical_file TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS payslips(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      file_name TEXT,
      original_name TEXT,
      uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
  CREATE TABLE IF NOT EXISTS holidays(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    title TEXT
  )
`);

/* ===== AUTO INSERT KOSOVO HOLIDAYS ===== */

const kosovoHolidays = [
  '2026-01-01','2026-01-02',
  '2026-02-17',
  '2026-04-09',
  '2026-04-12','2026-04-13',
  '2026-05-01',
  '2026-05-09',
  '2026-06-28',
  '2026-12-25',

  '2027-01-01','2027-01-02',
  '2027-02-17',
  '2027-03-28',
  '2027-05-01',
  '2027-05-09',
  '2027-06-28',
  '2027-12-25'
];

kosovoHolidays.forEach(d=>{
  db.run(
    `INSERT OR IGNORE INTO holidays(date,title) VALUES(?,?)`,
    [d,'Official Holiday']
  );
});

  db.get(`SELECT * FROM users WHERE username='admin'`, (e, row) => {
    if (!row) {
      db.run(
        `INSERT INTO users(username,password_hash,role,annual_leave,sick_leave,salary_bruto,salary_neto)
         VALUES('admin',?,'admin',20,10,0,0)`,
        [hashPassword('admin123')]
      );
    }
  });
});

/* ================= ROOT ================= */

app.get('/', auth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ================= LOGIN ================= */

app.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();

  if (!username || !password) {
    return res.status(401).json({ error: 'login failed' });
  }

  const h = hashPassword(password);

  db.get(
    `SELECT id, username, role, annual_leave
     FROM users
     WHERE username=? AND password_hash=?`,
    [username, h],
    (err, user) => {
      if (err) {
        console.log(err);
        return res.status(500).json({ error: 'db' });
      }

      if (!user) {
        return res.status(401).json({ error: 'login failed' });
      }

      req.session.user = user;
      req.session.save(saveErr => {
        if (saveErr) {
          console.log(saveErr);
          return res.status(500).json({ error: 'session' });
        }
        res.json({ success: true });
      });
    }
  );
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login.html'));
});

/* ================= USER INFO ================= */

app.get('/api/me', auth, (req, res) => {
  db.get(
    `SELECT annual_leave FROM users WHERE id=?`,
    [req.session.user.id],
    (e, row) => {
      res.json({
        id: req.session.user.id,
        username: req.session.user.username,
        role: req.session.user.role,
        annual_leave: row ? row.annual_leave : 0
      });
    }
  );
});

app.get('/api/stats', auth, (req, res) => {
  db.get(
    `SELECT annual_leave FROM users WHERE id=?`,
    [req.session.user.id],
    (e, row) => {
      const annual = row ? row.annual_leave : 0;

      db.get(
        `SELECT COALESCE(SUM(days),0) approved
         FROM leaves
         WHERE user_id=? AND status='approved' AND type='annual'`,
        [req.session.user.id],
        (e2, row2) => {
          const approved = row2 ? row2.approved : 0;
          res.json({
            annual_leave: annual,
            approved_days: approved,
            remaining_leave: annual - approved
          });
        }
      );
    }
  );
});

/* ================= USERS ================= */

app.get('/api/users', auth, adminOnly, (req, res) => {
  db.all(
    `SELECT
       id,
       username,
       role,
       annual_leave,
       sick_leave,
       salary_bruto,
       salary_neto
     FROM users
     ORDER BY id ASC`,
    (e, rows) => {
      if (e) {
        console.log(e);
        return res.status(500).json({ error: 'db' });
      }
      res.json(rows);
    }
  );
});

app.post('/api/users', auth, adminOnly, (req, res) => {
  const {
    username,
    password,
    role,
    annual_leave,
    sick_leave,
    salary_bruto,
    salary_neto
  } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'missing fields' });
  }

  db.run(
    `INSERT INTO users(username,password_hash,role,annual_leave,sick_leave,salary_bruto,salary_neto)
     VALUES(?,?,?,?,?,?,?)`,
    [
      username,
      hashPassword(password),
      role === 'admin' ? 'admin' : 'employee',
      parseInt(annual_leave, 10) || 20,
      parseInt(sick_leave, 10) || 10,
      toNumber(salary_bruto),
      toNumber(salary_neto)
    ],
    function (err) {
      if (err) {
        console.log(err);
        return res.status(500).json({ error: 'db' });
      }
      res.json({ ok: true, id: this.lastID });
    }
  );
});

app.post('/api/users/update', auth, adminOnly, (req, res) => {
  const {
    id,
    username,
    password,
    role,
    annual_leave,
    sick_leave,
    salary_bruto,
    salary_neto
  } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'id missing' });
  }

  if (password && password.trim() !== '') {
    db.run(
      `UPDATE users
       SET username=?, role=?, annual_leave=?, sick_leave=?, salary_bruto=?, salary_neto=?, password_hash=?
       WHERE id=?`,
      [
        username,
        role,
        parseInt(annual_leave, 10) || 0,
        parseInt(sick_leave, 10) || 0,
        toNumber(salary_bruto),
        toNumber(salary_neto),
        hashPassword(password),
        id
      ],
      err => {
        if (err) {
          console.log(err);
          return res.status(500).json({ error: 'db' });
        }
        res.json({ ok: true });
      }
    );
  } else {
    db.run(
      `UPDATE users
       SET username=?, role=?, annual_leave=?, sick_leave=?, salary_bruto=?, salary_neto=?
       WHERE id=?`,
      [
        username,
        role,
        parseInt(annual_leave, 10) || 0,
        parseInt(sick_leave, 10) || 0,
        toNumber(salary_bruto),
        toNumber(salary_neto),
        id
      ],
      err => {
        if (err) {
          console.log(err);
          return res.status(500).json({ error: 'db' });
        }
        res.json({ ok: true });
      }
    );
  }
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  db.get(`SELECT username FROM users WHERE id=?`, [req.params.id], (e, row) => {
    if (!row) return res.status(404).json({ error: 'not found' });
    if (row.username === req.session.user.username) {
      return res.status(400).json({ error: 'cannot delete your own account' });
    }

    db.run(`DELETE FROM users WHERE id=?`, [req.params.id], function (err) {
      if (err) {
        console.log(err);
        return res.status(500).json({ error: 'db' });
      }
      res.json({ ok: true });
    });
  });
});

/* ================= LEAVES ================= */

app.get('/api/leaves', auth, (req, res) => {
  let sql;
  let params = [];

  if (req.session.user.role === 'admin') {
    sql = `
      SELECT leaves.*, users.username
      FROM leaves
      JOIN users ON users.id = leaves.user_id
      ORDER BY leaves.id DESC
    `;
  } else {
    sql = `
      SELECT leaves.*, users.username
      FROM leaves
      JOIN users ON users.id = leaves.user_id
      WHERE leaves.user_id = ? OR leaves.status = 'approved'
      ORDER BY leaves.id DESC
    `;
    params = [req.session.user.id];
  }

  db.all(sql, params, (e, rows) => {
    if (e) {
      console.log(e);
      return res.status(500).json({ error: 'db' });
    }
    res.json(rows);
  });
});

app.post('/api/leave', auth, upload.single('medical'), (req, res) => {
  const { start_date, end_date, type } = req.body;
  const leaveType = type || 'annual';

  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'missing dates' });
  }

  const days = daysBetween(start_date, end_date);
  if (days <= 0) {
    return res.status(400).json({ error: 'invalid range' });
  }

  const status = leaveType === 'sick' ? 'approved' : 'pending';
  const medicalFile = req.file ? req.file.filename : null;

  db.get(
    `
    SELECT COUNT(*) c
    FROM leaves
    WHERE status='approved'
    AND (start_date <= ? AND end_date >= ?)
    `,
    [end_date, start_date],
    (e, row) => {
      if (row && row.c >= 2) {
        return res.status(400).json({ error: 'Too many employees on leave' });
      }

      db.run(
        `
        INSERT INTO leaves(user_id,start_date,end_date,days,status,type,medical_file)
        VALUES(?,?,?,?,?,?,?)
        `,
        [
          req.session.user.id,
          start_date,
          end_date,
          days,
          status,
          leaveType,
          medicalFile
        ],
        err => {
          if (err) {
            console.log(err);
            return res.status(500).json({ error: 'db' });
          }
          res.json({ ok: true });
        }
      );
    }
  );
});

app.post('/api/leave/:id/approve', auth, adminOnly, (req, res) => {
  db.get(
    `
    SELECT leaves.*, users.annual_leave
    FROM leaves
    JOIN users ON users.id = leaves.user_id
    WHERE leaves.id=?
    `,
    [req.params.id],
    (e, row) => {
      if (!row) return res.status(404).json({ error: 'not found' });

      if (row.type === 'sick') {
        return db.run(
          `UPDATE leaves SET status='approved' WHERE id=?`,
          [req.params.id],
          () => res.json({ ok: true })
        );
      }

      db.get(
        `
        SELECT COALESCE(SUM(days),0) used
        FROM leaves
        WHERE user_id=? AND status='approved' AND type='annual'
        `,
        [row.user_id],
        (e2, sum) => {
          if ((sum.used || 0) + row.days > row.annual_leave) {
            return res.status(400).json({ error: 'Leave limit exceeded' });
          }

          db.run(
            `UPDATE leaves SET status='approved' WHERE id=?`,
            [req.params.id],
            () => res.json({ ok: true })
          );
        }
      );
    }
  );
});

app.post('/api/leave/:id/reject', auth, adminOnly, (req, res) => {
  db.run(
    `UPDATE leaves SET status='rejected' WHERE id=?`,
    [req.params.id],
    () => res.json({ ok: true })
  );
});

app.post('/api/leave/:id/delete', auth, adminOnly, (req, res) => {
  db.run(
    `DELETE FROM leaves WHERE id=?`,
    [req.params.id],
    () => res.json({ ok: true })
  );
});

/* ================= HOLIDAYS ================= */

app.get('/api/holidays', auth, (req, res) => {
  db.all(`SELECT * FROM holidays`, (e, rows) => {
    if (e) return res.json([]);
    res.json(rows);
  });
});

/* ================= PAYSLIPS ================= */

app.post('/api/payslips/upload', auth, adminOnly, upload.single('payslip'), (req, res) => {
  if (!req.body.username || !req.file) {
    return res.status(400).json({ error: 'missing fields' });
  }

  db.run(
    `INSERT INTO payslips(username,file_name,original_name)
     VALUES(?,?,?)`,
    [req.body.username, req.file.filename, req.file.originalname],
    err => {
      if (err) {
        console.log(err);
        return res.status(500).json({ error: 'db' });
      }
      res.json({ ok: true });
    }
  );
});

app.get('/api/payslips', auth, (req, res) => {
  const sql = req.session.user.role === 'admin'
    ? `SELECT * FROM payslips ORDER BY id DESC`
    : `SELECT * FROM payslips WHERE username=? ORDER BY id DESC`;

  const params = req.session.user.role === 'admin'
    ? []
    : [req.session.user.username];

  db.all(sql, params, (e, rows) => {
    if (e) return res.status(500).json({ error: 'db' });
    res.json(rows);
  });
});

app.get('/api/payslips/:id/download', auth, (req, res) => {
  db.get(`SELECT * FROM payslips WHERE id=?`, [req.params.id], (e, row) => {
    if (!row) return res.sendStatus(404);

    if (req.session.user.role !== 'admin' && row.username !== req.session.user.username) {
      return res.sendStatus(403);
    }

    const f = path.join(__dirname, 'uploads', 'payslips', row.file_name);
    if (!fs.existsSync(f)) return res.sendStatus(404);

    res.download(f, row.original_name);
  });
});

app.listen(5050, '0.0.0.0', () => {
  console.log('MiniHR running on 5050');
});
