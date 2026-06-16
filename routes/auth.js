module.exports = function createAuthRoutes(ctx) {
  const router = require('express').Router();
  const {
  app,
  bcrypt,
  users,
  requireAuth,
  pauseBgEnrich
} = ctx;

  router.get('/api/csrf-token', (req, res) => {
  try {
    const token = res.locals && res.locals.csrfToken ? res.locals.csrfToken : (typeof req.csrfToken === 'function' ? req.csrfToken() : null);
    return res.json({ ok: true, token });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

router.get('/api/session', (req, res) => {
  try {
    const username = req.session && req.session.username ? req.session.username : null;
    if (!username || !users[username]) return res.json({ authenticated: false });
    const role = (users[username] && users[username].role) || 'user';
    return res.json({ authenticated: true, username, role });
  } catch (e) {
    return res.json({ authenticated: false });
  }
});

router.get('/api/debug/session', requireAuth, (req, res) => {
  try {
    const session = req.session || null;
    const username = session && session.username ? session.username : null;
    const userExists = username && users && users[username] ? true : false;
    const usersCount = users ? Object.keys(users).length : 0;
    // Do not leak password hashes; only surface counts and whether the user exists
    return res.json({ session, username, userExists, usersCount });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

router.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username required' });
    const user = users[username];
    if (!user) return res.status(401).json({ error: 'invalid credentials' });
    // If no passwordHash is configured, allow login with empty password (bootstrap convenience)
    if (!user.passwordHash) {
      if (password && String(password).length) return res.status(401).json({ error: 'invalid credentials' });
      req.session.username = username;
      // Pause background enrichment so the UI stays responsive during the session
      try { if (typeof pauseBgEnrich === 'function') pauseBgEnrich(); } catch (e) {}
      return res.json({ ok: true, username });
    }
    // compare hashed password
    bcrypt.compare(String(password || ''), String(user.passwordHash || ''), (err, same) => {
      if (err) return res.status(500).json({ error: 'compare error' });
      if (!same) return res.status(401).json({ error: 'invalid credentials' });
      req.session.username = username;
      // Pause background enrichment so the UI stays responsive during the session
      try { if (typeof pauseBgEnrich === 'function') pauseBgEnrich(); } catch (e) {}
      return res.json({ ok: true, username });
    });
  } catch (e) { return res.status(500).json({ error: e && e.message ? e.message : String(e) }); }
});

  return router;
};
