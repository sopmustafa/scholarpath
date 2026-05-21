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

// ─── In-Memory DB (swap for MongoDB/PostgreSQL in production) ────
const db = {
  users    : [],   // { id, name, email, password, verified, verifyToken, resetToken, resetExpiry, googleId, createdAt }
  profiles : [],   // { userId, major, degreeLevel, country, gpa, interests, bio, avatar }
  comments : [],   // { id, scholarshipId, userId, text, createdAt, edited }
  sessions : [],   // { token, userId, expiresAt }
};

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
  const link = `${process.env.FRONTEND_URL || `http://localhost:${PORT}`}/verify-email?token=${token}`;
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
  const link = `${process.env.FRONTEND_URL || `http://localhost:${PORT}`}/reset-password?token=${token}`;
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
    if (existing) return res.status(409).json({ error: 'Email already registered' });

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

  const user    = db.users.find(u => u.id === req.userId);
  const profile = db.profiles.find(p => p.userId === req.userId);
  res.status(201).json({ ...comment, author: user?.name || 'Anonymous', avatar: profile?.avatar || '', isOwn: true });
});

// DELETE /api/comments/:commentId
app.delete('/api/comments/:commentId', authMiddleware, (req, res) => {
  const idx = db.comments.findIndex(c => c.id === req.params.commentId && c.userId === req.userId);
  if (idx === -1) return res.status(404).json({ error: 'Comment not found or not yours' });
  db.comments.splice(idx, 1);
  res.json({ message: 'Comment deleted' });
});

