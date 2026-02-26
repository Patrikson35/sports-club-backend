# 📘 KOMPLETNÍ REGISTRAČNÍ SYSTÉM - DOKUMENTACE

## 🎯 Přehled

Kompletní registrační a vzťahový systém pro športovú správu klubov. Systém podporuje 7 typov používateľov s komplexnými registráciami, pozvankami, virtuálnymi hráčmi a COPPA compliance.

## 👥 Typy Používateľov

### 1. **Admin** (`admin`)
- Systémový administrátor
- Plný prístup k všetkým funkciám
- Môže spravovať všetky kluby a používateľov

### 2. **Club Admin** (`club_admin`) 
- Vlastník/správca klubu
- Vytvára a spravuje klub
- Pozýva členov (tréneri, asistenti, hráči)
- Spravuje tímy a tréningy

### 3. **Coach** (`coach`)
- **Klubový tréner**: Pozvaný club adminom, pripojený ku klubu
- **Súkromný tréner** (`private_coach`): Samostatná registrácia, nezávislý od klubu
- Vytvára tréningy a hodnotí hráčov
- Môže pozývať asistentov

### 4. **Assistant** (`assistant`)
- Pomocník trénera
- Pozvaný club adminom alebo trénerom
- Obmedzené práva (podľa nastavení)
- Pomáha s tréningami a hodnoteniami

### 5. **Player** (`player`)
- Skutočný hráč s emailom a prihlásením
- Ak vek < 16: vyžaduje rodiča a COPPA súhlas
- Účastní sa tréningov, zásudzí, testov

### 6. **Parent** (`parent`)
- Rodič/opatrovník neplnoletého hráča
- Spravuje účty detí
- Udeľuje COPPA súhlas
- Môže mať viacero detí

### 7. **Virtual Player** (špecialny typ Player)
- Vytvorený trénerom pre rýchle zostavenie tímu
- **Nemá** email, heslo ani prihlásenie
- Môže byť hodnotený a sledovaný
- Môže byť konvertovaný na skutočného hráča

---

## 🔐 Registračné Toky

### 1️⃣ Registrácia Club Admina

**Endpoint:** `POST /api/registration/register-club`

**Proces:**
1. Používateľ vyplní registračný formulár (meno, email, heslo, názov klubu)
2. Systém:
   - Vytvorí používateľa (role: `club_admin`)
   - Vytvorí klub
   - Pridá používateľa do `club_members`
   - Vygeneruje verifikačný token
   - Pošle overovací email
3. Používateľ klikne na link v emailu → účet aktivovaný

**Request Body:**
```json
{
  "firstName": "Jan",
  "lastName": "Novák",
  "email": "jan.novak@email.cz",
  "password": "SilneHeslo123!",
  "phoneNumber": "+420123456789",
  "clubName": "FC Slavia Praha",
  "clubAddress": "Eden 1, Praha 10",
  "clubCity": "Praha",
  "clubZipCode": "10000",
  "clubCountry": "CZ"
}
```

---

### 2️⃣ Registrácia Trénera (Klubový)

**Endpoint:** `POST /api/registration/register-coach`

**Proces:**
1. Club admin pošle pozvánku: `POST /api/invites/send`
   ```json
   {
     "inviteType": "coach",
     "email": "trener@email.cz",
     "clubId": 5,
     "metadata": { "teamId": 12 }
   }
   ```
2. Systém pošle email s invite kódom
3. Tréner klikne na link, formulár je predvyplnený
4. Tréner doplní heslo a osobné údaje
5. Systém:
   - Validuje invite kód
   - Vytvorí používateľa (role: `coach`)
   - Pridá do `club_members`
   - Označí pozvánku ako akceptovanú

**Request Body:**
```json
{
  "firstName": "Pavel",
  "lastName": "Svoboda",
  "email": "trener@email.cz",
  "password": "TajneHeslo789!",
  "phoneNumber": "+420987654321",
  "inviteCode": "COACH_abc123xyz"
}
```

