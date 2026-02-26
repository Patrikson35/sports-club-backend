# 🚀 QUICK START - Registračný Systém

## ⚡ Rýchle Nasadenie (3 kroky)

### 1️⃣ Spustiť Databázovú Migráciu

**Railway Dashboard:**
1. Prejdi na Railway projekt
2. Nastav environment variable:
   ```
   MIGRATION_TOKEN=tajny-token-pre-migraciu-xyz123
   ```
3. Po deployi spusti migráciu:

```bash
curl -X POST https://outstanding-blessing-production-2cba.up.railway.app/api/migrate/run \
  -H "X-Migration-Token: tajny-token-pre-migraciu-xyz123" \
  -H "Content-Type: application/json" \
  -d '{"migrationFile": "20260226_registration_system.sql"}'
```

**Overenie:**
```bash
curl https://outstanding-blessing-production-2cba.up.railway.app/api/migrate/status
```

Očakávaný výsledok:
```json
{
  "success": true,
  "tables": {
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

### 2️⃣ Nakonfigurovať Email Service

**Railway Environment Variables:**
```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=noreply@sportsclub.com
SMTP_PASS=your-app-specific-password
SMTP_FROM="Sports Club <noreply@sportsclub.com>"
FRONTEND_URL=https://sports-club-web-admin-production.up.railway.app
```

**Gmail App Password:**
1. Prejdi na [Google Account Security](https://myaccount.google.com/security)
2. Enable 2-Step Verification
3. Vytvor App Password pre "Mail"
4. Skopíruj heslo do `SMTP_PASS`

**Alternatíva:** SendGrid, Mailgun, AWS SES

---

### 3️⃣ Testovať Registráciu

**Základný test:**
```bash
# 1. Registruj club admina
curl -X POST https://outstanding-blessing-production-2cba.up.railway.app/api/registration/register-club \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Test",
    "lastName": "Admin",
    "email": "test@example.com",
    "password": "Test123!",
    "clubName": "Test Club",
    "clubCity": "Praha"
  }'

# 2. Skontroluj email inbox
# 3. Klikni na verification link
# 4. Prihlás sa
```

---

## 📋 Environment Variables Checklist

```bash
# Backend API (Railway)
NODE_ENV=production
PORT=3000

# Database (Railway MySQL)
DB_HOST=metro.proxy.rlwy.net
DB_PORT=25931
DB_USER=root
DB_PASSWORD=<railway-generated>
DB_NAME=railway

# JWT
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
MIGRATION_TOKEN=<secret-token-for-migrations>

# Security
BCRYPT_ROUNDS=12
AGE_CONSENT_THRESHOLD=16
AGE_COPPA_THRESHOLD=13
```

---

## 🧪 Testovanie Všetkých Registrácií

### Test 1: Club Admin Registrácia
```bash
POST /api/registration/register-club
{
  "firstName": "Jan",
  "lastName": "Novák",
  "email": "jan@email.cz",
  "password": "Heslo123!",
  "clubName": "FC Test",
  "clubCity": "Praha"
}
```

**Očakávaný výsledok:**
- ✅ Status 201
- ✅ User vytvorený (role: `club_admin`)
- ✅ Club vytvorený
- ✅ Verifikačný email poslaný

---

### Test 2: Pozvať Trénera
```bash
# Najprv sa prihlás ako club admin
POST /api/auth/login
{
  "email": "jan@email.cz",
  "password": "Heslo123!"
}

# Získaj JWT token z response

# Pošli pozvánku
POST /api/invites/send
Headers: Authorization: Bearer <JWT>
{
  "inviteType": "coach",
  "email": "trener@email.cz",
  "clubId": 1
}
```

**Očakávaný výsledok:**
- ✅ Invite vytvorený
- ✅ Email s invite linkom poslaný
- ✅ Invite code: `COACH_abc123xyz`

---

### Test 3: Tréner Akceptuje Pozvánku
```bash
# Získaj details pozvánky (bez autentifikácie)
GET /api/invites/COACH_abc123xyz

