const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const ensureCoachProfilesTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS coach_profiles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL UNIQUE,
      is_club_coach BOOLEAN DEFAULT FALSE,
      is_personal_coach BOOLEAN DEFAULT FALSE,
      club_name VARCHAR(255) NULL,
      country VARCHAR(10) DEFAULT 'SK',
      photo_url VARCHAR(500) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
};

router.get('/my-profile', authenticateToken, async (req, res, next) => {
  try {
    await ensureCoachProfilesTable();

    const [profiles] = await db.query(
      `SELECT is_club_coach, is_personal_coach, club_name, country, photo_url
       FROM coach_profiles
       WHERE user_id = ?
       LIMIT 1`,
      [req.user.id]
    );

    const profile = profiles[0] || {
      is_club_coach: false,
      is_personal_coach: false,
      club_name: '',
      country: 'SK',
      photo_url: ''
    };

    res.json({
      isClubCoach: Boolean(profile.is_club_coach),
      isPersonalCoach: Boolean(profile.is_personal_coach),
      clubName: profile.club_name || '',
      country: profile.country || 'SK',
      photo: profile.photo_url || ''
    });
  } catch (error) {
    next(error);
  }
});

router.put('/my-profile', authenticateToken, async (req, res, next) => {
  try {
    await ensureCoachProfilesTable();

    const { isClubCoach, isPersonalCoach, clubName, country, photo } = req.body;

    if (!isClubCoach && !isPersonalCoach) {
      return res.status(400).json({ error: 'Vyberte aspoň jeden typ trénera' });
    }

    await db.query(
      `INSERT INTO coach_profiles (user_id, is_club_coach, is_personal_coach, club_name, country, photo_url)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         is_club_coach = VALUES(is_club_coach),
         is_personal_coach = VALUES(is_personal_coach),
         club_name = VALUES(club_name),
         country = VALUES(country),
         photo_url = VALUES(photo_url),
         updated_at = CURRENT_TIMESTAMP`,
      [
        req.user.id,
        Boolean(isClubCoach),
        Boolean(isPersonalCoach),
        (clubName || '').trim(),
        (country || 'SK').trim(),
        photo || null
      ]
    );

    if (photo) {
      await db.query('UPDATE users SET avatar_url = ? WHERE id = ?', [photo, req.user.id]);
    }

    res.json({ message: 'Profil trénera bol úspešne uložený' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
