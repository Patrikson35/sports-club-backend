# 🏃‍♂️ Sports Club Management System - Backend API

Kompletný REST API backend pre správu športových klubov s podporou 7 typov používateľov, virtuálnych hráčov, pozvaní a COPPA compliance.

## 🚀 Deployed Production

**Backend API:** https://outstanding-blessing-production-2cba.up.railway.app  
**Web Admin:** https://sports-club-web-admin-production.up.railway.app

## 📋 Požadavky

- Node.js >= 18.0.0
- MySQL 8.0+
- npm nebo yarn

## 🔧 Quick Start

### Lokálny Vývoj

```bash
# 1. Klonujte repozitár
git clone https://github.com/Patrikson35/sports-club-backend.git
cd sports-club-backend/api-simple

# 2. Nainštalujte závislosti
npm install

# 3. Skopírujte .env súbor
cp .env.sample .env

# 4. Nastavte database credentials v .env

# 5. Spustite server
npm start

# Development s auto-restart:
npm run dev
```

### Production Deploy (Railway)

```bash
# 1. Push na GitHub (automaticky deployuje Railway)
git push origin main

# 2. Počkajte na Railway deployment (1-2 minúty)

# 3. Spustite database migráciu
node run-migration.js

# 4. Overte že backend funguje
curl https://outstanding-blessing-production-2cba.up.railway.app/health
```

## 🗄️ Environment Variables

```env
# Server
NODE_ENV=production
PORT=3000

# Database (Railway MySQL)
DB_HOST=metro.proxy.rlwy.net
DB_PORT=25931
DB_USER=root
DB_PASSWORD=<railway-generated>
DB_NAME=railway

# JWT Authentication
JWT_SECRET=<64-char-random-string>
JWT_EXPIRES_IN=7d

# Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=noreply@sportsclub.com
SMTP_PASS=<app-password>
SMTP_FROM="Sports Club <noreply@sportsclub.com>"

# Frontend
FRONTEND_URL=https://sports-club-web-admin-production.up.railway.app
CORS_ORIGIN=https://sports-club-web-admin-production.up.railway.app

# Migration
MIGRATION_TOKEN=<secret-token>

# Security
BCRYPT_ROUNDS=12
AGE_CONSENT_THRESHOLD=16
AGE_COPPA_THRESHOLD=13
```

## 📚 API Dokumentácia

### 🔐 Autentifikácia

