
// ================= ADMIN USERS API =================

app.get('/api/users', auth, (req, res) => {
  if (req.session.user.role !== 'admin')
    return res.status(403).json({ error: 'forbidden' });

  db.all("SELECT id, username, role, annual_leave FROM users",
    (err, rows) => res.json(rows));
});

app.post('/api/users', auth, (req, res) => {
  if (req.session.user.role !== 'admin')
    return res.status(403).json({ error: 'forbidden' });

  const { username, password, role, annual_leave } = req.body;
  const hash = hashPassword(password);

  db.run(
    `INSERT INTO users(username,password_hash,role,annual_leave)
     VALUES(?,?,?,?)`,
    [username, hash, role || 'user', annual_leave || 20],
    () => res.json({ ok: true })
  );
});

app.delete('/api/users/:id', auth, (req, res) => {
  if (req.session.user.role !== 'admin')
    return res.status(403).json({ error: 'forbidden' });

  db.run("DELETE FROM users WHERE id = ?", [req.params.id],
    () => res.json({ ok: true }));
});

