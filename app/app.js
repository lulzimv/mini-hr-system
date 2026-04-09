app.post('/api/users/update', auth, (req, res) => {

  if (req.session.user.role !== 'admin')
    return res.status(403).json({ error: 'forbidden' });

  const { id, username, role, annual_leave, password } = req.body;

  if (!id || !username)
    return res.status(400).json({ error: 'missing fields' });

  // ⭐ update WITHOUT password change
  if (!password || password.trim() === "") {

    db.run(
      `UPDATE users
       SET username = ?,
           role = ?,
           annual_leave = ?
       WHERE id = ?`,
      [username, role, annual_leave, id],
      function (err) {

        if (err)
          return res.status(500).json({ error: 'db error' });

        return res.json({ ok: true });
      }
    );

  } else {

    // ⭐ update WITH password change
    const hash = hashPassword(password);

    db.run(
      `UPDATE users
       SET username = ?,
           role = ?,
           annual_leave = ?,
           password_hash = ?
       WHERE id = ?`,
      [username, role, annual_leave, hash, id],
      function (err) {

        if (err)
          return res.status(500).json({ error: 'db error' });

        return res.json({ ok: true });
      }
    );

  }

});