---

### 3️⃣ Registrácia Trénera (Súkromný)

**Endpoint:** `POST /api/registration/register-private-coach`

**Proces:**
1. Tréner sa samostatne zaregistruje
2. **Bez klubu** - pracuje nezávisle
3. Systém pošle verifikačný email
4. Po aktivácii môže:
   - Pridávať súkromných hráčov
   - Vytvárať súkromné tréningy

**Request Body:**
```json
{
  "firstName": "Martin",
  "lastName": "Kováč",
  "email": "sukromny.trener@email.cz",
  "password": "Heslo123!",
  "phoneNumber": "+421901234567",
  "bio": "10 rokov skúseností s mládežníckym futbalom"
}
```

---

### 4️⃣ Registrácia Asistenta

**Endpoint:** `POST /api/registration/register-assistant`

**Proces:**
1. Club admin alebo tréner pošle pozvánku
2. Asistent klikne na link
3. Vyplní heslo a osobné údaje
4. Systém:
   - Vytvorí používateľa (role: `assistant`)
   - Pripojí k trénerovi cez `coach_assistants`
   - Nastaví práva (môže vytvárať tréningy? vidieť analytiku?)

**Request Body:**
```json
{
  "firstName": "Lukáš",
  "lastName": "Dvořák",
  "email": "asistent@email.cz",
  "password": "AsistentHeslo!",
  "inviteCode": "ASST_xyz789abc"
}
```

---

### 5️⃣ Registrácia Hráča

**Endpoint:** `POST /api/registration/register-player`

**Proces:**

#### A) Hráč ≥ 16 rokov (Samostatná registrácia)
1. Hráč vyplní formulár
2. Systém:
   - Vypočíta vek
   - Vytvorí používateľa (role: `player`)
   - Pošle verifikačný email

#### B) Hráč < 16 rokov (S rodičom)
1. Hráč vyplní formulár + email rodiča
2. Systém:
   - Vypočíta vek → zistí potrebu rodiča
   - Vytvorí alebo nájde rodiča
   - Vytvorí hráča s `parent_id`
   - Vytvorí `parent_child_link`
   - **Pošle COPPA súhlasový email rodičovi**
3. Rodič klikne na link:
   - Overí email
   - **Udelí súhlas** → hráč aktivovaný
   - **Zamietne súhlas** → hráč deaktivovaný

**Request Body (s rodičom):**
```json
{
  "firstName": "Tomáš",
  "lastName": "Malý",
  "email": "tomas.maly@email.cz",
  "password": "HracHeslo123!",
  "dateOfBirth": "2012-05-15",
  "parentFirstName": "Jana",
  "parentLastName": "Malá",
  "parentEmail": "jana.mala@email.cz",
  "parentPhoneNumber": "+420777888999",
  "inviteCode": "PLAYER_club123" // voliteľné
}
```

---

### 6️⃣ Registrácia Rodiča

**Endpoint:** `POST /api/registration/register-parent`

**Proces:**
1. Rodič sa registruje samostatne
2. Systém vytvorí účet (role: `parent`)
3. Rodič môže neskôr:
   - Pridať deti cez invite kód
   - Spravovať účty detí
   - Udeľovať súhlasy

**Request Body:**
```json
{
  "firstName": "Petra",
  "lastName": "Nová",
  "email": "petra.nova@email.cz",
  "password": "RodicHeslo!",
  "phoneNumber": "+420666777888"
}
```

---

## 🎭 Virtuálni Hráči

Virtuálni hráči umožňujú trénerom rýchlo vytvoriť tím bez čakania na registráciu.

### Vytvorenie Virtuálneho Hráča

**Endpoint:** `POST /api/virtual-players/create-virtual`

**Autorizácia:** Club admin alebo tréner