// PUT /api/comments/:commentId
app.put('/api/comments/:commentId', authMiddleware, (req, res) => {
  const comment = db.comments.find(c => c.id === req.params.commentId && c.userId === req.userId);
  if (!comment) return res.status(404).json({ error: 'Comment not found or not yours' });
  if (!req.body.text?.trim()) return res.status(400).json({ error: 'Text required' });
  comment.text   = req.body.text.trim();
  comment.edited = true;
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
  { id:3,  name:"DAAD Scholarship Program",                 org:"German Academic Exchange Service",      country:"Germany",     flag:"🇩🇪", level:"Postgraduate", field:"Any",           funding:"Full",    amount:934,   currency:"EUR/month",  deadline:"10-31", ys:0, ye:4, desc:"Scholarships for international students to study or conduct research in Germany at all degree levels.", elig:"Above-average grades, high academic achievement.", link:"https://www.daad.de/en/study-and-research-in-germany/scholarships/", renewable:true,  gpa:"3.0+",                          benefits:["Monthly stipend","Health insurance","Travel subsidy","Language courses"],      tags:["Research","Germany","Engineering"],     source:"daad.de" },
  { id:4,  name:"Australia Awards Scholarships",            org:"Australian Government (DFAT)",          country:"Australia",   flag:"🇦🇺", level:"Postgraduate", field:"Any",           funding:"Full",    amount:55000, currency:"AUD",        deadline:"04-30", ys:0, ye:3, desc:"Enable citizens from eligible countries to undertake full-time postgraduate study at Australian universities.", elig:"2+ years work experience. Citizens of eligible developing countries.", link:"https://www.australiaawards.gov.au", renewable:false, gpa:"Good academic record",          benefits:["Tuition","Return airfare","Establishment allowance","Living expenses"],        tags:["Government","Development","Pacific"],  source:"australiaawards.gov.au" },
  { id:5,  name:"Vanier Canada Graduate Scholarships",      org:"Government of Canada",                  country:"Canada",      flag:"🇨🇦", level:"PhD",          field:"Any",           funding:"Full",    amount:50000, currency:"CAD",        deadline:"11-01", ys:0, ye:3, desc:"Strengthens Canada's ability to attract and retain world-class doctoral students.", elig:"Nominated by Canadian institution. First-year PhD students.", link:"https://vanier.gc.ca", renewable:true,  gpa:"3.7+",                          benefits:["Annual stipend","Research support","Networking"],                               tags:["PhD","Research","Canada"],             source:"vanier.gc.ca" },
  { id:6,  name:"MEXT Japanese Government Scholarship",     org:"Ministry of Education, Japan",          country:"Japan",       flag:"🇯🇵", level:"Undergraduate",field:"Any",           funding:"Full",    amount:117000,currency:"JPY/month",  deadline:"06-30", ys:0, ye:4, desc:"Funding to international students to study at Japanese universities across all levels.", elig:"Age 17-25 for undergrad. No Japanese language requirement initially.", link:"https://www.mext.go.jp/en/", renewable:true,  gpa:"Good academic standing",        benefits:["Monthly allowance","Tuition waiver","Travel","Language training"],             tags:["Government","Japan","Language"],       source:"mext.go.jp" },
  { id:7,  name:"Erasmus Mundus Joint Masters",             org:"European Commission",                   country:"EU",          flag:"🇪🇺", level:"Postgraduate", field:"Any",           funding:"Full",    amount:1400,  currency:"EUR/month",  deadline:"01-31", ys:0, ye:2, desc:"Supports joint master programmes offered by consortia of higher education institutions worldwide.", elig:"Bachelor's degree in any discipline. Open to worldwide applicants.", link:"https://www.eacea.ec.europa.eu/scholarships/erasmus-mundus-catalogue_en", renewable:false, gpa:"3.0+",                          benefits:["Monthly allowance","Tuition","Travel","Insurance"],                            tags:["Europe","International","Multi-country"],source:"eacea.ec.europa.eu" },
  { id:8,  name:"NUS Research Scholarships",                org:"National University of Singapore",      country:"Singapore",   flag:"🇸🇬", level:"PhD",          field:"STEM",          funding:"Full",    amount:3100,  currency:"SGD/month",  deadline:"12-01", ys:0, ye:4, desc:"Outstanding candidates wishing to pursue full-time research leading to a doctoral degree at NUS.", elig:"Bachelor's or Master's in STEM. Strong research background.", link:"https://nus.edu.sg/admissions/graduate/scholarships.html", renewable:true,  gpa:"3.5+",                          benefits:["Monthly stipend","Tuition subsidy","Hostel","Healthcare"],                     tags:["STEM","Asia","Research"],              source:"nus.edu.sg" },
  { id:9,  name:"Korea Government Scholarship (KGSP)",      org:"National Institute for International Education",country:"South Korea",flag:"🇰🇷",level:"Undergraduate",field:"Any",  funding:"Full",    amount:900000,currency:"KRW/month",  deadline:"03-31", ys:0, ye:4, desc:"Enables international students to study at Korean universities with comprehensive support.", elig:"Under 25 for undergrad. No Korean citizenship.", link:"https://www.studyinkorea.go.kr/en/sub/gks/allnew_invite.do", renewable:true,  gpa:"80%+",                          benefits:["Monthly stipend","Tuition","Korean language training","Airfare"],              tags:["Korea","Government","Full support"],   source:"studyinkorea.go.kr" },
  { id:10, name:"Gates Cambridge Scholarship",              org:"Bill & Melinda Gates Foundation",       country:"UK",          flag:"🇬🇧", level:"Postgraduate", field:"Any",           funding:"Full",    amount:35000, currency:"GBP",        deadline:"10-12", ys:0, ye:2, desc:"Outstanding applicants from outside the UK to pursue a full-time postgraduate degree at Cambridge.", elig:"Any subject, strong academics and leadership. Non-UK citizens only.", link:"https://www.gatescambridge.org/apply/", renewable:false, gpa:"First-class honours",           benefits:["Full fees","Living allowance","Airfare","Family allowance"],                   tags:["Cambridge","Prestigious","Leadership"],source:"gatescambridge.org" },
  { id:11, name:"Rhodes Scholarship",                       org:"Rhodes Trust",                          country:"UK",          flag:"🇬🇧", level:"Postgraduate", field:"Any",           funding:"Full",    amount:25000, currency:"GBP",        deadline:"10-01", ys:0, ye:2, desc:"The oldest and most celebrated international fellowship, tenable at Oxford University.", elig:"Ages 18-24. Outstanding academics, leadership and character.", link:"https://www.rhodeshouse.ox.ac.uk/scholarships/apply/", renewable:true,  gpa:"Top academic standing",         benefits:["University fees","Stipend","Airfare","Incidentals"],                           tags:["Oxford","Prestigious","Leadership"],   source:"rhodeshouse.ox.ac.uk" },
  { id:12, name:"Commonwealth Scholarships",                org:"Commonwealth Scholarship Commission",   country:"UK",          flag:"🇬🇧", level:"Postgraduate", field:"Any",           funding:"Full",    amount:16000, currency:"GBP",        deadline:"12-16", ys:0, ye:2, desc:"For citizens of Commonwealth countries to study in the UK, targeting development impact.", elig:"Commonwealth citizen. First class or upper second class degree.", link:"https://cscuk.fcdo.gov.uk/apply/", renewable:false, gpa:"Upper second class (2:1)+",     benefits:["Tuition","Airfare","Living allowance","Thesis grant"],                         tags:["Commonwealth","Development","UK"],     source:"cscuk.fcdo.gov.uk" },
  { id:13, name:"Schwarzman Scholars",                      org:"Schwarzman College, Tsinghua University",country:"China",      flag:"🇨🇳", level:"Postgraduate", field:"Any",           funding:"Full",    amount:48000, currency:"USD",        deadline:"09-21", ys:0, ye:2, desc:"One-year master's degree at Tsinghua University focused on leadership and China.", elig:"Under 29. Any undergraduate degree. Leadership experience.", link:"https://www.schwarzmanscholars.org/admissions/application/", renewable:false, gpa:"Strong academic record",        benefits:["Full tuition","Room & board","Stipend","Travel"],                              tags:["China","Leadership","MBA-style"],      source:"schwarzmanscholars.org" },
  { id:14, name:"Swedish Institute Scholarships",           org:"Swedish Institute",                     country:"Sweden",      flag:"🇸🇪", level:"Postgraduate", field:"Any",           funding:"Full",    amount:11000, currency:"SEK/month",  deadline:"02-10", ys:0, ye:2, desc:"For students from certain countries who wish to pursue a Master's degree in Sweden.", elig:"3 years of work experience. Citizen of eligible countries.", link:"https://si.se/en/apply/scholarships/", renewable:false, gpa:"Strong academic profile",       benefits:["Monthly grant","Tuition","Travel","Insurance"],                                tags:["Sweden","Sustainability","Innovation"],source:"si.se" },
  { id:15, name:"Aga Khan Foundation International Scholarship",org:"Aga Khan Foundation",              country:"USA",         flag:"🇺🇸", level:"Postgraduate", field:"Any",           funding:"Partial", amount:15000, currency:"USD",        deadline:"03-31", ys:0, ye:2, desc:"Provides postgraduate scholarships to talented students from developing countries.", elig:"Citizens of select developing countries. Strong academic record & financial need.", link:"https://www.akdn.org/our-agencies/aga-khan-foundation/international-scholarship-programme", renewable:false, gpa:"Strong academic record",  benefits:["Partial grant","Loan component","Top universities"],                          tags:["Need-based","Developing countries","Merit"],source:"akdn.org" },
  { id:16, name:"Heinrich Böll Foundation Scholarships",    org:"Heinrich Böll Foundation",              country:"Germany",     flag:"🇩🇪", level:"Postgraduate", field:"Any",           funding:"Full",    amount:861,   currency:"EUR/month",  deadline:"03-01", ys:0, ye:3, desc:"Scholarships for graduates interested in social-ecological transformation, democracy and human rights.", elig:"Enrolled or accepted at a German university. Non-partisan civic engagement.", link:"https://www.boell.de/en/foundation/scholarship-programme", renewable:true,  gpa:"Above average",                 benefits:["Monthly grant","Health insurance","Travel","Academic support"],               tags:["Green politics","Germany","Civic"],    source:"boell.de" },
  { id:17, name:"University of Melbourne Graduate Research", org:"University of Melbourne",              country:"Australia",   flag:"🇦🇺", level:"PhD",          field:"Any",           funding:"Full",    amount:37000, currency:"AUD",        deadline:"10-31", ys:0, ye:3, desc:"Supports high-achieving international students to undertake full-time doctoral research.", elig:"Exceptional research capacity. Honours degree or equivalent.", link:"https://study.unimelb.edu.au/how-to-apply/graduate-research/scholarships-and-fellowships", renewable:true,  gpa:"H1 Honours",                    benefits:["Stipend","Tuition offset","Relocation allowance","Thesis support"],           tags:["Australia","Research","PhD"],          source:"unimelb.edu.au" },
  { id:18, name:"Rotary Peace Fellowship",                  org:"Rotary International",                  country:"USA",         flag:"🇺🇸", level:"Postgraduate", field:"Social Sciences",funding:"Full",    amount:30000, currency:"USD",        deadline:"05-15", ys:0, ye:2, desc:"Training for people committed to peace and international understanding through a master's degree.", elig:"3 years of work experience. Fluent English.", link:"https://www.rotary.org/en/our-programs/peace-fellowships", renewable:false, gpa:"Strong academic background",    benefits:["Tuition & fees","Stipend","Airfare","Internship funding"],                    tags:["Peace","International","Leadership"],  source:"rotary.org" },
  { id:19, name:"Eiffel Excellence Scholarship",            org:"Campus France / French Ministry",       country:"France",      flag:"🇫🇷", level:"Postgraduate", field:"Any",           funding:"Partial", amount:1181,  currency:"EUR/month",  deadline:"01-10", ys:0, ye:2, desc:"Enables French higher education institutions to attract top foreign students.", elig:"Under 30 for Master's, under 35 for PhD. Nominated by French institution.", link:"https://www.campusfrance.org/en/eiffel-scholarship-program-of-excellence", renewable:false, gpa:"Strong academic record",        benefits:["Monthly allowance","Return airfare","Cultural activities"],                   tags:["France","Excellence","Arts-friendly"], source:"campusfrance.org" },
  { id:20, name:"ADB-JSP Scholarship Program",              org:"Asian Development Bank",                country:"Japan",       flag:"🇯🇵", level:"Postgraduate", field:"Social Sciences",funding:"Full",    amount:30000, currency:"USD",        deadline:"05-30", ys:0, ye:2, desc:"Graduate students from ADB's developing member countries to pursue postgraduate studies.", elig:"Citizens of ADB developing member countries. 2+ years work experience.", link:"https://www.adb.org/site/careers/japan-scholarship-program", renewable:false, gpa:"3.0+",                          benefits:["Tuition","Subsistence allowance","Textbooks","Health insurance"],             tags:["Development","Asia-Pacific","Policy"], source:"adb.org" },
  { id:21, name:"POSCO TJ Park Foundation Scholarship",     org:"POSCO TJ Park Foundation",              country:"South Korea", flag:"🇰🇷", level:"Postgraduate", field:"STEM",          funding:"Partial", amount:20000, currency:"USD",        deadline:"07-31", ys:0, ye:2, desc:"For Asian students pursuing postgraduate studies in STEM fields at Korean universities.", elig:"Citizen of Asian developing country. STEM field. Under 40.", link:"https://www.postf.org/eng/", renewable:true,  gpa:"3.0+",                          benefits:["Tuition support","Living allowance","Research activities"],                   tags:["STEM","Korea","Asia"],                 source:"postf.org" },
  { id:22, name:"Hungarian Government Scholarships (Stipendium)",org:"Hungarian Government",             country:"Hungary",     flag:"🇭🇺", level:"Undergraduate",field:"Any",           funding:"Full",    amount:500,   currency:"EUR/month",  deadline:"01-15", ys:0, ye:4, desc:"Full scholarships for international students to study in Hungary at Hungarian universities.", elig:"Secondary school diploma or university degree. Any nationality.", link:"https://stipendiumhungaricum.hu/", renewable:true,  gpa:"Good standing",                 benefits:["Monthly stipend","Tuition","Dormitory","Medical insurance"],                  tags:["Hungary","Europe","Full support"],     source:"stipendiumhungaricum.hu" },
  { id:23, name:"Turkish Government Scholarship (Türkiye Bursları)",org:"Presidency of Turkey",         country:"Turkey",      flag:"🇹🇷", level:"Undergraduate",field:"Any",           funding:"Full",    amount:800,   currency:"USD/month",  deadline:"02-20", ys:0, ye:4, desc:"Scholarship for international students to study in Turkey at all degree levels.", elig:"Under 21 for undergrad. Academic success. Any nationality.", link:"https://www.turkiyeburslari.gov.tr/en", renewable:true,  gpa:"70%+",                          benefits:["Monthly stipend","Tuition","Accommodation","Health insurance","Airfare"],     tags:["Turkey","Government","Inclusive"],     source:"turkiyeburslari.gov.tr" },
  { id:24, name:"Brunei Darussalam Government Scholarship",  org:"Government of Brunei",                  country:"Brunei",      flag:"🇧🇳", level:"Undergraduate",field:"Any",           funding:"Full",    amount:1000,  currency:"BND/month",  deadline:"03-15", ys:0, ye:4, desc:"Full scholarships for foreign students to study at Universiti Brunei Darussalam.", elig:"Under 25. Secondary school leavers or undergrad applicants.", link:"https://www.mofat.gov.bn/", renewable:true,  gpa:"Good standing",                 benefits:["Tuition","Living allowance","Accommodation","Airfare"],                       tags:["Brunei","ASEAN","Government"],         source:"mofat.gov.bn" },
  { id:25, name:"New Zealand ASEAN Scholar Awards",          org:"New Zealand Government",                country:"New Zealand", flag:"🇳🇿", level:"Postgraduate", field:"Any",           funding:"Full",    amount:30000, currency:"NZD",        deadline:"03-28", ys:0, ye:2, desc:"Enables citizens of ASEAN countries to study postgraduate programs in New Zealand.", elig:"Citizens of ASEAN countries. Work experience preferred.", link:"https://www.nzscholarships.govt.nz/", renewable:false, gpa:"Good academic record",          benefits:["Tuition","Living allowance","Airfare","Health insurance"],                    tags:["New Zealand","ASEAN","Government"],   source:"nzscholarships.govt.nz" },
];

function resolveScholarship(s) {
  const now  = new Date();
  const year = now.getFullYear();
  return {
    id          : s.id,
    name        : s.name,
    organization: s.org,
    country     : s.country,
    flag        : s.flag,
    level       : s.level,
    field       : s.field,
    funding     : s.funding,
    amount      : s.amount,
    currency    : s.currency,
    deadline    : rollDeadline(s.deadline),
    yearStart   : year + s.ys,
    yearEnd     : year + s.ye,
    description : s.desc,
    eligibility : s.elig,
    link        : s.link,
    renewable   : s.renewable,
    gpa         : s.gpa,
    benefits    : s.benefits,
    tags        : s.tags,
    source      : s.source,
  };
}

// ─── SCHOLARSHIP SOURCES ──────────────────────────────────────────
const SCHOLARSHIP_SOURCES = [
  { id:"opportunitydesk",         name:"Opportunity Desk",            url:"https://opportunitydesk.org/category/scholarships/",                        type:"scrape" },
  { id:"scholars4dev",            name:"Scholars4Dev",                url:"https://www.scholars4dev.com/",                                             type:"scrape" },
  { id:"scholarshipportal",       name:"Scholarship Portal",          url:"https://www.scholarshipportal.com/",                                        type:"link" },
  { id:"scholarshipscom",         name:"Scholarships.com",            url:"https://www.scholarships.com/",                                             type:"link" },
  { id:"fastweb",                 name:"Fastweb",                     url:"https://www.fastweb.com/",                                                  type:"link" },
  { id:"internationalscholarships",name:"InternationalScholarships",  url:"https://www.internationalscholarships.com/",                                type:"link" },
  { id:"studyportals",            name:"Study Portals",               url:"https://www.studyportals.com/scholarships/",                                type:"link" },
  { id:"afterschoolafrica",       name:"After School Africa",         url:"https://www.afterschoool.africa/scholarships/",                             type:"scrape" },
  { id:"fulbright",               name:"Fulbright (Official)",        url:"https://foreign.fulbrightonline.org",                                       type:"link" },
  { id:"chevening",               name:"Chevening (Official)",        url:"https://www.chevening.org/scholarships/",                                   type:"link" },
  { id:"daad",                    name:"DAAD (Official)",             url:"https://www.daad.de/en/study-and-research-in-germany/scholarships/",        type:"link" },
  { id:"eacea",                   name:"Erasmus Mundus (Official)",   url:"https://www.eacea.ec.europa.eu/scholarships/erasmus-mundus-catalogue_en",   type:"link" },
];

// ─── LIVE SCRAPING ────────────────────────────────────────────────
let liveCache     = [];
let lastScrapeAt  = null;
const CACHE_TTL   = 3600000; // 1 hour

async function scrapeOpportunityDesk() {
  try {
    const res = await axios.get('https://opportunitydesk.org/category/scholarships/', { timeout:12000, headers:{'User-Agent':'Mozilla/5.0 (compatible; ScholarPath/2.0)'} });
    const $   = cheerio.load(res.data);
    const out = [];
    $('article').each((i, el) => {
      if (i >= 15) return false;
      const title = $(el).find('h2,h3').first().text().trim();
      const link  = $(el).find('a[href]').first().attr('href') || '';
      const date  = $(el).find('time,.date,.entry-date').first().text().trim();
      if (title && link) out.push({ title, link, date, source:'opportunitydesk.org' });
    });
    return out;
  } catch (e) { console.warn('[scrape] OD:', e.message); return []; }
}

async function scrapeScholars4Dev() {
  try {
    const res = await axios.get('https://www.scholars4dev.com/', { timeout:12000, headers:{'User-Agent':'Mozilla/5.0 (compatible; ScholarPath/2.0)'} });
    const $   = cheerio.load(res.data);
    const out = [];
    $('h2.entry-title, h3.entry-title, .post-title').each((i, el) => {
      if (i >= 15) return false;
      const a = $(el).find('a');
      const title = a.text().trim();
      const link  = a.attr('href') || '';
      if (title && link) out.push({ title, link, date:'', source:'scholars4dev.com' });
    });
    return out;
  } catch (e) { console.warn('[scrape] S4D:', e.message); return []; }
}

async function fetchLiveScholarships() {
  if (lastScrapeAt && (Date.now() - lastScrapeAt) < CACHE_TTL && liveCache.length) return liveCache;
  console.log('[scrape] Fetching live scholarships...');
  const [od, s4d] = await Promise.all([scrapeOpportunityDesk(), scrapeScholars4Dev()]);
  liveCache    = [...od, ...s4d];
  lastScrapeAt = Date.now();
  console.log(`[scrape] Got ${liveCache.length} live items`);
  return liveCache;
}

// ─── GROQ AI SEARCH ───────────────────────────────────────────────
async function groqSearch(query, scholarships) {
  if (!process.env.GROQ_API_KEY) return { results: scholarships, explanation: '' };
  try {
    const prompt = `You are a scholarship search assistant. Given a user query and a list of scholarships (as JSON), return the IDs of the most relevant scholarships (up to 10) sorted by relevance, and a brief explanation of why they match.

User query: "${query}"

Scholarships:
${JSON.stringify(scholarships.map(s => ({ id:s.id, name:s.name, country:s.country, level:s.level, field:s.field, description:s.description, tags:s.tags })))}

Respond ONLY with valid JSON, no markdown, no preamble:
{"ids":[1,2,3],"explanation":"Short reason."}`;

    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model      : process.env.GROQ_MODEL || 'llama3-8b-8192',
      messages   : [{ role:'user', content:prompt }],
      max_tokens : 512,
      temperature: 0.2,
    }, {
      headers: { 'Authorization':`Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type':'application/json' },
      timeout: 15000,
    });

    const text   = res.data.choices[0]?.message?.content || '{}';
    const clean  = text.replace(/```json|```/g,'').trim();
    const parsed = JSON.parse(clean);
    const ids    = new Set(parsed.ids || []);
    return { results: scholarships.filter(s => ids.has(s.id)), explanation: parsed.explanation || '' };
  } catch (e) {
    console.warn('[groq]', e.message);
    return { results: scholarships, explanation: '' };
  }
}

// ─── SCHOLARSHIP API ROUTES ───────────────────────────────────────

app.get('/api/year', (_, res) => res.json(getActiveYearWindow()));
app.get('/api/sources', (_, res) => res.json(SCHOLARSHIP_SOURCES));

app.get('/api/scholarships', (req, res) => {
  const { country, level, field, funding, yearFrom, yearTo, sort, q, page=1, limit=100 } = req.query;
  const yw = getActiveYearWindow();
  let results = BASE_SCHOLARSHIPS.map(resolveScholarship);

  if (q) {
    const lq = q.toLowerCase();
    results = results.filter(s =>
      s.name.toLowerCase().includes(lq) ||
      s.organization.toLowerCase().includes(lq) ||
      s.description.toLowerCase().includes(lq) ||
      (s.tags||[]).some(t => t.toLowerCase().includes(lq))
    );
  }
  if (country) results = results.filter(s => s.country === country);
  if (level)   results = results.filter(s => s.level   === level);
  if (field)   results = results.filter(s => s.field   === 'Any' || s.field === field);
  if (funding) results = results.filter(s => s.funding === funding);

  const yF = parseInt(yearFrom)||yw.yearFrom;
  const yT = parseInt(yearTo)||yw.yearTo;
  results = results.filter(s => s.yearStart <= yT && s.yearEnd >= yF);

  const sortBy = sort || 'deadline';
  results.sort((a,b) => {
    if (sortBy==='deadline')    return new Date(a.deadline)-new Date(b.deadline);
    if (sortBy==='amount-high') return b.amount-a.amount;
    if (sortBy==='amount-low')  return a.amount-b.amount;
    if (sortBy==='name')        return a.name.localeCompare(b.name);
    return 0;
  });

  const total  = results.length;
  const pn     = parseInt(page), lim = parseInt(limit);
  const paged  = results.slice((pn-1)*lim, pn*lim);
  res.json({ scholarships:paged, total, page:pn, limit:lim, pages:Math.ceil(total/lim), yearWindow:yw });
});

app.get('/api/scholarships/:id', (req, res) => {
  const s = BASE_SCHOLARSHIPS.find(s => s.id === parseInt(req.params.id));
  if (!s) return res.status(404).json({ error:'Not found' });
  res.json(resolveScholarship(s));
});

app.get('/api/live', async (req, res) => {
  try {
    const items = await fetchLiveScholarships();
    res.json({ items, count:items.length, lastUpdated:lastScrapeAt });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error:'query required' });
  const all    = BASE_SCHOLARSHIPS.map(resolveScholarship);
  const result = await groqSearch(query, all);
  res.json(result);
});

app.get('/api/deadlines', (_, res) => {
  const now    = new Date();
  const result = BASE_SCHOLARSHIPS
    .map(resolveScholarship)
    .map(s => ({ ...s, daysLeft:Math.ceil((new Date(s.deadline)-now)/86400000) }))
    .sort((a,b) => a.daysLeft-b.daysLeft);
  res.json(result);
});

// ─── CRON: refresh live cache hourly ─────────────────────────────
cron.schedule('0 * * * *', () => { console.log('[cron] Refreshing live cache'); fetchLiveScholarships(); });

// ─── START ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎓 ScholarPath Backend v2 — http://localhost:${PORT}`);
  console.log(`\n  Auth:          POST /api/auth/register | /login | /forgot-password | /reset-password | /google`);
  console.log(`  Profile:       GET/PUT /api/profile`);
  console.log(`  Comments:      GET/POST/PUT/DELETE /api/comments/:scholarshipId`);
  console.log(`  Scholarships:  GET /api/scholarships | /api/scholarships/:id`);
  console.log(`  Live:          GET /api/live`);
  console.log(`  AI Search:     POST /api/search\n`);
  fetchLiveScholarships();
});