- `POST /api/auth/login` - Prihlásenie používateľa
- `POST /api/auth/register` - Základná registrácia (deprecated - use /api/registration/*)

### � Registrácia (NEW - v2.0)

**Club Admin:**
- `POST /api/registration/register-club` - Vytvoriť klub + admin účet

**Coach:**
- `POST /api/registration/register-coach` - Registrácia klubového trénera (invite)
- `POST /api/registration/register-private-coach` - Súkromný tréner (samostatne)

**Assistant:**
- `POST /api/registration/register-assistant` - Registrácia asistenta (invite)

**Player:**
- `POST /api/registration/register-player` - Registrácia hráča (s rodičom ak <16)

**Parent:**
- `POST /api/registration/register-parent` - Registrácia rodiča

### 📨 Pozvánky (Invites)

- `POST /api/invites/send` - Poslať pozvánku (auth required)
- `GET /api/invites/:inviteCode` - Detail pozvánky (public)
- `DELETE /api/invites/:inviteId` - Zrušiť pozvánku (auth required)
- `GET /api/invites/club/:clubId` - Zoznam pozvaní klubu (auth required)

### ✉️ Verifikácia

- `POST /api/verification/verify-email` - Overiť email
- `POST /api/verification/verify-parent-consent` - Rodičovský súhlas (COPPA)
- `POST /api/verification/resend-verification` - Znovu poslať verifikačný email

### 🎭 Virtuálni Hráči

- `POST /api/virtual-players/create-virtual` - Vytvoriť virtuálneho hráča (auth)
- `POST /api/virtual-players/:playerId/convert-to-real` - Konvertovať na skutočného (auth)
- `GET /api/virtual-players/team/:teamId/virtual-players` - Zoznam virtuálnych (auth)
- `DELETE /api/virtual-players/:playerId` - Zmazať virtuálneho (auth)

### 🎓 Súkromní Tréneri

- `POST /api/private-coaches/:coachId/assign-player` - Priradiť hráča (auth)
- `DELETE /api/private-coaches/:coachId/remove-player/:playerId` - Odstrániť hráča (auth)
- `GET /api/private-coaches/:coachId/players` - Zoznam hráčov (auth)
- `GET /api/private-coaches/player/:playerId/coaches` - Zoznam trénerov hráča (auth)
- `PATCH /api/private-coaches/:coachId/player/:playerId/notes` - Aktualizovať poznámky (auth)

### 🔧 Migrácia

- `POST /api/migrate/run` - Spustiť SQL migráciu (requires MIGRATION_TOKEN header)
- `GET /api/migrate/status` - Skontrolovať stav databázových tabuliek
- `GET /api/migrate/list` - Zoznam dostupných migrácií

### 🏢 Kluby (Clubs)

- `GET /api/clubs` - Zoznam klubov
- `GET /api/clubs/:id` - Detail klubu
- `POST /api/clubs` - Vytvoriť klub (auth)
- `PUT /api/clubs/:id` - Aktualizovať klub (auth)
- `DELETE /api/clubs/:id` - Zmazať klub (auth)

### 👥 Hráči (Players)

- `GET /api/players` - Zoznam hráčov
- `GET /api/players/:id` - Detail hráča
- Query params: `?teamId=1&search=name`

### 🏆 Týmy (Teams)

- `GET /api/teams` - Zoznam tímov
- `GET /api/teams/:id` - Detail tímu
- `GET /api/teams/:id/players` - Hráči v tíme
- `POST /api/teams` - Vytvoriť tím (auth)

### 💪 Tréningy (Trainings)

- `GET /api/trainings` - Zoznam tréningov
- `GET /api/trainings/:id` - Detail tréningu
- `POST /api/trainings` - Vytvoriť tréning (auth)
- `GET /api/trainings/:id/exercises` - Cvičenia v tréningu
- Query params: `?teamId=1&status=completed&limit=50`

### 🎯 Cvičenia (Exercises)

- `GET /api/exercises` - Zoznam cvičení
- `GET /api/exercises/categories` - Kategórie cvičení
- `GET /api/exercises/:id` - Detail cvičenia
- Query params: `?categoryId=1&difficulty=easy&search=name`

### ⚽ Zápasy (Matches)

- `GET /api/matches` - Zoznam zápsov
- `GET /api/matches/:id` - Detail zápasu
- `GET /api/matches/:id/lineup` - Zostava
- `GET /api/matches/:id/events` - Udalosti (góly, karty)
- `GET /api/matches/table/:teamId` - Tabuľka ligy
- Query params: `?teamId=1&status=completed&limit=50`

### 📊 Testy (Tests)

- `GET /api/tests/categories` - Kategórie testov
- `GET /api/tests/results` - Výsledky testov
- `POST /api/tests/results` - Uložiť výsledok testu (auth)
- `GET /api/tests/players/:id` - Testy hráča
- `GET /api/tests/stats/:categoryType` - Štatistiky (rychlostne, silove, kondicne)
- Query params: `?playerId=1&categoryId=1&teamId=1`

### ✅ Dochádzka (Attendance)

- `GET /api/attendance/:trainingId` - Dochádzka na tréningu
- `POST /api/attendance` - Zapísať dochádzku (auth)
- `GET /api/attendance/player/:playerId` - História hráča

## 🧪 Testovanie API

### Health Check

```bash
curl https://outstanding-blessing-production-2cba.up.railway.app/health
```

### Registrácia Club Admina

```bash
curl -X POST https://outstanding-blessing-production-2cba.up.railway.app/api/registration/register-club \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Jan",
    "lastName": "Novák",
    "email": "jan@email.cz",
    "password": "SilneHeslo123!",
    "clubName": "FC Test",
    "clubCity": "Praha"
  }'
```

### Prihlásenie

```bash
curl -X POST https://outstanding-blessing-production-2cba.up.railway.app/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "jan@email.cz",
    "password": "SilneHeslo123!"
  }'
```

### Poslanie Pozvánky Trénerovi

```bash
curl -X POST https://outstanding-blessing-production-2cba.up.railway.app/api/invites/send \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "inviteType": "coach",
    "email": "trener@email.cz",
    "clubId": 1
  }'
```

### Spustenie Databázovej Migrácie

```bash
curl -X POST https://outstanding-blessing-production-2cba.up.railway.app/api/migrate/run \
  -H "X-Migration-Token: SECRET_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"migrationFile": "20260226_registration_system.sql"}'
```

### Kontrola Stavu Databáze

```bash
curl https://outstanding-blessing-production-2cba.up.railway.app/api/migrate/status
```

## 🔒 Autentifikácia & Autorizácia

API používa JWT tokeny s role-based access control.

### Middleware

**authenticate** - Validuje JWT a načíta používateľa z DB  
**requireRole(['role'])** - Vyžaduje špecifickú rolu  
**requireClubAccess** - Overí člénstvo v klube  
**requireClubAdmin** - Overí admin práva ku klubu  

### Použitie v Requeste

```javascript
const response = await fetch('/api/trainings', {
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  }
});
```

### Typy Používateľov & Práva

| Rola | Popis | Práva |
|------|-------|-------|
| `admin` | Systémový admin | Všetko |
| `club_admin` | Majiteľ klubu | Správa klubu, tímov, pozvania |
| `coach` | Klubový tréner | Tréningy, hodnotenia, pozvania asistentov |
| `private_coach` | Súkromný tréner | Vlastní hráči, súkromné tréningy |
| `assistant` | Asistent trénera | Podpora trénera (obmedzené) |
| `player` | Hráč | Vlastné dáta, účasť na tréningoch |
| `parent` | Rodič | Správa účtov detí, COPPA súhlasy |

## 📱 Integrácia s Mobilnou Aplikáciou

### React Native / Expo

```javascript
// config/api.js
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://outstanding-blessing-production-2cba.up.railway.app/api';

export const api = {
  // Auth
  login: (email, password) =>
    fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    }).then(r => r.json()),

  // Registration
  registerClub: (data) =>
    fetch(`${API_URL}/registration/register-club`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(r => r.json()),

  registerCoach: (data) =>
    fetch(`${API_URL}/registration/register-coach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(r => r.json()),

  // Players
  getPlayers: (token, teamId) =>
    fetch(`${API_URL}/players${teamId ? `?teamId=${teamId}` : ''}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    }).then(r => r.json()),

  getPlayer: (token, id) =>
    fetch(`${API_URL}/players/${id}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    }).then(r => r.json()),

  // Teams
  getTeams: (token) =>
    fetch(`${API_URL}/teams`, {
      headers: { 'Authorization': `Bearer ${token}` }
    }).then(r => r.json()),

  getTeamPlayers: (token, id) =>
    fetch(`${API_URL}/teams/${id}/players`, {
      headers: { 'Authorization': `Bearer ${token}` }
    }).then(r => r.json()),

  // Trainings
  getTrainings: (token, teamId) =>
    fetch(`${API_URL}/trainings?teamId=${teamId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    }).then(r => r.json()),

  createTraining: (token, data) =>
    fetch(`${API_URL}/trainings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    }).then(r => r.json()),

  // Virtual Players
  createVirtualPlayer: (token, data) =>
    fetch(`${API_URL}/virtual-players/create-virtual`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    }).then(r => r.json()),

  convertVirtualPlayer: (token, playerId, data) =>
    fetch(`${API_URL}/virtual-players/${playerId}/convert-to-real`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    }).then(r => r.json()),

  // Matches
  getMatches: (token, teamId) =>
    fetch(`${API_URL}/matches?teamId=${teamId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    }).then(r => r.json()),

  // Tests
  getTestStats: (token, type, teamId) =>
    fetch(`${API_URL}/tests/stats/${type}?teamId=${teamId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    }).then(r => r.json())
};
```

## 🚀 Deployment

### Lokálny Development

```bash
# Start server
npm run dev

# Server beží na http://localhost:3000
# Test: curl http://localhost:3000/health
```

### Railway Production Deploy

```bash
# 1. Push zmeny na GitHub
git add .
git commit -m "Update backend"
git push origin main

# 2. Railway automaticky detectuje push a začne deployment

# 3. Sledovanie deployment:
# https://railway.app/project/<your-project>/deployments

# 4. Po úspešnom deployi spustite migráciu:
node run-migration.js
# Alebo manuálne:
curl -X POST https://outstanding-blessing-production-2cba.up.railway.app/api/migrate/run \
  -H "X-Migration-Token: SECRET" \
  -d '{"migrationFile": "20260226_registration_system.sql"}'
```

### Environment Variables Setup (Railway)

1. Railway Dashboard → Project → Variables
2. Pridať všetky potrebné env vars (pozri sekciu Environment Variables)
3. Deployment sa automaticky reštartuje

## 🗄️ Databázová Migrácia

### Automatická Migrácia (Odporúčané)

```bash
# Nastaviť MIGRATION_TOKEN v Railway env vars
# Spustiť:
node run-migration.js
```

Skript automaticky:
- Čaká kým backend nereaguje
- Kontroluje stav databázových tabuliek
- Spúšťa migráciu ak je potrebná
- Validuje výsledok

### Manuálna Migrácia

```bash
# Overiť dostupnosť
curl https://outstanding-blessing-production-2cba.up.railway.app/health

# Skontrolovať stav tabuliek
curl https://outstanding-blessing-production-2cba.up.railway.app/api/migrate/status

# Spustiť migráciu
curl -X POST https://outstanding-blessing-production-2cba.up.railway.app/api/migrate/run \
  -H "X-Migration-Token: YOUR_SECRET_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"migrationFile": "20260226_registration_system.sql"}'
```

## 📧 Email Konfigurácia

### Gmail SMTP

1. Google Account → Security → 2-Step Verification (enable)
2. App Passwords → Generate password for "Mail"
3. Railway env vars:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=noreply@yourclub.com
   SMTP_PASS=<app-password-16-chars>
   ```

### Alternatívne Poskytovatelia

**SendGrid:**
```
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=<sendgrid-api-key>
```

**Mailgun:**
```
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_USER=postmaster@<your-domain>
SMTP_PASS=<mailgun-password>
```

## 📚 Dokumentácia

### Quick Start Guide
[→ docs/QUICK_START.md](./docs/QUICK_START.md)

Rýchly návod na:
- Spustenie migrácie
- SMTP konfigurácia
- Testovanie všetkých registrácií
- Diagnostika problémov

### Kompletná Registračná Dokumentácia
[→ docs/REGISTRATION_SYSTEM_DOCS.md](./docs/REGISTRATION_SYSTEM_DOCS.md)

Detailný popis:
- Všetkých 7 typov používateľov
- Registračné toky
- Virtuálni hráči
- Systém pozvaní
- Email verifikácia
- COPPA compliance
- Vzťahy medzi používateľmi
- TypeScript typy
- API examples

## 🐛 Riešenie Problémov

### Backend vracia 502

**Príčina:** Railway ešte deployuje  
**Riešenie:** Počkajte 1-2 minúty, skontrolujte Railway deployment logs

### Migrácia hlási chybu "table already exists"

**Príčina:** Migrácia už bola spustená skôr  
**Riešenie:** To je OK - systém ignoruje už existujúce tabulky

### Email sa neposiela

**Príčiny:**
- SMTP credentials nesprávne
- Gmail App Password nie je nastavené
- Port 587 zablokovaný firewall-om

**Riešenie:**
```bash
# Test SMTP connection
telnet smtp.gmail.com 587

# Debug logging
# Pridať do server.js:
console.log('SMTP Config:', {
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  user: process.env.SMTP_USER
});
```

### JWT token invalid

**Príčina:** Token expirovaný (7 dní) alebo JWT_SECRET sa zmenil  
**Riešenie:** Prihláste sa znovu pre nový token

### Database connection timeout

**Príčiny:**
- Railway MySQL je down
- DB credentials nesprávne
- Connection pool vyčerpaný

**Riešenie:**
```bash
# Skontrolujte Railway MySQL status
# Reštartujte service v Railway dashboard
# Zvýšte connection pool: DB_POOL_SIZE=10
```

## 📊 Štatistiky Projektu

- **API Endpoints:** 70+
- **Database Tables:** 20
- **Lines of Code:** ~5,000
- **Dependencies:** 15
- **Supported User Roles:** 7
- **Registration Flows:** 6

## 📈 Roadmap

### v2.0 ✅ (Current) - Complete Registration System
- [x] 7 user roles
- [x] Virtual players
- [x] Invite system
- [x] COPPA compliance
- [x] Migration endpoint
- [x] Comprehensive documentation

### v2.1 🔜 (Next) - Email & Frontend
- [ ] Email service configuration
- [ ] Frontend registration forms
- [ ] Email templates
- [ ] Parent consent pages
- [ ] Virtual player management UI

### v3.0 🔮 (Future) - Advanced Features
- [ ] Real-time notifications (WebSockets)
- [ ] Advanced analytics dashboard
- [ ] PDF report exports
- [ ] Mobile app (React Native)
- [ ] Multi-language support (i18n)
- [ ] Video upload & streaming
- [ ] Payment integration (subscriptions)

## 👥 Contributors

- **Patrik** - Project Owner & Lead Developer
- **GitHub Copilot** - AI Pair Programmer

## 📄 License

MIT License

## 🆘 Support

**Documentation:** [docs/](./docs/)  
**GitHub:** https://github.com/Patrikson35/sports-club-backend  
**Issues:** https://github.com/Patrikson35/sports-club-backend/issues  
**Email:** support@sportsclub.com

---

**Last Updated:** 26. februára 2025  
**Version:** 2.0.0  
**Status:** 🟢 Production Ready (Migration pending)

4. Spusťte `npm start`
5. Použijte PM2 pro běh na pozadí:
   ```bash
   npm install -g pm2
   pm2 start server.js --name sports-api
   pm2 save
   ```

## ⚠️ Poznámky

- **Wedos blokuje vzdálené MySQL připojení** - backend MUSÍ běžet na stejném serveru jako databáze
- Na produkci změňte `DB_HOST=localhost` (ne md395.wedos.net)
- Změňte `JWT_SECRET` na silné heslo
- Nastavte `NODE_ENV=production`

## 📊 Struktura odpovědí

Všechny endpointy vracejí JSON:

```json
{
  "total": 10,
  "players": [...]
}
```

Chyby:

```json
{
  "error": "Error message",
  "stack": "..." // pouze v development
}
```

## 🎯 Použité technologie

- Express.js 4.18
- MySQL2 (connection pool)
- bcrypt (hesla)
- jsonwebtoken (JWT)
- express-validator
- dotenv

---

**✅ Backend je připravený podle všech obrazovek z mobilní aplikace!**
