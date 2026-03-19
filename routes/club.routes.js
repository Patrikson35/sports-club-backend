const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// GET /api/clubs/my-club - Získať klub aktuálneho používateľa
router.get('/my-club', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Nájsť klub, ktorý vlastní tento používateľ
    const [clubs] = await db.query(
      `SELECT c.*, u.email, u.first_name, u.last_name 
       FROM clubs c
       JOIN users u ON u.id = ?
       WHERE c.owner_id = ? OR c.id IN (
         SELECT club_id FROM users WHERE id = ?
       )
       LIMIT 1`,
      [userId, userId, userId]
    );

    if (clubs.length === 0) {
      return res.status(404).json({ error: 'Klub nebol nájdený' });
    }

    const club = clubs[0];

    res.json({
      id: club.id,
      name: club.name,
      address: club.address || '',
      city: club.city || '',
      country: club.country || 'SK',
      email: club.email || club.email,
      phone: club.phone || '',
      website: club.website || '',
      logo: club.logo || ''
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/clubs - Vytvoriť nový klub
router.post('/', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { name, address, city, country, email, phone, website } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'Názov klubu je povinný' });
    }

    // Skontrolovať, či používateľ už nemá klub
    const [existingClubs] = await db.query(
      'SELECT id FROM clubs WHERE owner_id = ?',
      [userId]
    );

    if (existingClubs.length > 0) {
      return res.status(400).json({ error: 'Používateľ už má vytvorený klub' });
    }

    // Vytvoriť klub
    const [result] = await db.query(
      `INSERT INTO clubs (name, address, city, country, email, phone, website, owner_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [name, address || '', city || '', country || 'SK', email || '', phone || '', website || '', userId]
    );

    const clubId = result.insertId;

    // Aktualizovať používateľa - priradiť mu club_id
    await db.query(
      'UPDATE users SET club_id = ? WHERE id = ?',
      [clubId, userId]
    );

    res.status(201).json({
      message: 'Klub bol úspešne vytvorený',
      clubId: clubId
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/clubs/my-club - Aktualizovať klub aktuálneho používateľa
router.put('/my-club', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { name, address, city, country, email, phone, website } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'Názov klubu je povinný' });
    }

    // Nájsť klub používateľa
    const [clubs] = await db.query(
      'SELECT id FROM clubs WHERE owner_id = ? OR id IN (SELECT club_id FROM users WHERE id = ?)',
      [userId, userId]
    );

    if (clubs.length === 0) {
      return res.status(404).json({ error: 'Klub nebol nájdený' });
    }

    const clubId = clubs[0].id;

    // Aktualizovať klub
    await db.query(
      `UPDATE clubs 
       SET name = ?, address = ?, city = ?, country = ?, email = ?, phone = ?, website = ?, updated_at = NOW()
       WHERE id = ?`,
      [name, address || '', city || '', country || 'SK', email || '', phone || '', website || '', clubId]
    );

    res.json({
      message: 'Klub bol úspešne aktualizovaný'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
