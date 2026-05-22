/**
 * ScholarPath Backend — server.js
 * ─────────────────────────────────────────────────────────────────
 * Features:
 *   • JWT Auth (register, login, Google OAuth)
 *   • Email verification on signup (Gmail SMTP)
 *   • Forgot password → reset link via Gmail
 *   • User profiles with study preferences
 *   • Comments on scholarships
 *   • Scholarship data with auto-rolling deadlines/years
 *   • Live scraping from scholarship websites (hourly cache)
 *   • Groq AI-powered search (free)
 * ─────────────────────────────────────────────────────────────────
 * SETUP:
 *   npm install
 *   cp .env.example .env   (fill in values)
 *   node server.js
 * ─────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const nodemailer   = require('nodemailer');
const axios        = require('axios');
const cheerio      = require('cheerio');
const cron         = require('node-cron');
const path         = require('path');
const crypto       = require('crypto');
const { v4: uuid } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// ─── File-Persisted DB (survives server restarts) ────────────────
const fs   = require('fs');
const DB_FILE = path.join(__dirname, 'db.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) { console.warn('[db] Failed to load db.json:', e.message); }
  return { users: [], profiles: [], comments: [] };
}

function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.warn('[db] Failed to save db.json:', e.message); }
}

const db = loadDB();
// Ensure all collections exist (in case db.json is old format)
if (!db.users)    db.users    = [];
if (!db.profiles) db.profiles = [];
if (!db.comments) db.comments = [];
console.log(`[db] Loaded ${db.users.length} users, ${db.comments.length} comments`);

// ─── JWT Helpers ─────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'scholarpath_secret_change_in_production';

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.replace('Bearer ', '');
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.userId = decoded.userId;
    } catch (_) {}
  }
  next();
}

// ─── Email (Gmail SMTP) ───────────────────────────────────────────
function createTransporter() {
  return nodemailer.createTransport({
    service : 'gmail',
    auth    : {
      user : process.env.GMAIL_USER,
      pass : process.env.GMAIL_APP_PASSWORD, // Google App Password (not your real password)
    },
  });
}

async function sendVerificationEmail(email, name, token) {
  const link = `${process.env.FRONTEND_URL || `http://localhost:${PORT}`}/?verify=${token}`;
  const transporter = createTransporter();
  await transporter.sendMail({
    from    : `"ScholarPath" <${process.env.GMAIL_USER}>`,
    to      : email,
    subject : '✉️ Verify your ScholarPath account',
    html    : `
      <div style="font-family:'Segoe UI',sans-serif;max-width:520px;margin:auto;background:#0a1628;color:#fff;border-radius:16px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#0f2040,#162a52);padding:32px 32px 24px;text-align:center">
          <div style="width:48px;height:48px;background:#f6c90e;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px">
            <span style="font-size:24px">🎓</span>
          </div>
          <h1 style="margin:0;font-size:24px;font-weight:700;letter-spacing:-0.5px">ScholarPath</h1>
        </div>
        <div style="padding:32px">
          <h2 style="margin:0 0 12px;font-size:20px">Hi ${name}! 👋</h2>
          <p style="color:#8fa3af;margin:0 0 24px;line-height:1.6">
            Thanks for joining ScholarPath. Click the button below to verify your email address and activate your account.
          </p>
          <a href="${link}" style="display:inline-block;background:#f6c90e;color:#050c1a;font-weight:700;padding:14px 28px;border-radius:10px;text-decoration:none;font-size:15px">
            Verify Email Address →
          </a>
          <p style="color:#607d8b;font-size:12px;margin-top:24px">
            This link expires in 24 hours. If you didn't create an account, ignore this email.
          </p>
        </div>
      </div>`,
  });
}

async function sendPasswordResetEmail(email, name, token) {
  const link = `${process.env.FRONTEND_URL || `http://localhost:${PORT}`}/?reset=${token}`;
  const transporter = createTransporter();
  await transporter.sendMail({
    from    : `"ScholarPath" <${process.env.GMAIL_USER}>`,
    to      : email,
    subject : '🔐 Reset your ScholarPath password',
    html    : `
      <div style="font-family:'Segoe UI',sans-serif;max-width:520px;margin:auto;background:#0a1628;color:#fff;border-radius:16px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#0f2040,#162a52);padding:32px 32px 24px;text-align:center">
          <div style="width:48px;height:48px;background:#f6c90e;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px">
            <span style="font-size:24px">🔐</span>
          </div>
          <h1 style="margin:0;font-size:24px;font-weight:700">ScholarPath</h1>
        </div>
        <div style="padding:32px">
          <h2 style="margin:0 0 12px;font-size:20px">Password Reset Request</h2>
          <p style="color:#8fa3af;margin:0 0 24px;line-height:1.6">
            Hi ${name}, we received a request to reset your password. Click below to choose a new one.
          </p>
          <a href="${link}" style="display:inline-block;background:#f6c90e;color:#050c1a;font-weight:700;padding:14px 28px;border-radius:10px;text-decoration:none;font-size:15px">
            Reset Password →
          </a>
          <p style="color:#607d8b;font-size:12px;margin-top:24px">
            This link expires in 1 hour. If you didn't request this, ignore this email.
          </p>
        </div>
      </div>`,
  });
}

// ─── AUTH ROUTES ─────────────────────────────────────────────────

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email and password required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = db.users.find(u => u.email === email.toLowerCase());
    if (existing) {
      // If unverified, allow re-registration and resend the email
      if (!existing.verified) {
        existing.name        = name.trim();
        existing.password    = await bcrypt.hash(password, 12);
        existing.verifyToken = crypto.randomBytes(32).toString('hex');
        try { await sendVerificationEmail(existing.email, existing.name, existing.verifyToken); }
        catch (e) { console.warn('[email] resend failed:', e.message); }
        return res.status(201).json({ message: 'Account pending verification — we resent the confirmation email. Check your inbox!' });
      }
      return res.status(409).json({ error: 'Email already registered. Try logging in instead.' });
    }

    const hashed     = await bcrypt.hash(password, 12);
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const user = {
      id          : uuid(),
      name        : name.trim(),
      email       : email.toLowerCase().trim(),
      password    : hashed,
      verified    : false,
      verifyToken,
      resetToken  : null,
      resetExpiry : null,
      googleId    : null,
      createdAt   : new Date().toISOString(),
    };
    db.users.push(user);

    // Create empty profile
    db.profiles.push({ userId: user.id, major: '', degreeLevel: '', country: '', gpa: '', interests: [], bio: '', avatar: '' });
    saveDB();

    // Send verification email
    try {
      await sendVerificationEmail(user.email, user.name, verifyToken);
    } catch (emailErr) {
      console.warn('[email] Failed to send verification:', emailErr.message);
    }

    res.status(201).json({ message: 'Account created! Check your email to verify.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/verify-email?token=...
app.get('/api/auth/verify-email', (req, res) => {
  const { token } = req.query;
  const user = db.users.find(u => u.verifyToken === token);
  if (!user) return res.status(400).json({ error: 'Invalid or expired verification link' });
  user.verified    = true;
  user.verifyToken = null;
  saveDB();
  const jwtToken   = signToken(user.id);
  res.json({ message: 'Email verified!', token: jwtToken, user: sanitizeUser(user) });
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = db.users.find(u => u.email === email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    if (!user.verified) return res.status(403).json({ error: 'Please verify your email first' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    const token = signToken(user.id);
    res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/forgot-password
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  const user = db.users.find(u => u.email === email?.toLowerCase());
  // Always return success to prevent email enumeration
  if (user) {
    user.resetToken  = crypto.randomBytes(32).toString('hex');
    user.resetExpiry = Date.now() + 3600000; // 1 hour
    saveDB();
    try {
      await sendPasswordResetEmail(user.email, user.name, user.resetToken);
    } catch (e) {
      console.warn('[email] Reset email failed:', e.message);
    }
  }
  res.json({ message: 'If that email exists, a reset link has been sent.' });
});

// POST /api/auth/reset-password
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const user = db.users.find(u => u.resetToken === token && u.resetExpiry > Date.now());
  if (!user) return res.status(400).json({ error: 'Invalid or expired reset link' });

  user.password    = await bcrypt.hash(password, 12);
  user.resetToken  = null;
  user.resetExpiry = null;
  saveDB();
  res.json({ message: 'Password reset successfully! You can now log in.' });
});

// POST /api/auth/google  (receives Google ID token from frontend)
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body; // Google JWT credential
    if (!credential) return res.status(400).json({ error: 'No credential provided' });

    // Decode Google JWT (verify with Google in production)
    const parts   = credential.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const { sub: googleId, email, name, picture } = payload;

    let user = db.users.find(u => u.googleId === googleId || u.email === email);
    if (!user) {
      user = {
        id          : uuid(),
        name        : name || email,
        email       : email.toLowerCase(),
        password    : null,
        verified    : true,
        verifyToken : null,
        resetToken  : null,
        resetExpiry : null,
        googleId,
        createdAt   : new Date().toISOString(),
      };
      db.users.push(user);
      db.profiles.push({ userId: user.id, major: '', degreeLevel: '', country: '', gpa: '', interests: [], bio: '', avatar: picture || '' });
      saveDB();
    } else {
      if (!user.googleId) user.googleId = googleId;
      user.verified = true;
    }

    const token = signToken(user.id);
    res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    console.error('[google auth]', err.message);
    res.status(500).json({ error: 'Google sign-in failed' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: sanitizeUser(user) });
});

function sanitizeUser(user) {
  const { password, verifyToken, resetToken, resetExpiry, ...safe } = user;
  return safe;
}

// ─── PROFILE ROUTES ───────────────────────────────────────────────

// GET /api/profile
app.get('/api/profile', authMiddleware, (req, res) => {
  let profile = db.profiles.find(p => p.userId === req.userId);
  if (!profile) {
    profile = { userId: req.userId, major: '', degreeLevel: '', country: '', gpa: '', interests: [], bio: '', avatar: '' };
    db.profiles.push(profile);
  }
  const user = db.users.find(u => u.id === req.userId);
  res.json({ profile, user: sanitizeUser(user) });
});

// PUT /api/profile
app.put('/api/profile', authMiddleware, (req, res) => {
  let profile = db.profiles.find(p => p.userId === req.userId);
  if (!profile) {
    profile = { userId: req.userId };
    db.profiles.push(profile);
  }
  const { major, degreeLevel, country, gpa, interests, bio, avatar } = req.body;
  if (major       !== undefined) profile.major       = major;
  if (degreeLevel !== undefined) profile.degreeLevel = degreeLevel;
  if (country     !== undefined) profile.country     = country;
  if (gpa         !== undefined) profile.gpa         = gpa;
  if (interests   !== undefined) profile.interests   = interests;
  if (bio         !== undefined) profile.bio         = bio;
  if (avatar      !== undefined) profile.avatar      = avatar;

  // Update name in user record
  if (req.body.name) {
    const user = db.users.find(u => u.id === req.userId);
    if (user) user.name = req.body.name;
  }

  saveDB();
  res.json({ profile, message: 'Profile updated!' });
});

// ─── COMMENT ROUTES ───────────────────────────────────────────────

// GET /api/comments/:scholarshipId
app.get('/api/comments/:scholarshipId', optionalAuth, (req, res) => {
  const { scholarshipId } = req.params;
  const comments = db.comments
    .filter(c => c.scholarshipId === scholarshipId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(c => {
      const user    = db.users.find(u => u.id === c.userId);
      const profile = db.profiles.find(p => p.userId === c.userId);
      return {
        ...c,
        author : user ? user.name : 'Anonymous',
        avatar : profile?.avatar || '',
        isOwn  : req.userId ? c.userId === req.userId : false,
      };
    });
  res.json(comments);
});

// POST /api/comments/:scholarshipId
app.post('/api/comments/:scholarshipId', authMiddleware, (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Comment text required' });
  if (text.length > 1000) return res.status(400).json({ error: 'Comment too long (max 1000 chars)' });

  const comment = {
    id            : uuid(),
    scholarshipId : req.params.scholarshipId,
    userId        : req.userId,
    text          : text.trim(),
    createdAt     : new Date().toISOString(),
    edited        : false,
  };
  db.comments.push(comment);
  saveDB();

  const user    = db.users.find(u => u.id === req.userId);
  const profile = db.profiles.find(p => p.userId === req.userId);
  res.status(201).json({ ...comment, author: user?.name || 'Anonymous', avatar: profile?.avatar || '', isOwn: true });
});

// DELETE /api/comments/:commentId
app.delete('/api/comments/:commentId', authMiddleware, (req, res) => {
  const idx = db.comments.findIndex(c => c.id === req.params.commentId && c.userId === req.userId);
  if (idx === -1) return res.status(404).json({ error: 'Comment not found or not yours' });
  db.comments.splice(idx, 1);
  saveDB();
  res.json({ message: 'Comment deleted' });
});

// PUT /api/comments/:commentId
app.put('/api/comments/:commentId', authMiddleware, (req, res) => {
  const comment = db.comments.find(c => c.id === req.params.commentId && c.userId === req.userId);
  if (!comment) return res.status(404).json({ error: 'Comment not found or not yours' });
  if (!req.body.text?.trim()) return res.status(400).json({ error: 'Text required' });
  comment.text   = req.body.text.trim();
  comment.edited = true;
  saveDB();
  res.json(comment);
});

// ─── AUTO-ROLLING YEAR LOGIC ──────────────────────────────────────
function getActiveYearWindow() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth();
  const offset = month >= 9 ? 1 : 0;
  return { yearFrom: year + offset, yearTo: year + offset + 3, current: year };
}

function rollDeadline(deadlineTemplate) {
  const now      = new Date();
  const thisYear = now.getFullYear();
  const date     = new Date(`${thisYear}-${deadlineTemplate}`);
  if (date < now) date.setFullYear(thisYear + 1);
  return date.toISOString().split('T')[0];
}

// ─── SCHOLARSHIP DATA ─────────────────────────────────────────────
const BASE_SCHOLARSHIPS = [
  { id:1,  name:"Fulbright Foreign Student Program",        org:"U.S. Department of State",             country:"USA",         flag:"🇺🇸", level:"Postgraduate", field:"Any",           funding:"Full",    amount:45000, currency:"USD",        deadline:"10-15", ys:0, ye:3, desc:"Grants for graduate study, research, and teaching in the United States for citizens of other countries.", elig:"Open to international students in any field. Strong academic record required.", link:"https://foreign.fulbrightonline.org", renewable:true,  gpa:"3.5+",                          benefits:["Tuition & fees","Monthly stipend","Health insurance","Travel allowance"],       tags:["Research","Exchange","Prestigious"],    source:"fulbrightonline.org" },
  { id:2,  name:"Chevening Scholarships",                   org:"UK Foreign, Commonwealth & Dev Office", country:"UK",          flag:"🇬🇧", level:"Postgraduate", field:"Any",           funding:"Full",    amount:42000, currency:"GBP",        deadline:"11-05", ys:0, ye:3, desc:"UK Government's international awards enabling outstanding emerging leaders to pursue one-year master's degrees.", elig:"2+ years of work experience. Citizens of eligible countries.", link:"https://www.chevening.org/scholarships/", renewable:false, gpa:"Strong academic background",    benefits:["Tuition","Living allowance","Travel","Visa costs"],                             tags:["Leadership","Network","UK"],            source:"chevening.org" },
  { id:3,  name:"DAAD Scholarship Program",                 org:"German Academic Exchange Service",      country:"Germ