**Proces:**
1. Tréner zadá meno hráča
2. Systém:
   - Vygeneruje virtuálny email: `virtual_abc123@sportsclub.local`
   - Vytvorí používateľa s `is_virtual=TRUE`
   - **Bez** hesla, emailu, prihlásenia
   - Pridá do tímu

**Request:**
```json
{
  "firstName": "Virtuálny",
  "lastName": "Hráč",
  "teamId": 8,
  "position": "útočník",
  "dateOfBirth": "2010-08-20"
}
```

---

### Konverzia Virtuálneho → Skutočný Hráč

**Endpoint:** `POST /api/virtual-players/:playerId/convert-to-real`

**Proces:**
1. Tréner spustí konverziu
2. Zadá email rodiča
3. Systém:
   - Vytvorí alebo nájde rodiča
   - Pripojí rodiča k hráčovi (`parent_id`)
   - Označí `is_virtual=FALSE`
   - Pošle pozvánku rodičovi
   - **Zachová všetky dáta** (tréningy, hodnotenia, štatistiky)
4. Rodič klikne na link:
   - Nastaví email a heslo hráča
   - Udelí COPPA súhlas
   - Hráč aktivovaný

**Request:**
```json
{
  "parentEmail": "rodic@email.cz",
  "parentFirstName": "Anna",
  "parentLastName": "Nováková",
  "playerEmail": "hrac@email.cz"
}
```

---

## 📨 Systém Pozvaní

### Typy Pozvaní

| Typ | Kto pozýva | Koho pozýva |
|-----|-----------|-------------|
| `coach` | Club admin | Tréner do klubu |
| `assistant` | Club admin / Tréner | Asistent |
| `player` | Club admin / Tréner | Hráč do tímu |
| `parent` | Systém (automat) | Rodič neplnoletého hráča |
| `club_admin` | Admin | Club admin nového klubu |

### Poslanie Pozvánky

**Endpoint:** `POST /api/invites/send`

**Autorizácia:**
- `coach` invite: len `club_admin`
- `assistant` invite: `club_admin` alebo `coach`
- `player` invite: `club_admin` alebo `coach`

**Request:**
```json
{
  "inviteType": "coach",
  "email": "novy.trener@email.cz",
  "clubId": 5,
  "teamId": 12,
  "metadata": {
    "position": "hlavný tréner",
    "note": "Špecializácia na prácu s mládežou"
  }
}
```

**Proces:**
1. Systém validuje oprávnenia
2. Vygeneruje jedinečný kód: `COACH_abc123xyz`
3. Nastaví expiráciu: **7 dní**
4. Uloží do `invites` tabuľky
5. Pošle email s:
   - Link na registráciu: `https://app.com/register?invite=COACH_abc123xyz`
   - Názov klubu
   - Meno pozývateľa
   - Informácie o role

---

### Získanie Detailov Pozvánky

**Endpoint:** `GET /api/invites/:inviteCode`

**Verejný endpoint** (bez autentifikácie)

**Response:**
```json
{
  "success": true,
  "invite": {
    "inviteType": "coach",
    "email": "novy.trener@email.cz",
    "clubName": "FC Slavia Praha",
    "clubId": 5,
    "teamName": "U15 chlapci",
    "inviterName": "Jan Novák",
    "expiresAt": "2025-03-05T12:00:00Z",
    "status": "pending"
  }
}
```

**Použitie:** Registračný formulár načíta details a **predvyplní** polia.

---

### Zrušenie Pozvánky

**Endpoint:** `DELETE /api/invites/:inviteId`

**Autorizácia:** Len ten, kto poslal pozvánku

---

## ✉️ Email Verifikácia

### Poslanie Verifikačného Emailu

Automaticky po registrácii:
- Club admin
- Súkromný tréner
- Samostatný rodič

**Email obsahuje:**
- Link: `https://app.com/verify-email?token=abc123xyz`
- Token expirácia: **24 hodín**

---

### Overenie Emailu

