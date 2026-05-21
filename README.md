# ScholarPath v2 — Full Stack Setup Guide

## What's included
- ✅ Login / Register with email verification
- ✅ Forgot password → Gmail reset link
- ✅ Sign in with Google (OAuth)
- ✅ Comment section on every scholarship
- ✅ User profile with major, degree, country, GPA, interests
- ✅ Auto-rolling deadlines (no manual year updates ever)
- ✅ Live scraping from Opportunity Desk + Scholars4Dev
- ✅ 25 curated scholarships with real links
- ✅ AI search via Groq (free)
- ✅ Bookmarks, compare, deadlines tracker

---

## 1. Install dependencies

```bash
cd backend
npm install
```

---

## 2. Configure .env

```bash
cp .env.example .env
```

Edit `.env` and fill in:

### Gmail (for email verification + password reset)
1. Go to [myaccount.google.com](https://myaccount.google.com)
2. Security → 2-Step Verification → **App Passwords**
3. Select "Mail" + "Other" → name it "ScholarPath" → copy the 16-char password
4. Set `GMAIL_USER=yourname@gmail.com` and `GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx`

### Groq API (free AI search)
1. Go to [console.groq.com](https://console.groq.com)
2. Sign up → API Keys → Create Key
3. Set `GROQ_API_KEY=gsk_...`

### Google OAuth (Sign in with Google)
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project → APIs & Services → Credentials
3. **OAuth 2.0 Client ID** → Web Application
4. Authorized JavaScript origins: `http://localhost:3000`
5. Copy the Client ID → set `GOOGLE_CLIENT_ID=...` in `.env`
6. Also paste it into `frontend/index.html` where it says `__GOOGLE_CLIENT_ID__`

### JWT Secret
Generate a strong random secret:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```
Set as `JWT_SECRET=...`

---

## 3. Run

```bash
node server.js
# or for auto-reload:
npx nodemon server.js
```

Open **http://localhost:3000**

---

## 4. Deploy to Render.com

1. Push all files to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your repo
4. Settings:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
5. Add all your `.env` values under **Environment**
6. Update `FRONTEND_URL` to your Render URL (e.g. `https://scholarpath.onrender.com`)
7. Update `GOOGLE_CLIENT_ID` in `frontend/index.html` and re-deploy

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | No | Create account |
| GET  | `/api/auth/verify-email?token=` | No | Verify email |
| POST | `/api/auth/login` | No | Login |
| POST | `/api/auth/forgot-password` | No | Send reset email |
| POST | `/api/auth/reset-password` | No | Reset password |
| POST | `/api/auth/google` | No | Google OAuth |
| GET  | `/api/auth/me` | Yes | Get current user |
| GET  | `/api/profile` | Yes | Get profile |
| PUT  | `/api/profile` | Yes | Update profile |
| GET  | `/api/comments/:scholarshipId` | Optional | Get comments |
| POST | `/api/comments/:scholarshipId` | Yes | Post comment |
| DELETE | `/api/comments/:commentId` | Yes | Delete comment |
| GET  | `/api/scholarships` | No | List scholarships |
| GET  | `/api/scholarships/:id` | No | Single scholarship |
| GET  | `/api/deadlines` | No | Sorted deadlines |
| GET  | `/api/live` | No | Live scraped listings |
| GET  | `/api/year` | No | Current year window |
| GET  | `/api/sources` | No | Scholarship websites |
| POST | `/api/search` | No | AI search (Groq) |

---

## Notes

- **Database:** Currently in-memory. Data resets on server restart.
  For production, replace with MongoDB (`mongoose`) or PostgreSQL (`pg`/`prisma`).
- **Render free tier:** Spins down after 15 min idle — first request takes ~30s to wake up.
- **Email:** Gmail App Passwords work without any paid plan.
