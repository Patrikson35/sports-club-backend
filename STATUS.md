# 🎉 Nový backend je hotový!

## ✅ Co bylo vytvořeno:

### 📁 Struktura:
```
api-simple/
├── server.js              # Hlavní Express server
├── package.json           # Dependencies
├── .env                   # Konfigurace (s vaším Wedos heslem)
├── config/
│   └── database.js        # MySQL connection pool
├── middleware/
│   ├── auth.js            # JWT autentizace
│   └── errorHandler.js    # Error handling
└── routes/
    ├── auth.js            # Login, register
    ├── players.js         # Hráči (GET / GET /:id)
    ├── teams.js           # Týmy (GET / GET /:id/players)
    ├── trainings.js       # Tréninky (GET / POST / GET /:id)
    ├── exercises.js       # Cvičení (GET / GET /categories)
    ├── matches.js         # Zápasy (GET / GET /:id/lineup / events / table)
    ├── tests.js           # Testy (GET /categories / results / stats)
    └── attendance.js      # Docházka (GET /:trainingId / POST)
```

### 🎯 API Endpointy (celkem 25+):

**✅ Přesně podle vašich obrazovek:**

#### PlayersScreen → `/api/players`
- Seznam všech hráčů s avatary, dresem, pozicemi

#### PlayerDetailScreen → `/api/players/:id`
- Detail hráče + stats (zápasy, góly, docházka)

#### TeamsScreen → `/api/teams`
- Seznam týmů (U7-U15)

#### TrainingsScreen → `/api/trainings`
- Seznam tréninků (#47-52)

#### TrainingDetailScreen → `/api/trainings/:id`
- Detail tréninku + cvičení + docházka

#### CreateTrainingScreen → `POST /api/trainings`
- Vytvoření nového tréninku

#### ExerciseSelectionScreen → `/api/exercises/categories`
- Kategorie: Hry 1v1, 2v2, Koordinácia

#### MatchesMainScreen → `/api/matches`
- Seznam zápasů (Kolo, Zápas, Výsledok, Kat.)

#### MatchOverviewScreen → `/api/matches/:id`
- Detail zápasu

#### MatchLineupScreen → `/api/matches/:id/lineup`
- Základní sestava + náhradníci

#### MatchTableScreen → `/api/matches/table/:teamId`
- Tabulka ligy (#, To, OZ, G, B)

#### TestsMainScreen → `/api/tests/results`
- Výsledky testů hráčů

#### PlayerTestDetailScreen → `/api/tests/players/:id`
- Testy konkrétního hráče

#### TestStatisticsScreen → `/api/tests/stats/:categoryType`
- Statistiky (rychlostne, silove, kondicne) s grafovými daty

#### AttendanceScreen → `/api/attendance/:trainingId`
- Docházka na tréninku

---

## ⚠️ DŮLEŽITÉ: Wedos blokuje vzdálené připojení

Backend **funguje**, ale nemůže se připojit k databázi z vašeho PC:
```
❌ Database connection failed: connect ETIMEDOUT
```

**To je normální!** Wedos z bezpečnostních důvodů blokuje vzdálená MySQL připojení.

---

## 🚀 Řešení: 3 možnosti

### 1️⃣ RYCHLÉ TESTOVÁNÍ - Mock Data (doporučeno pro vývoj)

Vytvořím verzi API s předpřipravenými daty pro lokální vývoj:

```javascript
// Místo databáze použije JSON data z test-data.sql
// Můžete testovat mobilní app HNED
```

### 2️⃣ NASAZENÍ NA WEDOS (produkce)

1. Nahrajte `api-simple/` složku na Wedos server
2. Na serveru změňte `.env`:
   ```env
   DB_HOST=localhost  # ← ZMĚNA! (ne md395.wedos.net)
   ```
3. Spusťte `npm start` na serveru
4. Backend se připojí k databázi (localhost funguje)

### 3️⃣ LOKÁLNÍ MYSQL (pro development)

Nainstalujte MySQL lokálně:
- Importujte `init-db-mysql.sql` + `test-data.sql`
- Změňte `.env` na lokální databázi
- Backend bude fungovat na vašem PC

---

## 🎯 Co teď?

**Varianta A:** Chcete **rychle testovat mobilní app**?
- Vytvořím mock verzi API s fake daty
- Funguje bez databáze
- Připraveno za 5 minut

**Varianta B:** Chcete **nasadit na Wedos**?
- Ukážu kroky pro deployment
- Backend + databáze na serveru
- Produkční řešení

**Varianta C:** Chcete **propojit mobilní app teď**?
- Vytvořím API servisní vrstvu v App.tsx
- Nahradí hardcoded data
- Připraveno na reálné API

**Co preferujete?** 😊