**Endpoint:** `POST /api/verification/verify-email`

**Request:**
```json
{
  "token": "abc123xyz789"
}
```

**Proces:**
1. Validácia tokenu a expirácie
2. `UPDATE users SET is_verified = TRUE`
3. Označenie tokenu ako použitý
4. Používateľ môže sa prihlásiť

---

### Znovu Poslanie Verifikácie

**Endpoint:** `POST /api/verification/resend-verification`

**Request:**
```json
{
  "email": "uzivatel@email.cz"
}
```

---

## 👶 COPPA Súhlas (Rodič)

### Súhlasový Email

Poslaný automaticky pri:
- Registrácii hráča < 16 rokov
- Konverzii virtuálneho hráča na skutočného (ak < 16)

**Email obsahuje:**
- Link: `https://app.com/parent-consent?token=xyz789`
- Informácie o dieťati
- Tlačidlá: **Udeliť súhlas** / **Zamietnuť**

---

### Udelenie Súhlasu

**Endpoint:** `POST /api/verification/verify-parent-consent`

**Request:**
```json
{
  "token": "xyz789abc",
  "consentGiven": true
}
```

**Proces ak `consentGiven=true`:**
1. Overí token
2. Aktivuje **všetky deti** rodiča (`is_active=TRUE`)
3. Nastaví `coppa_consent_given=TRUE`
4. Vytvorí záznam v `consent_records`

**Proces ak `consentGiven=false`:**
1. Deaktivuje deti (`is_active=FALSE`)
2. Zaznamená zamietnutie
3. Účty detí nefunkčné

---

## 🤝 Vzťahy Používateľov

### 1. Rodič ↔ Dieťa

**Tabuľka:** `parent_child_links`

**Vlastnosti:**
- Jeden rodič môže mať viacero detí
- Jedno dieťa môže mať viacerých rodičov
- Typy: `mother`, `father`, `guardian`, `other`
- Oprávnenia: `can_manage`, `can_view`

**Vytvorenie:**
Automaticky pri registrácii hráča < 16 rokov.

**API:**
```javascript
// Získať deti rodiča
GET /api/parents/:parentId/children

// Získať rodičov dieťaťa
GET /api/players/:playerId/parents
```

---

### 2. Súkromný Tréner ↔ Hráč

**Tabuľka:** `private_coach_players`

**Vlastnosti:**
- Súkromný tréner môže mať viacero hráčov
- Hráč môže mať viacero súkromných trénerov
- Poznámky trénera k hráčovi

**Pridanie Hráča:**

**Endpoint:** `POST /api/private-coaches/:coach /assign-player`

**Autorizácia:**
- Samotný hráč (ak ≥ 16)
- Rodič (ak hráč < 16)
- Tréner (ak má súhlas)

**Request:**
```json
{
  "playerId": 42
}
```

**Odstránenie:**
```
DELETE /api/private-coaches/:coachId/remove-player/:playerId
```

**Aktualizácia Poznámok:**
```
PATCH /api/private-coaches/:coachId/player/:playerId/notes
{
  "notes": "Dobrý pokrok v technike"
}
```

---

### 3. Tréner ↔ Asistent

**Tabuľka:** `coach_assistants`

**Vlastnosti:**
- Asistent pripojený k trénerovi
- Kontext: klub + voliteľne tím
- Oprávnenia:
  - `can_create_trainings`
  - `can_edit_trainings`
  - `can_view_analytics`

**Vytvorenie:**
Automaticky pri registrácii asistenta cez invite.

---

### 4. Klub ↔ Členovia

**Tabuľka:** `club_members`

**Vlastnosti:**
- Sleduje všetkých členov klubu
- Role: `club_admin`, `coach`, `assistant`, `player`
- Dátumy: `joined_at`, `left_at`
- Stav: `is_active`

**Automatické pridanie:**
- Club admin: pri vytvorení klubu
- Coach: pri registrácii cez invite
- Asistent: pri registrácii
- Hráč: pri pripojení k tímu klubu