# Registruj sa s invite code
POST /api/registration/register-coach
{
  "firstName": "Pavel",
  "lastName": "Svoboda",
  "email": "trener@email.cz",
  "password": "CoachPass123!",
  "inviteCode": "COACH_abc123xyz"
}
```

**Očakávaný výsledok:**
- ✅ Coach vytvorený
- ✅ Pridaný do `club_members`
- ✅ Invite označený ako `accepted`

---

### Test 4: Vytvorenie Virtuálneho Hráča
```bash
POST /api/virtual-players/create-virtual
Headers: Authorization: Bearer <COACH_JWT>
{
  "firstName": "Virtuálny",
  "lastName": "Hráč",
  "teamId": 1,
  "dateOfBirth": "2010-05-15"
}
```

**Očakávaný výsledok:**
- ✅ Virtual player vytvorený
- ✅ Email: `virtual_abc123@sportsclub.local`
- ✅ `is_virtual=TRUE`
- ✅ Môže byť pridaný do tímu

---

### Test 5: Konverzia Virtuálneho → Skutočný
```bash
POST /api/virtual-players/99/convert-to-real
Headers: Authorization: Bearer <COACH_JWT>
{
  "playerEmail": "hrac@email.cz",
  "parentEmail": "rodic@email.cz",
  "parentFirstName": "Anna",
  "parentLastName": "Nová"
}
```

**Očakávaný výsledok:**
- ✅ Rodič vytvorený
- ✅ Hráč: `is_virtual=FALSE`, `parent_id` nastavené
- ✅ Email rodičovi s COPPA súhlasom poslaný
- ✅ Všetky dáta hráča zachované

---

### Test 6: Rodič Udelí COPPA Súhlas
```bash
POST /api/verification/verify-parent-consent
{
  "token": "parent_consent_xyz789",
  "consentGiven": true
}
```

**Očakávaný výsledok:**
- ✅ Hráč aktivovaný (`is_active=TRUE`)
- ✅ `coppa_consent_given=TRUE`
- ✅ Záznam v `consent_records`
- ✅ Hráč sa môže prihlásiť

---

## 🔍 Diagnostika Problémov

### Migrácia Zlyhala

**Príčiny:**
1. Tabulka už existuje → **OK** (skip)
2. Foreign key constraint → skontroluj `users` a `clubs` tabuľky
3. Syntax error → zkontroluj MySQL verziu (potrebné 5.7+)

**Riešenie:**
```bash
# Získaj detailný error
curl -X POST .../api/migrate/run \
  -H "X-Migration-Token: ..." \
  -d '{"migrationFile": "20260226_registration_system.sql"}'

# Skontroluj ktorá tabuľka chýba
curl .../api/migrate/status
```

---

### Email Sa Neposlal

**Kontroly:**
1. SMTP credentials správne?
   ```bash
   # Test SMTP connection
   telnet smtp.gmail.com 587
   ```

2. Gmail App Password nastavené?
3. "Less secure apps" povolené? (Gmail)
4. Firewall/Port 587 otvorený?

**Debug logging:**
```javascript
// services/email.service.js
transporter.verify((error, success) => {
  if (error) {
    console.error('SMTP Error:', error);
  } else {
    console.log('✅ SMTP Ready');
  }
});
```

---

### Registrácia Vracia 500 Error

**Kroky:**
1. Skontroluj Railway logs:
   ```
   Railway Dashboard → Backend Service → Deployments → Logs
   ```

2. Hľadaj error stack trace

3. Časté príčiny:
   - Database connection timeout
   - Missing environment variable
   - Email service error
   - Foreign key constraint

**Fix:**
- Pridaj `try-catch` logging
- Skontroluj databázové connection pooling
- Zvýš timeout: `DB_TIMEOUT=30000`

---

### JWT Token Invalid

**Príčiny:**
1. Token expirovaný (7 dní)
2. JWT_SECRET sa zmenil
3. User neexistuje v DB
4. User deaktivovaný

**Riešenie:**
```bash
# Prihlás sa znovu
POST /api/auth/login
{
  "email": "user@email.cz",
  "password": "heslo"
}

# Získaj nový token
```

---

## 📊 Production Monitoring

### Health Check
```bash
curl https://outstanding-blessing-production-2cba.up.railway.app/health
```

**Response:**
```json
{
  "status": "OK",
  "timestamp": "2025-02-26T10:30:00Z",
  "environment": "production"
}
```

---

### Database Status
```bash
curl https://outstanding-blessing-production-2cba.up.railway.app/api/migrate/status
```

---

### Štatistiky (Admin Only)
```bash
curl https://.../api/admin/stats \
  -H "Authorization: Bearer <ADMIN_JWT>"
```

---

## 🔒 Bezpečnosť

### Kritické Nastavenia

1. **MIGRATION_TOKEN** - nikdy nezdieľať!
2. **JWT_SECRET** - min. 64 znakov, náhodný
3. **SMTP_PASS** -App password, nie hlavné heslo
4. **CORS_ORIGIN** - špecifická doména, nie `*`

### Rate Limiting (TODO)
```javascript
// middleware/rateLimiter.js
const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minút
  max: 5, // 5 pokusov
  message: 'Príliš veľa pokusov, skúste neskôr'
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
```

---

## 📚 Ďalšie Kroky

1. **Spustiť migráciu** ✅
2. **Nakonfigurovať email** ✅
3. **Testovať všetky registrácie** ✅
4. **Implementovať frontend UI:**
   - Registračné formuláre pre každú rolu
   - Invite acceptance page
   - Email verification page
   - Parent consent page
   - Virtual player management
5. **Nastaviť monitoring:**
   - Railway metrics
   - Error tracking (Sentry?)
   - Email delivery logs
6. **Security audit:**
   - Rate limiting
   - CSRF protection
   - Input sanitization
7. **Dokumentácia pre používateľov**
8. **Load testing**

---

## 🆘 Potrebuješ Pomoc?

**Dokumentácia:**
- [Úplná dokumentácia](./REGISTRATION_SYSTEM_DOCS.md)
- [API Endpoints](./API_ENDPOINTS.md)
- [Database Schema](./DATABASE_SCHEMA.md)

**Kontakt:**
- GitHub Issues
- Email: support@sportsclub.com

---

**Poskladované:** 26. februára 2025  
**Railway Backend:** https://outstanding-blessing-production-2cba.up.railway.app  
**Web Admin:** https://sports-club-web-admin-production.up.railway.app
