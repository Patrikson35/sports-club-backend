# 🚀 Sports Club API - Simple Backend

Jednoduchý REST API backend pro mobilní aplikaci Sports Club.

## 📋 Požadavky

- Node.js >= 14.0.0
- MySQL/MariaDB databáze (Wedos)
- npm nebo yarn

## 🔧 Instalace

```bash
# 1. Přejděte do složky
cd api-simple

# 2. Instalujte závislosti
npm install

# 3. Nakonfigurujte .env soubor
# Upravte .env a doplňte své údaje z Wedos

# 4. Spusťte server
npm start

# Pro development s auto-restart:
npm run dev
```

## 🗄️ Konfigurace databáze

Upravte soubor `.env`:

```env
DB_HOST=md395.wedos.net
DB_PORT=3306
DB_USER=a266434_app
DB_PASSWORD=your_password_here
DB_NAME=d266434_app

PORT=3000
JWT_SECRET=your_secret_key_here
```

## 📚 API Endpointy

### 🔐 Autentizace

- `POST /api/auth/login` - Přihlášení uživatele
- `POST /api/auth/register` - Registrace

### 👥 Hráči (Players)

- `GET /api/players` - Seznam hráčů
- `GET /api/players/:id` - Detail hráče
- Query params: `?teamId=1&search=name`

### 🏆 Týmy (Teams)

- `GET /api/teams` - Seznam týmů
- `GET /api/teams/:id` - Detail týmu
- `GET /api/teams/:id/players` - Hráči v týmu

### 💪 Tréninky (Trainings)

- `GET /api/trainings` - Seznam tréninků
- `GET /api/trainings/:id` - Detail tréninku
- `POST /api/trainings` - Vytvořit trénink
- `GET /api/trainings/:id/exercises` - Cvičení v tréninku
- Query params: `?teamId=1&status=completed&limit=50`

### 🎯 Cvičení (Exercises)

- `GET /api/exercises` - Seznam cvičení
- `GET /api/exercises/categories` - Kategorie cvičení
- `GET /api/exercises/:id` - Detail cvičení
- Query params: `?categoryId=1&difficulty=easy&search=name`

### ⚽ Zápasy (Matches)

- `GET /api/matches` - Seznam zápasů
- `GET /api/matches/:id` - Detail zápasu
- `GET /api/matches/:id/lineup` - Sestava
- `GET /api/matches/:id/events` - Události (góly, karty)
- `GET /api/matches/table/:teamId` - Tabulka ligy
- Query params: `?teamId=1&status=completed&limit=50`

### 📊 Testy (Tests)

- `GET /api/tests/categories` - Kategorie testů
- `GET /api/tests/results` - Výsledky testů
- `POST /api/tests/results` - Uložit výsledek testu
- `GET /api/tests/players/:id` - Testy hráče
- `GET /api/tests/stats/:categoryType` - Statistiky (rychlostne, silove, kondicne)
- Query params: `?playerId=1&categoryId=1&teamId=1`

### ✅ Docházka (Attendance)

- `GET /api/attendance/:trainingId` - Docházka na tréninku
- `POST /api/attendance` - Zapsat docházku
- `GET /api/attendance/player/:playerId` - Historie hráče

## 🧪 Testování API

### Přihlášení (Login)

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@sportsclub.sk",
    "password": "admin123"
  }'
```

### Seznam hráčů

```bash
curl http://localhost:3000/api/players
```

### Detail hráče

```bash
curl http://localhost:3000/api/players/1
```

### Tréninky týmu U9

```bash
curl http://localhost:3000/api/trainings?teamId=2
```

### Zápasy

```bash
curl http://localhost:3000/api/matches?teamId=2
```

### Tabulka ligy

```bash
curl http://localhost:3000/api/matches/table/2
```

### Statistiky rychlostních testů

```bash
curl "http://localhost:3000/api/tests/stats/rychlostne?teamId=2"
```

## 📱 Integrace s mobilní aplikací

### V React Native / Expo:

```javascript
// config/api.js
const API_URL = 'http://localhost:3000/api';

export const api = {
  // Players
  getPlayers: () => fetch(`${API_URL}/players`).then(r => r.json()),
  getPlayer: (id) => fetch(`${API_URL}/players/${id}`).then(r => r.json()),
  
  // Teams
  getTeams: () => fetch(`${API_URL}/teams`).then(r => r.json()),
  getTeamPlayers: (id) => fetch(`${API_URL}/teams/${id}/players`).then(r => r.json()),
  
  // Trainings
  getTrainings: (teamId) => fetch(`${API_URL}/trainings?teamId=${teamId}`).then(r => r.json()),
  getTraining: (id) => fetch(`${API_URL}/trainings/${id}`).then(r => r.json()),
  
  // Matches
  getMatches: (teamId) => fetch(`${API_URL}/matches?teamId=${teamId}`).then(r => r.json()),
  getMatchLineup: (id) => fetch(`${API_URL}/matches/${id}/lineup`).then(r => r.json()),
  
  // Tests
  getTestStats: (type, teamId) => 
    fetch(`${API_URL}/tests/stats/${type}?teamId=${teamId}`).then(r => r.json()),
  
  // Auth
  login: (email, password) => 
    fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    }).then(r => r.json())
};
```

## 🔒 Autentizace

API používá JWT tokeny. Po přihlášení:

```javascript
// Uložte token
const { token } = await api.login('email@example.com', 'password');

// Používejte v dalších requestech
fetch(`${API_URL}/players`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

## 🚀 Deployment na Wedos

1. Nahrajte celou složku `api-simple/` na server
2. Spusťte `npm install --production`
3. Nastavte správně `.env` (DB_HOST=localhost na serveru!)
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