---

## 🔒 Autentifikácia & Autorizácia

### Middleware

#### `authenticate`
Validuje JWT token a načíta používateľa z databázy.

```javascript
app.use('/api/teams', authenticate, teamsRoutes);
```

**Kontroly:**
- JWT token validný
- Používateľ existuje v DB
- Používateľ je aktívny (`is_active=TRUE`)

**Výsledok:**
`req.user` obsahuje:
```javascript
{
  id: 42,
  email: "user@email.cz",
  firstName: "Jan",
  lastName: "Novák",
  role: "coach",
  isVerified: true,
  isVirtual: false
}
```

---

#### `requireRole(['role1', 'role2'])`
Vyžaduje špecifickú rolu.

```javascript
router.post('/create', 
  authenticate, 
  requireRole(['club_admin', 'coach']), 
  createTraining
);
```

---

#### `requireClubAccess`
Overí, že používateľ patrí do klubu.

```javascript
router.get('/club/:clubId/teams', 
  authenticate, 
  requireClubAccess, 
  getClubTeams
);
```

Kontrola v `club_members` tabuľke.

---

#### `requireClubAdmin`
Overí, že používateľ je admin daného klubu.

```javascript
router.delete('/club/:clubId', 
  authenticate, 
  requireClubAdmin, 
  deleteClub
);
```

---

## 📊 Databázová Schéma

### Rozšírená `users` Tabuľka

```sql
ALTER TABLE users 
  MODIFY COLUMN role ENUM(
    'admin', 
    'club_admin', 
    'coach', 
    'assistant', 
    'player', 
    'parent', 
    'private_coach'
  ),
  ADD COLUMN is_virtual BOOLEAN DEFAULT FALSE,
  ADD COLUMN parent_id INT NULL,
  ADD COLUMN age_verified_at DATETIME NULL,
  ADD COLUMN coppa_consent_given BOOLEAN DEFAULT FALSE;
```

### Nové Tabuľky

1. **parent_child_links** - Rodič-dieťa vzťahy
2. **private_coach_players** - Súkromný tréner-hráč
3. **invites** - Pozvánky s expiráciou
4. **consent_records** - COPPA/GDPR súhlasy
5. **coach_assistants** - Tréner-asistent vzťahy
6. **club_members** - Evidence členov klubu
7. **email_verifications** - Verifikačné tokeny
8. **password_resets** - Reset hesla tokeny

---

## 🚀 Nasadenie & Migrácia

### Spustenie Migrácie

**Endpoint:** `POST /api/migrate/run`

**Autorizácia:** `X-Migration-Token` header

**Request:**
```bash
curl -X POST https://api.sportsclub.com/api/migrate/run \
  -H "X-Migration-Token: SECRET_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"migrationFile": "20260226_registration_system.sql"}'
```

**Token nastavenie:**
```bash
# Railway environment variables
MIGRATION_TOKEN=your-secret-migration-token-here
```

---

### Kontrola Stavu Migrácie

**Endpoint:** `GET /api/migrate/status`

**Response:**
```json
{
  "success": true,
  "tables": {
    "users": "exists",
    "clubs": "exists",
    "parent_child_links": "exists",
    "private_coach_players": "exists",
    "invites": "exists",
    "consent_records": "exists",
    "coach_assistants": "exists",
    "club_members": "exists",
    "email_verifications": "exists",
    "password_resets": "exists"
  }
}
```

---

### Zoznam Migrácií

**Endpoint:** `GET /api/migrate/list`

**Response:**
```json
{
  "success": true,
  "migrations": [
    "20260202_001_create_exercise_module.sql",
    "20260226_registration_system.sql"
  ]
}
```

---

## 🧪 Testovanie

### Test Registračného Toku

```bash
# 1. Registrácia club admina
curl -X POST http://localhost:3000/api/registration/register-club \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Test",
    "lastName": "Admin",
    "email": "admin@test.cz",
    "password": "Test123!",
    "clubName": "Test Club"
  }'

# 2. Poslanie pozvánky trénerovi
curl -X POST http://localhost:3000/api/invites/send \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "inviteType": "coach",
    "email": "coach@test.cz",
    "clubId": 1
  }'

# 3. Získanie detailov pozvánky
curl http://localhost:3000/api/invites/COACH_abc123

# 4. Registrácia trénera
curl -X POST http://localhost:3000/api/registration/register-coach \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Test",
    "lastName": "Coach",
    "email": "coach@test.cz",
    "password": "Coach123!",
    "inviteCode": "COACH_abc123"
  }'
```

---

## 📧 Email Šablóny

### Konfigurácia Email Service

```javascript
// services/email.service.js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function sendEmail(to, subject, html) {
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    html
  });
}
```

### Environment Variables

```bash
# .env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=noreply@sportsclub.com
SMTP_PASS=your-app-password
SMTP_FROM="Sports Club <noreply@sportsclub.com>"
FRONTEND_URL=https://app.sportsclub.com
```

---

## 🎨 Frontend Integrácia

### TypeScript Typy

```typescript
import {
  UserRole,
  ClubRegistrationData,
  CoachRegistrationData,
  PlayerRegistrationData,
  VirtualPlayerData,
  canCreateTraining,
  requiresParentConsent,
  calculateAge
} from '@/types/registration';

// Použitie
const age = calculateAge('2010-05-15'); // 14
const needsParent = requiresParentConsent('2010-05-15'); // true
```

### API Klienti

```typescript
// api/registration.ts
export async function registerClub(data: ClubRegistrationData) {
  const response = await fetch('/api/registration/register-club', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return response.json();
}

export async function registerCoach(data: CoachRegistrationData) {
  // ...
}

export async function createVirtualPlayer(data: VirtualPlayerData, token: string) {
  const response = await fetch('/api/virtual-players/create-virtual', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(data)
  });
  return response.json();
}
```

---

## ⚠️ Bezpečnostné Požiadavky

### Hesla
- Min. 8 znakov
- Obsahuje veľké, malé písmeno, číslo, špec. znak
- Hash: bcrypt (12 roundov)

### JWT Tokeny
- HS256 algoritmus
- Expirácia: 7 dní (access token)
- Refresh token: 30 dní

### Email Tokeny
- 64 znakov náhodný string
- Expirácia: 24 hodín
- Jednorazové použitie

### Invite Kódy
- Formát: `TYPE_randomString`
- Expirácia: 7 dní
- Validácia email domény

### COPPA Compliance
- Vek < 16: povinný rodič
- Parent consent záznam
- IP adresa + User agent
- Verzia súhlasu

---

## 📈 Štatistiky & Monitoring

### Endpoint Pre Admina

```javascript
GET /api/admin/stats

Response:
{
  "totalUsers": 1245,
  "byRole": {
    "club_admin": 45,
    "coach": 120,
    "assistant": 80,
    "player": 950,
    "parent": 450,
    "private_coach": 25
  },
  "virtualPlayers": 180,
  "pendingInvites": 35,
  "verifiedUsers": 1100,
  "coppaConsents": 420
}
```

---

## 🆘 Riešenie Problémov

### Registrácia Zlyhala

1. Skontroluj, či email už neexistuje
2. Validuj formát emailu
3. Skontroluj silu hesla
4. Overenie invite kódu (ak potrebné)
5. Skontroluj databázové logy

### Email Sa Neposlal

1. Skontroluj SMTP credentials
2. Overte email service status
3. Skontroluj spam priečinok
4. Znovu poslať: `POST /api/verification/resend-verification`

### Virtuálny Hráč Konverzia Zlyhala

1. Overte, že hráč je `is_virtual=TRUE`
2. Skontrolujte email rodiča (nesmie existovať)
3. Validujte oprávnenia (len tréner/club_admin)
4. Skontrolujte databázové constraints

### COPPA Súhlas Chýba

1. Skontrolujte vek hráča
2. Overite rodičov email
3. Skontrolujte `consent_records` tabuľku
4. Znovu poslať súhlasový email

---

## 📚 Príklady Použitia

### Scenár 1: Založenie Nového Klubu

1. **Club admin sa registruje**
   ```bash
   POST /api/registration/register-club
   ```

2. **Overí email**
   ```bash
   POST /api/verification/verify-email
   {token: "xyz"}
   ```

3. **Prihlási sa**
   ```bash
   POST /api/auth/login
   ```

4. **Vytvorí tím**
   ```bash
   POST /api/teams
   ```

5. **Pozve trénera**
   ```bash
   POST /api/invites/send
   {inviteType: "coach", email: "coach@..."}
   ```

6. **Rýchlo vytvoriť 11 virtuálnych hráčov**
   ```bash
   for (let i = 1; i <= 11; i++) {
     POST /api/virtual-players/create-virtual
     {firstName: "Hráč", lastName: `${i}`, teamId: 1}
   }
   ```

---

### Scenár 2: Konverzia Virtuálneho Hráča

1. **Tréner má virtuálneho hráča**
   ```
   Virtual Player ID: 99
   Email: virtual_abc123@sportsclub.local
   ```

2. **Tréner spustí konverziu**
   ```bash
   POST /api/virtual-players/99/convert-to-real
   {
     playerEmail: "hrac@email.cz",
     parentEmail: "rodic@email.cz",
     parentFirstName: "Anna",
     parentLastName: "Nová"
   }
   ```

3. **Systém:**
   - Vytvorí rodiča
   - Pošle invite email rodičovi
   - Nastaví `is_virtual=FALSE`, `parent_id=X`

4. **Rodič klikne na link:**
   - Nastaví heslo pre hráča
   - Udelí COPPA súhlas
   - Hráč aktivovaný, **všetky dáta zachované**

---

### Scenár 3: Súkromný Tréner + Hráč

1. **Tréner sa registruje ako súkromný**
   ```bash
   POST /api/registration/register-private-coach
   ```

2. **Hráč sa registruje samostatne**
   ```bash
   POST /api/registration/register-player
   # (vek ≥ 16, bez rodiča)
   ```

3. **Hráč priradí seba k súkromnému trénerovi**
   ```bash
   POST /api/private-coaches/5/assign-player
   {playerId: 42}
   # Authorization: Bearer <PLAYER_JWT>
   ```

4. **Tréner vytvára súkromné tréningy**
   ```bash
   POST /api/trainings
   {
     coachId: 5,
     players: [42],
     isPrivate: true
   }
   ```

---

## 🔗 Súvisiace Dokumenty

- [API Endpoints Full Reference](./API_ENDPOINTS.md)
- [Database Schema](./DATABASE_SCHEMA.md)
- [Email Templates](./EMAIL_TEMPLATES.md)
- [Frontend Components Guide](./FRONTEND_GUIDE.md)
- [Security Best Practices](./SECURITY.md)
- [Testing Guide](./TESTING.md)

---

## ✅ Checklist Pre Production

- [ ] Spustená migrácia databázy
- [ ] SMTP email service nakonfigurovaný
- [ ] Environment variables nastavené (Railway)
- [ ] `MIGRATION_TOKEN` tajný
- [ ] JWT secret náhodný (64+ znakov)
- [ ] CORS správne nastavené
- [ ] HTTPS enforced
- [ ] Rate limiting aktivované
- [ ] Error logging (Sentry?)
- [ ] Monitoring (Railway metrics)
- [ ] Backup databázy nastavený

---

**Vytvorené:** 26. februára 2025  
**Verzia:** 1.0.0  
**Autor:** GitHub Copilot + Patrik  
**License:** MIT
