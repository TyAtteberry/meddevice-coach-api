// ══════════════════════════════════════════════════════════════
// Conceromed — Backend Server v4.9
// Supabase integration for cross-device sync
// Deploy to Railway · Node 18+ native fetch
// ══════════════════════════════════════════════════════════════

const express    = require('express');
const cors       = require('cors');
const multer     = require('multer');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
// nodemailer removed — using Resend API for email

const app  = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_KEY        = process.env.ANTHROPIC_KEY        || '';
const ELEVENLABS_KEY       = process.env.ELEVENLABS_KEY       || '';
const ADMIN_PASSWORD       = process.env.ADMIN_PASSWORD       || 'SalesPro2026';
const ADMIN_SECRET         = process.env.ADMIN_SECRET         || '';
const SUPABASE_URL         = process.env.SUPABASE_URL         || 'https://ikxtgdwowdchvbwffymw.supabase.co';
const STRIPE_SECRET_KEY    = process.env.STRIPE_SECRET_KEY    || '';
const STRIPE_WEBHOOK_SECRET= process.env.STRIPE_WEBHOOK_SECRET|| '';
const APP_URL              = process.env.APP_URL               || 'https://tyatteberry.github.io/meddevice-sales-coach';
const SUPABASE_KEY         = process.env.SUPABASE_KEY         || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlreHRnZHdvd2RjaHZid2ZmeW13Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzMjQ3NzMsImV4cCI6MjA5MDkwMDc3M30.5f411xR3WG7dsfWWL63OWnDUFBJsYuy3-BBe3t3rze8';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const GMAIL_USER           = process.env.GMAIL_USER           || '';
const GMAIL_APP_PASSWORD   = process.env.GMAIL_APP_PASSWORD   || '';
const RESEND_API_KEY       = process.env.RESEND_API_KEY       || '';
const PDP_API_USERNAME     = process.env.PDP_API_USERNAME     || '';
const PDP_API_PASSWORD     = process.env.PDP_API_PASSWORD     || '';
const PDP_WEBHOOK_SECRET   = process.env.PDP_WEBHOOK_SECRET   || '';

app.use(cors({ origin: '*' }));
// Capture raw body for Stripe webhook signature verification
app.use((req, res, next) => {
  if (req.originalUrl === '/stripe/webhook') {
    let raw = [];
    req.on('data', chunk => raw.push(chunk));
    req.on('end', () => { req.rawBody = Buffer.concat(raw); next(); });
  } else { next(); }
});
app.use(express.json({ limit: '10mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } });

// ── Supabase REST helper ──────────────────────────────────────
const SB_HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Accept': 'application/json',
};

async function sbGet(table, query='') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, { headers: SB_HEADERS });
  if(!r.ok) throw new Error(`SB GET ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbUpsert(table, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Prefer': 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify(body),
  });
  if(!r.ok) throw new Error(`SB UPSERT ${table}: ${r.status} ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : [];
}

async function sbDelete(table, query) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'DELETE', headers: SB_HEADERS,
  });
  if(!r.ok) throw new Error(`SB DELETE ${table}: ${r.status}`);
}

// ── Legacy file storage (workspaces/FI) ──────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');
function loadData(){try{if(fs.existsSync(DATA_FILE))return JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));}catch(e){}return{workspaces:{},users:{},activity:{}};}
function saveData(d){try{fs.writeFileSync(DATA_FILE,JSON.stringify(d,null,2));}catch(e){}}
function generateCode(n=8){return crypto.randomBytes(n).toString('hex').toUpperCase().slice(0,n);}

app.get('/debug',(req,res)=>res.json({hasAnthropicKey:!!ANTHROPIC_KEY,hasElevenLabsKey:!!ELEVENLABS_KEY,hasSupabaseKey:!!SUPABASE_KEY,hasSupabaseServiceKey:!!SUPABASE_SERVICE_KEY,hasStripeKey:!!STRIPE_SECRET_KEY,hasStripePriceId:!!STRIPE_PRICE_ID,supabaseUrl:SUPABASE_URL}));
app.get('/',(req,res)=>res.json({status:'Conceromed API',version:'4.12'}));

// ── AUTH ──────────────────────────────────────────────────────
// Supports two auth paths:
// 1. Magic Link (Supabase Auth) — primary flow for all users
// 2. Admin bypass — password 'SalesPro2026' for Ty only

const SESSION_STORE=new Map();

// Supabase Auth helpers
async function sbAuthAdmin(path, body, method='POST') {
  const key = SUPABASE_SERVICE_KEY || SUPABASE_KEY;
  const r = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${key}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || data.msg || `Auth error ${r.status}`);
  return data;
}

// Verify a Supabase JWT access token — returns user object or null
async function verifySupabaseToken(token) {
  try {
    const data = await sbAuthAdmin(`/user`, null, 'GET');
    return data; // won't work — need to use token directly
  } catch(e) { return null; }
}

// POST /auth/magic-link — send magic link to email
app.post('/auth/magic-link', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    // Use Supabase Auth OTP (magic link)
    const key = SUPABASE_SERVICE_KEY || SUPABASE_KEY;
    const r = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        email,
        create_user: true,
        options: {
          email_redirect_to: APP_URL,
          data: { source: 'meddevicesalespro' }
        }
      }),
    });
    if (r.ok || r.status === 204) {
      console.log(`[AUTH] Magic link sent to ${email}`);
      res.json({ sent: true });
    } else {
      const err = await r.json();
      throw new Error(err.error_description || err.msg || 'Failed to send magic link');
    }
  } catch(e) {
    console.error('[AUTH] magic-link error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /auth/verify-otp — verify OTP token from magic link URL
app.post('/auth/verify-otp', async (req, res) => {
  const { token, email, type } = req.body;
  if (!token || !email) return res.status(400).json({ error: 'token and email required' });
  try {
    const key = SUPABASE_SERVICE_KEY || SUPABASE_KEY;
    const r = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({ token, email, type: type || 'magiclink' }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error_description || data.msg || 'Invalid or expired token');
    // Store session token for authMiddleware compatibility
    const sessionToken = generateCode(24);
    SESSION_STORE.set(sessionToken, { createdAt: Date.now(), email: data.user?.email, supabaseUid: data.user?.id });
    res.json({
      token: sessionToken,
      email: data.user?.email,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
    });
  } catch(e) {
    console.error('[AUTH] verify-otp error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// POST /auth/exchange-token — exchange Supabase access token for app session
app.post('/auth/exchange-token', async (req, res) => {
  const { accessToken, refreshToken, email } = req.body;
  if (!accessToken || !email) return res.status(400).json({ error: 'accessToken and email required' });
  try {
    // Verify the access token is valid by calling Supabase user endpoint
    const key = SUPABASE_SERVICE_KEY || SUPABASE_KEY;
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'apikey': key,
      }
    });
    if (!r.ok) throw new Error('Invalid access token');
    const userData = await r.json();
    const verifiedEmail = userData.email || email;

    // Create our session token
    const sessionToken = generateCode(24);
    SESSION_STORE.set(sessionToken, { createdAt: Date.now(), email: verifiedEmail, supabaseUid: userData.id });
    console.log(`[AUTH] Magic link login: ${verifiedEmail}`);
    res.json({ token: sessionToken, email: verifiedEmail });
  } catch(e) {
    console.error('[AUTH] exchange-token error:', e.message);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// POST /auth/refresh — refresh Supabase session
app.post('/auth/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  try {
    const key = SUPABASE_SERVICE_KEY || SUPABASE_KEY;
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error_description || 'Refresh failed');
    const sessionToken = generateCode(24);
    SESSION_STORE.set(sessionToken, { createdAt: Date.now(), email: data.user?.email });
    res.json({ token: sessionToken, accessToken: data.access_token, refreshToken: data.refresh_token });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /auth/login — admin bypass only (password: SalesPro2026)
app.post('/auth/login',(req,res)=>{
  if(req.body.password!==ADMIN_PASSWORD)return res.status(401).json({error:'Invalid password'});
  const token=generateCode(24);SESSION_STORE.set(token,{createdAt:Date.now(),email:'admin'});res.json({token});
});

app.post('/auth/verify',(req,res)=>res.json({valid:SESSION_STORE.has(req.headers['x-session-token'])||isStatelessToken(req.headers['x-session-token'])}));
function makeStatelessToken(){return crypto.createHmac('sha256',ADMIN_PASSWORD).update('mdsc-session').digest('hex').substring(0,32);}
function isStatelessToken(t){try{return t===makeStatelessToken();}catch(e){return false;}}
function authMiddleware(req,res,next){
  const t=req.headers['x-session-token'];
  if(t&&(SESSION_STORE.has(t)||isStatelessToken(t)))return next();
  res.status(401).json({error:'Not authenticated'});
}

// ── REP PROFILE ───────────────────────────────────────────────
app.get('/config/elkey',authMiddleware,(req,res)=>res.json({key:ELEVENLABS_KEY}));

app.post('/rep/profile',authMiddleware,async(req,res)=>{
  const email=req.body.email||'unknown';
  try{
    await sbUpsert('rep_profiles',{
      email,
      name:req.body.name||'',
      company:req.body.company||'',
      products:req.body.products||'',
      specialties:req.body.specialties||'',
      territory:req.body.territory||'',
      expense_freq:req.body.expenseFreq||null,
      expense_last:req.body.expenseLast||null,
      productive_time:req.body.productiveTime||null,
      updated_at:new Date().toISOString()
    });
    res.json({saved:true});
  }catch(e){
    const d=loadData();if(!d.reps)d.reps={};d.reps[email]={...req.body,updatedAt:Date.now()};saveData(d);res.json({saved:true});
  }
});

app.get('/rep/profile',authMiddleware,async(req,res)=>{
  const email=req.query.email||req.headers['x-rep-email'||''];
  if(!email)return res.json({});
  try{const rows=await sbGet('rep_profiles',`?email=eq.${encodeURIComponent(email)}&limit=1`);res.json(rows[0]||{});}
  catch(e){res.json({});}
});

// ── EMAIL SENDING ────────────────────────────────────────────
// Sends via Resend API — no SMTP, no port blocking issues
// RESEND_API_KEY env var required

async function sendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) {
    console.log(`[EMAIL] Not configured — would send to ${to}: ${subject}`);
    return { sent: false, reason: 'not configured' };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Ty Atteberry | Conceromed <ty@conceromed.com>',
        to: [to],
        subject,
        html,
        text: text || subject,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || data.name || `Resend error ${r.status}`);
    console.log(`[EMAIL] Sent to ${to}: ${subject} (id: ${data.id})`);
    return { sent: true, id: data.id };
  } catch(e) {
    console.error('[EMAIL] send error:', e.message);
    return { sent: false, error: e.message };
  }
}


// ── TERMS ACCEPTANCE ─────────────────────────────────────────
app.post('/rep/terms-acceptance', authMiddleware, async (req, res) => {
  const { email, version, acceptedAt } = req.body;
  if (!email || !version) return res.status(400).json({ error: 'email and version required' });
  try {
    await sbUpsert('terms_acceptance', {
      email,
      version,
      accepted_at: acceptedAt || new Date().toISOString(),
      ip_hint: req.headers['x-forwarded-for']?.split(',')[0] || null,
      updated_at: new Date().toISOString(),
    });
    res.json({ saved: true });
  } catch(e) {
    console.error('[TERMS] save error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/rep/terms-acceptance', authMiddleware, async (req, res) => {
  const email = req.query.email;
  if (!email) return res.json({ version: null, acceptedAt: null });
  try {
    const rows = await sbGet('terms_acceptance', `?email=eq.${encodeURIComponent(email)}&order=accepted_at.desc&limit=1`);
    const r = rows[0];
    res.json({ version: r?.version || null, acceptedAt: r?.accepted_at || null });
  } catch(e) {
    res.json({ version: null, acceptedAt: null });
  }
});

// ── REFERRAL SYSTEM ──────────────────────────────────────────
// ── REFERRAL SYSTEM v2 — Stripe credits + leaderboard ───────
// $5 credit per converted referral (30-day retention required)
// Max 5 credits/month ($25) per referrer
// Monthly champion (most referrals, min 2) gets next month free ($89 credit)
// Leaderboard shows global top 10 — first name + last initial only

const REFERRAL_CREDIT_CENTS=500;    // $5 per referral
const REFERRAL_MAX_PER_MONTH=5;     // max credits per calendar month
const CHAMPION_CREDIT_CENTS=8900;   // $89 — full month free
const REFERRAL_RETENTION_DAYS=30;   // days referred user must stay active
const DOC_LIMIT=200;                // workspace document limit
const DOC_WARN_THRESHOLD=150;       // warning shown at this count

function getMonthKey(d=new Date()){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;}

async function applyStripeCredit(stripeCustomerId,amountCents,description){
  // If Stripe key is configured, apply balance credit — otherwise log for manual processing
  const STRIPE_KEY=process.env.STRIPE_SECRET_KEY;
  if(!STRIPE_KEY){
    console.log(`[STRIPE CREDIT PENDING] customer:${stripeCustomerId} amount:${amountCents} desc:${description}`);
    return {pending:true};
  }
  try{
    const resp=await fetch('https://api.stripe.com/v1/customers/'+stripeCustomerId+'/balance_transactions',{
      method:'POST',
      headers:{'Authorization':'Bearer '+STRIPE_KEY,'Content-Type':'application/x-www-form-urlencoded'},
      body:`amount=-${amountCents}&currency=usd&description=${encodeURIComponent(description)}`
    });
    const data=await resp.json();
    if(data.error)throw new Error(data.error.message);
    console.log(`[STRIPE CREDIT APPLIED] customer:${stripeCustomerId} amount:-$${amountCents/100} desc:${description}`);
    return {applied:true,transactionId:data.id};
  }catch(e){
    console.error('[STRIPE CREDIT ERROR]',e.message);
    return {error:e.message};
  }
}

app.post('/rep/referral/generate',authMiddleware,async(req,res)=>{
  const{email}=req.body;
  if(!email)return res.status(400).json({error:'email required'});
  try{
    const rows=await sbGet('rep_profiles',`?email=eq.${encodeURIComponent(email)}&limit=1`);
    let code=rows[0]?.referral_code;
    if(!code){
      code=generateCode(8).toUpperCase();
      await sbUpsert('rep_profiles',{email,referral_code:code,updated_at:new Date().toISOString()}).catch(e=>console.error('code upsert:',e.message));
    }
    const rep=rows[0]||{};
    const monthKey=getMonthKey();
    const creditsThisMonth=rep.referral_credits_by_month?.[monthKey]||0;
    const totalConverted=rep.referral_converted||0;
    const totalCreditsEarned=rep.referral_credits_total||0;
    res.json({
      code,
      totalReferred:rep.referral_count||0,
      totalConverted,
      creditsThisMonth,
      maxCreditsPerMonth:REFERRAL_MAX_PER_MONTH,
      totalCreditsEarned,
      isFoundingMember:rep.is_founding_member||false,
      isMonthlyChampion:rep.champion_month===monthKey,
    });
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/rep/referral/redeem',authMiddleware,async(req,res)=>{
  // Called when a new user signs up with a referral code.
  // Records the referral but does NOT apply credit yet — 30-day retention required.
  const{newUserEmail,referralCode}=req.body;
  if(!newUserEmail||!referralCode)return res.status(400).json({error:'email and code required'});
  try{
    const rows=await sbGet('rep_profiles',`?referral_code=eq.${encodeURIComponent(referralCode)}&limit=1`);
    if(!rows.length)return res.status(404).json({error:'Invalid referral code'});
    const referrer=rows[0];
    if(referrer.email===newUserEmail)return res.status(400).json({error:'Cannot refer yourself'});
    const newUserRows=await sbGet('rep_profiles',`?email=eq.${encodeURIComponent(newUserEmail)}&limit=1`);
    if(newUserRows[0]?.referred_by)return res.json({already:true});
    // Record referral with timestamp — credit fires after 30-day check
    const newCount=(referrer.referral_count||0)+1;
    await sbUpsert('rep_profiles',{
      email:referrer.email,
      referral_count:newCount,
      updated_at:new Date().toISOString()
    });
    await sbUpsert('rep_profiles',{
      email:newUserEmail,
      referred_by:referralCode,
      referred_by_email:referrer.email,
      referred_at:new Date().toISOString(),
      updated_at:new Date().toISOString()
    });
    console.log(`[REFERRAL RECORDED] ${newUserEmail} referred by ${referrer.email} (code ${referralCode}) — credit pending 30-day check`);
    res.json({success:true,message:'Referral recorded — credit applies after 30 days'});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/rep/referral/confirm-retention',authMiddleware,async(req,res)=>{
  // Called by a cron job or webhook after 30 days to apply the credit.
  // In production, trigger from Stripe webhook (subscription.updated, invoice.paid)
  // or a daily Railway cron that checks referred_at timestamps.
  const{newUserEmail}=req.body;
  if(!newUserEmail)return res.status(400).json({error:'email required'});
  try{
    const rows=await sbGet('rep_profiles',`?email=eq.${encodeURIComponent(newUserEmail)}&limit=1`);
    const newUser=rows[0];
    if(!newUser?.referred_by_email)return res.status(400).json({error:'Not a referred user'});
    if(newUser.referral_credit_applied)return res.json({already:true});
    // Check 30 days have passed
    const referredAt=new Date(newUser.referred_at);
    const daysSince=(Date.now()-referredAt.getTime())/(1000*60*60*24);
    if(daysSince<REFERRAL_RETENTION_DAYS)return res.status(400).json({error:'30-day retention not yet met',daysRemaining:Math.ceil(REFERRAL_RETENTION_DAYS-daysSince)});
    // Load referrer
    const refRows=await sbGet('rep_profiles',`?email=eq.${encodeURIComponent(newUser.referred_by_email)}&limit=1`);
    const referrer=refRows[0];
    if(!referrer)return res.status(404).json({error:'Referrer not found'});
    // Check monthly cap
    const monthKey=getMonthKey(referredAt); // use the month they signed up
    const creditsByMonth=referrer.referral_credits_by_month||{};
    const creditsThisMonth=creditsByMonth[monthKey]||0;
    if(creditsThisMonth>=REFERRAL_MAX_PER_MONTH){
      console.log(`[REFERRAL CAP HIT] ${referrer.email} already at max ${REFERRAL_MAX_PER_MONTH} credits for ${monthKey}`);
      return res.json({capped:true,message:'Monthly credit cap reached'});
    }
    // Apply Stripe credit
    const stripeResult=await applyStripeCredit(
      referrer.stripe_customer_id||'pending',
      REFERRAL_CREDIT_CENTS,
      `Referral credit: ${newUserEmail} stayed 30 days`
    );
    // Update referrer record
    creditsByMonth[monthKey]=creditsThisMonth+1;
    const newConverted=(referrer.referral_converted||0)+1;
    const newTotal=(referrer.referral_credits_total||0)+1;
    await sbUpsert('rep_profiles',{
      email:referrer.email,
      referral_converted:newConverted,
      referral_credits_total:newTotal,
      referral_credits_by_month:creditsByMonth,
      updated_at:new Date().toISOString()
    });
    // Mark credit as applied on new user record
    await sbUpsert('rep_profiles',{
      email:newUserEmail,
      referral_credit_applied:true,
      referral_credit_applied_at:new Date().toISOString(),
      updated_at:new Date().toISOString()
    });
    res.json({success:true,creditApplied:REFERRAL_CREDIT_CENTS/100,stripeResult});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/rep/referral/status',authMiddleware,async(req,res)=>{
  const email=req.query.email;
  if(!email)return res.status(400).json({error:'email required'});
  try{
    const rows=await sbGet('rep_profiles',`?email=eq.${encodeURIComponent(email)}&limit=1`);
    const rep=rows[0]||{};
    const monthKey=getMonthKey();
    const creditsThisMonth=(rep.referral_credits_by_month||{})[monthKey]||0;
    const creditsRemaining=Math.max(0,REFERRAL_MAX_PER_MONTH-creditsThisMonth);
    res.json({
      code:rep.referral_code||null,
      totalReferred:rep.referral_count||0,
      totalConverted:rep.referral_converted||0,
      creditsThisMonth,
      creditsRemaining,
      maxPerMonth:REFERRAL_MAX_PER_MONTH,
      totalCreditsEarned:rep.referral_credits_total||0,
      creditValue:REFERRAL_CREDIT_CENTS/100,
      isFoundingMember:rep.is_founding_member||false,
      isMonthlyChampion:rep.champion_month===monthKey,
    });
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/rep/referral/leaderboard',authMiddleware,async(req,res)=>{
  // Global top 10 by converted referrals — first name + last initial only
  try{
    const rows=await sbGet('rep_profiles','?referral_converted=gt.0&order=referral_converted.desc&limit=10');
    const monthKey=getMonthKey();
    const board=rows.map((r,i)=>{
      const name=(r.name||'Anonymous').trim();
      const parts=name.split(' ');
      const display=parts.length>1?parts[0]+' '+parts[parts.length-1][0]+'.':parts[0];
      return{
        rank:i+1,
        name:display,
        converted:r.referral_converted||0,
        isChampion:r.champion_month===monthKey,
      };
    });
    res.json({board,monthKey,creditPerReferral:REFERRAL_CREDIT_CENTS/100,maxPerMonth:REFERRAL_MAX_PER_MONTH});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/rep/referral/process-champion',authMiddleware,async(req,res)=>{
  // Run at month end (manually or via cron) to crown the monthly champion.
  // Minimum 2 converted referrals to qualify. Tiebreaker: fewer churned referrals.
  const adminPwd=req.headers['x-admin-password'];
  if(adminPwd!==process.env.ADMIN_PASSWORD)return res.status(403).json({error:'Admin only'});
  try{
    const prevMonth=getMonthKey(new Date(new Date().setMonth(new Date().getMonth()-1)));
    // Get all reps with referrals this month (use converted count as proxy)
    const rows=await sbGet('rep_profiles','?referral_converted=gte.2&order=referral_converted.desc&limit=50');
    // Filter to those with credits in the previous month
    const qualified=rows.filter(r=>(r.referral_credits_by_month||{})[prevMonth]>=2);
    if(!qualified.length)return res.json({message:'No qualified champions this month',monthKey:prevMonth});
    const champion=qualified[0]; // already sorted by converted desc
    // Apply full month free credit
    const stripeResult=await applyStripeCredit(
      champion.stripe_customer_id||'pending',
      CHAMPION_CREDIT_CENTS,
      `Monthly champion award — top referrer for ${prevMonth}`
    );
    await sbUpsert('rep_profiles',{
      email:champion.email,
      champion_month:prevMonth,
      updated_at:new Date().toISOString()
    });
    console.log(`[CHAMPION CROWNED] ${champion.email} — ${(champion.referral_credits_by_month||{})[prevMonth]} referrals in ${prevMonth} — $89 credit applied`);
    res.json({success:true,champion:champion.email,month:prevMonth,stripeResult});
  }catch(e){res.status(500).json({error:e.message});}
});

// Mark founding member (called manually or at launch)
app.post('/rep/founding-member',authMiddleware,async(req,res)=>{
  const{email}=req.body;if(!email)return res.status(400).json({error:'email required'});
  try{
    await sbUpsert('rep_profiles',{email,is_founding_member:true,updated_at:new Date().toISOString()});
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── PROSCAN UPLOAD ───────────────────────────────────────────
app.post('/rep/proscan/upload',authMiddleware,upload.single('file'),async(req,res)=>{
  const email=req.body.email||'unknown';
  if(!req.file)return res.status(400).json({error:'No file uploaded'});
  try{
    const b64=req.file.buffer.toString('base64');
    const prompt=`You are analyzing a ProScan behavioral assessment (PDP, Inc.) for a medical device sales rep. This assessment has THREE distinct sections that must be extracted separately — they represent different things and must NOT be merged.

SECTION 1 — BASIC/NATURAL SELF: How this person is fundamentally wired. Their factory settings. Stable across time and context. This is who they are at home, on weekends, when relaxed — their true baseline.

SECTION 2 — PRIORITY ENVIRONMENT: The pressures currently forcing them to behave differently than their natural self. The GAP between this and Section 1 IS their stress. Large gaps in a trait = significant energy drain. Note the DIRECTION of each adjustment (raising or lowering vs natural) and whether it is described as "significant" or "opposite from natural."

SECTION 3 — PREDICTOR/OUTWARD SELF: How others currently perceive them — a synthesis of natural self plus stress adjustments. This may differ significantly from their natural self if stress is high.

Return ONLY valid JSON with no markdown or backticks:
{
  "repName": "name from the report if visible",
  "assessmentDate": "date from report if visible",

  "naturalSelf": {
    "dominance": "low|moderate|high",
    "dominanceScore": 1-7,
    "dominanceDesc": "2-3 word descriptor from intensity chart e.g. supportive, collaborative, modest",
    "extroversion": "low|moderate|high",
    "extroversionScore": 1-7,
    "extroversionDesc": "2-3 word descriptor",
    "pace": "urgent|moderate|steady",
    "paceScore": 1-7,
    "paceDesc": "2-3 word descriptor",
    "conformity": "low|moderate|high",
    "conformityScore": 1-7,
    "conformityDesc": "2-3 word descriptor",
    "dominantTrait": "name of the single highest-scoring trait",
    "dominantTraitSummary": "2-3 sentences from the report about what this dominant trait means for this person specifically",
    "traitPairs": ["pair name and description", "pair name and description"],
    "logicStyle": "feeling|balanced|fact",
    "logicDesc": "1-2 sentences on how they actually make decisions",
    "primaryEnergyStyle": "thrust|allegiance|stenacity",
    "alternateEnergyStyle": "thrust|allegiance|stenacity|none",
    "energyStyleDesc": "1-2 sentences on how they approach tasks and goals",
    "kineticEnergyZone": 1-7,
    "kineticEnergyDesc": "what this zone means for their capacity — quote or close paraphrase from report",
    "communicationStyle": "label from report e.g. Guarded/Cautious/Exacting",
    "communicationStyleDesc": "how they communicate TO others and what they prefer FROM others — 2-3 sentences",
    "whatTheyNeedFromOthers": ["specific communication need 1", "specific communication need 2", "specific communication need 3"],
    "leadershipStyle": "label from report",
    "leadershipStyleDesc": "1-2 sentences",
    "backupStyle": "label from report e.g. Must be right",
    "backupStyleDesc": "full description of what happens when they run out of patience or energy — this is critical for coaching",
    "backupStyleWarningSignals": ["observable signal 1", "observable signal 2"],
    "topStrengths": ["strength 1", "strength 2", "strength 3", "strength 4"],
    "learnedResponsesToDevelop": ["growth edge 1", "growth edge 2", "growth edge 3"],
    "motivators": ["motivator 1", "motivator 2", "motivator 3", "motivator 4"],
    "demotivators": ["demotivator 1", "demotivator 2", "demotivator 3"],
    "naturalSelfSummary": "3-4 sentence plain-language summary of who this person naturally is — written as if explaining to the rep themselves, not clinical language"
  },

  "priorityEnvironment": {
    "overallStressLevel": "low|moderate|high|very high",
    "stressAdjustments": [
      {
        "trait": "trait name",
        "direction": "raising|lowering",
        "isSignificant": true,
        "isOppositeOfNatural": true,
        "description": "what this adjustment means and what might be causing it — from the report"
      }
    ],
    "traitsWithNoStress": ["trait names with no measurable stress"],
    "dimensionalAdjustment": "compression|expansion|none — and what it means",
    "satisfactionLevel": "low|average|high",
    "satisfactionDesc": "1-2 sentences from report",
    "energyDrain": "low|average|high|very high",
    "energyDrainDesc": "1-2 sentences from report",
    "availableEnergyZone": 1-7,
    "availableEnergyDesc": "what this means practically — direct language not clinical",
    "tankGapAnalysis": "plain language description of the gap between natural energy capacity (kineticEnergyZone) and available energy right now — this is the 'gas tank vs fuel remaining' insight",
    "priorityEnvSummary": "3-4 sentences explaining what the priority environment section reveals about what this person is currently experiencing — written for the rep to understand themselves, not a clinical readout"
  },

  "outwardSelf": {
    "dominanceVsNatural": "same|slightly different|significantly different",
    "extroversionVsNatural": "same|slightly different|significantly different",
    "paceVsNatural": "same|slightly different|significantly different",
    "conformityVsNatural": "same|slightly different|significantly different",
    "outwardSelfSummary": "how others currently perceive this person — 2-3 sentences",
    "gapInsight": "plain language insight about the difference between who they naturally are vs how they are currently coming across to others — this is often where reps have an aha moment"
  },

  "coachingProfile": {
    "salesCoachingSummary": "3-4 sentences on how to coach THIS specific person — what they naturally do well in medical device sales and where they need development",
    "challengerFit": "how naturally this profile executes Challenger selling, where they shine and where they struggle — be specific",
    "prepTendency": "over-preparer|under-preparer|balanced",
    "prepTendencyDesc": "why, based on their profile",
    "coldCallProfile": "what happens naturally for this person on cold calls — strengths and vulnerabilities. Note: if meeting new people is a demotivator, flag this explicitly as a cold call vulnerability",
    "feedbackStyle": "how to deliver feedback so it actually lands for this person — what format, what tone, what to avoid",
    "coachingRisks": ["risk 1 — what could go wrong in coaching if you ignore their profile", "risk 2", "risk 3"],
    "motivatorCoachingLevers": ["motivator 1 with coaching instruction — e.g. Challenge: frame every prep session as a puzzle to solve, not a checklist", "motivator 2 with coaching instruction", "motivator 3 with coaching instruction", "motivator 4 with coaching instruction"],
    "demotivatorWarnings": ["demotivator 1 with specific coaching warning — e.g. Too many external controls: never give this rep a script, give them a framework", "demotivator 2 with warning", "demotivator 3 with warning"],
    "pressureBehaviors": {
      "underPressureDescription": "plain language description of what this person actually does when they hit their limit — drawn from the backup style and management guide sections",
      "earlyWarningSignals": ["specific observable signal 1 that pressure is building before backup style kicks in", "signal 2", "signal 3"],
      "triggerSituations": ["specific sales situation that is likely to trigger backup style — e.g. a condescending physician, a stalled deal, a micromanaging manager", "trigger 2", "trigger 3"],
      "managerGuidance": "specific guidance for a manager who sees this rep entering backup style — what to do and what NOT to do",
      "selfManagementTip": "one practical thing this rep can do in the moment when they feel backup style coming on — specific to their profile"
    },
    "energyManagement": {
      "naturalCapacity": "description of their natural energy tank size based on kinetic zone",
      "rechargeStyle": "how this profile typically recharges — solo vs social, active vs passive",
      "depletionPattern": "how this profile typically burns out — what it looks like before they crash",
      "optimalWorkStructure": "based on energy style and kinetic zone, what does their ideal workday/week structure look like",
      "warningSignsTankIsLow": ["observable warning sign 1", "observable warning sign 2", "observable warning sign 3"]
    },
    "homeVsWorkInsight": "insight on how this profile likely shows up differently at home vs work — what their family/partner probably experiences vs what colleagues experience",
    "managerCoachingCard": {
      "howToMotivate": "2-3 specific things that motivate this rep — tie directly to their motivator list",
      "howToGiveFeedback": "exactly how feedback should be delivered to land well — format, tone, timing, what to avoid",
      "whatShutsThemDown": "2-3 specific things from their demotivator list that will shut this rep down or erode performance",
      "whatTheyNeedToThrive": "2-3 environmental or structural things this rep needs to do their best work",
      "redFlags": "early warning signs that this rep is struggling — drawn from pressure behaviors and backup style. What to watch for before it becomes a problem",
      "whenTheyAreInBackupStyle": "specific script for what a manager should say and do when this rep is visibly in backup style — be concrete, not generic"
    }
  },

  "overrides": [],
  "calibrationNotes": []
}`;

    const cr=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:8000,messages:[{role:'user',content:[
        {type:'document',source:{type:'base64',media_type:'application/pdf',data:b64}},
        {type:'text',text:prompt}
      ]}]})
    });
    const cd=await cr.json();
    if(cd.error)return res.status(500).json({error:cd.error.message||'Claude error'});
    const raw=cd.content?.map(b=>b.text||'').join('')||'';
    let proscan={};
    try{
      const cleaned=raw.replace(/^```json\s*/,'').replace(/\s*```$/,'').trim();
      try{proscan=JSON.parse(cleaned);}catch(e){const jm=raw.match(/\{[\s\S]*\}/);if(jm)proscan=JSON.parse(jm[0]);}
    }catch(e){return res.status(500).json({error:'Could not parse ProScan — ensure you uploaded a valid PDP ProScan PDF'});}

    // Save to Supabase rep_profiles
    try{
      await sbUpsert('rep_profiles',{email,proscan,proscan_uploaded_at:new Date().toISOString(),updated_at:new Date().toISOString()});
    }catch(e){
      // Fallback to file storage
      const d=loadData();if(!d.reps)d.reps={};
      if(!d.reps[email])d.reps[email]={};
      d.reps[email].proscan=proscan;d.reps[email].proscanUploadedAt=Date.now();
      saveData(d);
    }
    res.json({proscan});
  }catch(e){res.status(500).json({error:e.message});}
});
// ── PROSCAN OVERRIDE — rep disagrees with an assessment point ──
app.post('/rep/proscan/override',authMiddleware,async(req,res)=>{
  const{email,field,originalValue,repDescription,isCalibrationNote=false}=req.body;
  if(!email||!field)return res.status(400).json({error:'email and field required'});
  try{
    const rows=await sbGet('rep_profiles',`?email=eq.${encodeURIComponent(email)}&limit=1`);
    if(!rows.length)return res.status(404).json({error:'Profile not found'});
    const profile=rows[0];
    const proscan={...profile.proscan||{}};
    if(isCalibrationNote){
      if(!proscan.calibrationNotes)proscan.calibrationNotes=[];
      proscan.calibrationNotes.push({note:repDescription,addedAt:new Date().toISOString()});
    }else{
      if(!proscan.overrides)proscan.overrides=[];
      // Remove any existing override for this field first
      proscan.overrides=proscan.overrides.filter(o=>o.field!==field);
      proscan.overrides.push({field,originalValue,repDescription,addedAt:new Date().toISOString()});
    }
    await sbUpsert('rep_profiles',{email,proscan,updated_at:new Date().toISOString()});
    res.json({saved:true,overrides:proscan.overrides||[],calibrationNotes:proscan.calibrationNotes||[]});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── PROSCAN OVERRIDE DELETE — rep removes a prior override ────
app.delete('/rep/proscan/override',authMiddleware,async(req,res)=>{
  const{email,field}=req.body;
  if(!email||!field)return res.status(400).json({error:'email and field required'});
  try{
    const rows=await sbGet('rep_profiles',`?email=eq.${encodeURIComponent(email)}&limit=1`);
    if(!rows.length)return res.status(404).json({error:'Profile not found'});
    const profile=rows[0];
    const proscan={...profile.proscan||{}};
    proscan.overrides=(proscan.overrides||[]).filter(o=>o.field!==field);
    await sbUpsert('rep_profiles',{email,proscan,updated_at:new Date().toISOString()});
    res.json({saved:true,overrides:proscan.overrides});
  }catch(e){res.status(500).json({error:e.message});}
});


// ══════════════════════════════════════════════════════════════
// PDP WORKS API — ProScan Invitation + Webhook
// ══════════════════════════════════════════════════════════════

// Helper: Basic auth header for PDP API calls
function pdpAuthHeader(){
  const creds=Buffer.from(`${PDP_API_USERNAME}:${PDP_API_PASSWORD}`).toString('base64');
  return `Basic ${creds}`;
}

// POST /pdp/invite — send ProScan assessment invitation via PDP API
// Called from frontend when rep clicks "Take ProScan"
// Report IDs we request:
//   1 = Personal Dynamics, 4 = Data Sheet, 5 = Intensity Chart,
//   6 = Motivators Worksheet, 7 = Personal Performance Actions, 3 = Personal Strengths
app.post('/pdp/invite',authMiddleware,async(req,res)=>{
  const{email,firstName,lastName}=req.body;
  if(!email||!firstName||!lastName)return res.status(400).json({error:'firstName, lastName, email required'});
  if(!PDP_API_USERNAME||!PDP_API_PASSWORD)return res.status(503).json({error:'PDP API not configured — contact Conceromed support'});
  try{
    const payload={
      sender:{
        name:'Ty Atteberry',
        emailAddress:'ty@conceromed.com',
        organizationName:'Conceromed',
        languageCode:'en'
      },
      reportTypeIds:[1,3,4,5,6,7],      // Personal Dynamics, Strengths, Data Sheet, Intensity, Motivators, Performance Actions
      reportNotificationLevelId:5,       // Invitee + third-party(s) + myself
      thirdPartyNotificationEmailAddresses:['ty@conceromed.com'],
      invitee:{
        firstName,
        lastName,
        emailAddress:email,
        languageCode:'en',
        externalId:email                 // use email as externalId so webhook can match back to rep
      }
    };
    const pdpResp=await fetch('https://my.pdpworks.com/external-api/surveyInvitations',{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Authorization':pdpAuthHeader()
      },
      body:JSON.stringify(payload)
    });
    if(!pdpResp.ok){
      const errText=await pdpResp.text();
      console.error('PDP invite error:',pdpResp.status,errText);
      return res.status(502).json({error:`PDP API error: ${pdpResp.status}`});
    }
    // Mark rep profile as pending so UI shows waiting state
    await sbUpsert('rep_profiles',{
      email,
      proscan_pending:true,
      proscan_invited_at:new Date().toISOString(),
      updated_at:new Date().toISOString()
    }).catch(e=>console.error('pending flag save error:',e.message));
    res.json({sent:true,message:'ProScan invitation sent — check your email to complete the assessment'});
  }catch(e){
    console.error('PDP invite exception:',e.message);
    res.status(500).json({error:e.message});
  }
});

// POST /pdp/webhook — PDP calls this when a rep completes their survey
// Payload: { event:'survey-completed', uri:'...', surveyKey:'...', respondentExternalId:'email@...' }
app.post('/pdp/webhook',async(req,res)=>{
  // Verify Basic auth from PDP
  if(PDP_WEBHOOK_SECRET){
    const authHeader=req.headers['authorization']||'';
    const expectedCreds=Buffer.from(`${PDP_API_USERNAME}:${PDP_WEBHOOK_SECRET}`).toString('base64');
    if(authHeader!==`Basic ${expectedCreds}`){
      console.error('PDP webhook auth mismatch');
      return res.status(401).json({error:'Unauthorized'});
    }
  }
  // Respond 200 immediately — PDP requires fast response to avoid retries
  res.json({received:true});

  // Process async after responding
  try{
    const{event,uri,surveyKey,respondentExternalId}=req.body;
    if(event!=='survey-completed'){return;}
    if(!uri||!surveyKey){return;}

    console.log(`PDP webhook: survey ${surveyKey} completed by ${respondentExternalId||'unknown'}`);

    // Fetch structured trait data from PDP Survey Results API (Option B — basic traits)
    const resultsResp=await fetch(uri,{
      headers:{'Authorization':pdpAuthHeader()}
    });
    if(!resultsResp.ok){
      console.error('PDP results fetch error:',resultsResp.status);
      return;
    }
    const pdpData=await resultsResp.json();
    const repEmail=respondentExternalId||pdpData.emailAddress||null;
    if(!repEmail){console.error('PDP webhook: no email to match rep');return;}

    // Build a structured proscan_api object from PDP's JSON (Option B/C fields)
    const bt=pdpData.basicTraits||{};
    const bv=pdpData.basicValues||{};
    const pv=pdpData.priorityValues||{};
    const tp=pdpData.traitPairs||{};
    const wi=pdpData.wellnessCheck||{};
    const ri=pdpData.responseIntegrity||{};

    const proscanApi={
      surveyKey,
      surveyTakenAt:pdpData.surveyTakenDateTime||null,
      respondent:{
        firstName:pdpData.firstName||'',
        lastName:pdpData.lastName||'',
        email:pdpData.emailAddress||repEmail
      },
      // Option B — Basic traits
      basicTraits:{
        structure:bt.structure||'',
        highestTrait:bt.highestTrait||'',
        lowestTrait:bt.lowestTrait||'',
        logic:bt.logic||'',
        primaryEnergyStyle:bt.primaryEnergyStyle||'',
        kineticEnergy:bt.kineticEnergy||null
      },
      traitPairs:{
        directTeller:tp.directTeller||false,
        persuasiveSeller:tp.persuasiveSeller||false,
        directAndOrPersuasive:tp.directAndOrPersuasive||false,
        organizationalAdvocate:tp.organizationalAdvocate||false,
        accurateConscientious:tp.accurateConscientious||false,
        seeksChangeInnovative:tp.seeksChangeInnovative||false,
        dependableProductive:tp.dependableProductive||false,
        easygoing:tp.easygoing||false,
        hardCharging:tp.hardCharging||false,
        fastFluentCommunicator:tp.fastFluentCommunicator||false,
        confidentRiskTaker:tp.confidentRiskTaker||false,
        debatesActionsInternally:tp.debatesActionsInternally||false,
        cautiousRequiresProof:tp.cautiousRequiresProof||false,
        brainstormer:tp.brainstormer||false,
        internalProcessor:tp.internalProcessor||false,
        consolidatedTraitPairs:tp.consolidatedTraitPairs||''
      },
      // Option C — numeric values for stress analysis
      basicValues:{
        dominance:bv.dominance||null,
        extroversion:bv.extroversion||null,
        pace:bv.pace||null,
        conformity:bv.conformity||null
      },
      priorityValues:{
        dominanceLength:pv.dominanceLength||null,
        extroversionLength:pv.extroversionLength||null,
        paceLength:pv.paceLength||null,
        conformityLength:pv.conformityLength||null,
        logicLength:pv.logicLength||null,
        satisfaction:pv.satisfaction||null,
        energyDrain:pv.energyDrain||null
      },
      wellnessCheck:wi,
      responseIntegrity:ri,
      // Report PDFs available for download (fetch separately if needed)
      reportUris:(pdpData.reports||[]).map(r=>({type:r.reportType,typeId:r.reportTypeId,uri:r.uri,key:r.reportKey})),
      fetchedAt:new Date().toISOString(),
      source:'pdp_api'
    };

    // Merge into existing rep profile — preserve any PDF-extracted proscan, add API data alongside
    const rows=await sbGet('rep_profiles',`?email=eq.${encodeURIComponent(repEmail)}&limit=1`);
    const existing=rows[0]||{};
    const existingProscan=existing.proscan||{};

    // If rep already has PDF-extracted proscan, attach API data as a sub-key
    // If no PDF proscan yet, store api data and flag that PDF upload is still recommended
    const updatedProscan={
      ...existingProscan,
      apiData:proscanApi,
      // Promote key fields to top-level so coaching context builder can use them immediately
      // even before they upload the full PDF
      apiBasicTraits:proscanApi.basicTraits,
      apiTraitPairs:proscanApi.traitPairs,
      apiPriorityValues:proscanApi.priorityValues
    };

    await sbUpsert('rep_profiles',{
      email:repEmail,
      proscan:updatedProscan,
      proscan_api_received_at:new Date().toISOString(),
      proscan_pending:false,
      updated_at:new Date().toISOString()
    });

    console.log(`PDP webhook: proscan API data saved for ${repEmail}`);

    // Send a Resend notification email to rep letting them know results are in
    if(RESEND_API_KEY){
      const repName=pdpData.firstName||'there';
      await fetch('https://api.resend.com/emails',{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${RESEND_API_KEY}`},
        body:JSON.stringify({
          from:'Ty Atteberry <ty@conceromed.com>',
          to:[repEmail],
          subject:'Your ProScan results are in — coaching just got personal',
          html:`<p>Hi ${repName},</p>
<p>Your ProScan assessment is complete and your results have been loaded into Conceromed. Your coaching is now personalized to how you're actually wired.</p>
<p>Check your PDP email for your full PDF reports. Then open the app, head to your profile, and tap <strong>"Understand My Profile"</strong> to start your behavioral debrief with your AI coach.</p>
<p><a href="https://www.meddevicesalespro.com" style="color:#00c9a7;font-weight:600;">Open Conceromed →</a></p>
<p style="font-size:12px;color:#888;">If you'd like to upload your full PDF reports for even deeper coaching, you can do that from the ProScan section in your profile.</p>`,
          text:`Hi ${repName}, your ProScan is complete and loaded into Conceromed. Open the app to start your behavioral coaching debrief: https://www.meddevicesalespro.com`
        })
      }).catch(e=>console.error('notification email error:',e.message));
    }
  }catch(e){
    console.error('PDP webhook processing error:',e.message);
  }
});

// GET /pdp/status — check if rep has pending or completed ProScan
app.get('/pdp/status',authMiddleware,async(req,res)=>{
  const email=req.headers['x-user-email']||req.query.email;
  if(!email)return res.status(400).json({error:'email required'});
  try{
    const rows=await sbGet('rep_profiles',`?email=eq.${encodeURIComponent(email)}&limit=1`);
    const p=rows[0]||{};
    res.json({
      hasProscanPdf:!!(p.proscan?.naturalSelf||p.proscan?.dominance),
      hasProscanApi:!!(p.proscan?.apiData),
      isPending:!!(p.proscan_pending),
      invitedAt:p.proscan_invited_at||null,
      apiReceivedAt:p.proscan_api_received_at||null
    });
  }catch(e){res.status(500).json({error:e.message});}
});

// ══════════════════════════════════════════════════════════════
// SYNC — Push localStorage → Supabase / Pull Supabase → client
// ══════════════════════════════════════════════════════════════

app.post('/sync/push',authMiddleware,async(req,res)=>{
  const{email,accounts,goals}=req.body;
  if(!email)return res.status(400).json({error:'email required'});
  const results={accounts:0,goals:0,errors:[]};

  if(Array.isArray(accounts)){
    for(const a of accounts){
      try{
        await sbUpsert('accounts',{
          id:a.id,email,name:a.name||'',type:a.type||'',location:a.location||'',
          next_step:a.nextStep||'',next_step_date:a.nextStepDate||'',
          stakeholders:a.stakeholders||[],strategy:a.strategy||{},calls:a.calls||[],
          updated_at:new Date().toISOString()
        });
        results.accounts++;
      }catch(e){results.errors.push(`acct ${a.id}: ${e.message}`);}
    }
  }

  if(goals&&goals.quarters){
    for(const[qId,quarter]of Object.entries(goals.quarters)){
      try{
        await sbUpsert('goals',{id:qId,email,data:quarter,updated_at:new Date().toISOString()});
        results.goals++;
      }catch(e){results.errors.push(`goal ${qId}: ${e.message}`);}
    }
  }
  res.json(results);
});

app.get('/sync/pull',authMiddleware,async(req,res)=>{
  const email=req.query.email||req.headers['x-rep-email']||''
  if(!email)return res.status(400).json({error:'email required'});
  try{
    const[accounts,goalRows,profileRows]=await Promise.all([
      sbGet('accounts',`?email=eq.${encodeURIComponent(email)}&order=updated_at.desc`),
      sbGet('goals',`?email=eq.${encodeURIComponent(email)}&order=updated_at.desc`),
      sbGet('rep_profiles',`?email=eq.${encodeURIComponent(email)}&limit=1`),
    ]);
    const acctsMapped=accounts.map(a=>({
      id:a.id,name:a.name,type:a.type,location:a.location,
      nextStep:a.next_step,nextStepDate:a.next_step_date,
      stakeholders:a.stakeholders||[],strategy:a.strategy||{},calls:a.calls||[],
      createdAt:a.created_at,
    }));
    const goalsData={quarters:{},currentQuarterId:goalRows[0]?.id||null};
    for(const row of goalRows)goalsData.quarters[row.id]=row.data;
    const profile=profileRows[0]||{};
    res.json({
      accounts:acctsMapped,
      goals:goalsData,
      profile:{
        proscan:profile.proscan||null,
        proscanUploadedAt:profile.proscan_uploaded_at||null,
        expenseFreq:profile.expense_freq||null,
        expenseLast:profile.expense_last||null,
        productiveTime:profile.productive_time||null,
        referralCode:profile.referral_code||null,
        referralCount:profile.referral_count||0,
        docLimitBonus:profile.doc_limit_bonus||0,
        isFoundingMember:profile.is_founding_member||false,
      }
    });
  }catch(e){res.status(500).json({error:e.message});}
});

// ══════════════════════════════════════════════════════════════
// ACTIVITY FEED — Supabase-backed with file fallback
// ══════════════════════════════════════════════════════════════

function mapToDb(item){
  return{
    activity_id:item.activityId,account_id:item.accountId,email:item.repEmail||''
    ,type:item.type||'',title:item.title||'',content:item.content||''
    ,status:item.status||'logged',subject:item.subject||'',note:item.note||''
    ,started_at:item.startedAt||null,completed_at:item.completedAt||null
    ,sent_at:item.sentAt||null,fact_check_result:item.factCheckResult||null
    ,created_at:item.createdAt||Date.now()
  };
}
function mapFromDb(r){
  return{
    activityId:r.activity_id,accountId:r.account_id,repEmail:r.email||''
    ,type:r.type||'',title:r.title||'',content:r.content||''
    ,status:r.status||'logged',subject:r.subject||'',note:r.note||''
    ,startedAt:r.started_at||null,completedAt:r.completed_at||null
    ,sentAt:r.sent_at||null,factCheckResult:r.fact_check_result||null
    ,createdAt:r.created_at||Date.now(),updatedAt:Date.now()
    ,checkedFacts:false,actionItems:[]
  };
}
function getAccountActivity(data,accountId){
  if(!data.activity)data.activity={};
  if(!data.activity[accountId])data.activity[accountId]=[];
  return data.activity[accountId];
}

app.get('/accounts/:accountId/activity',authMiddleware,async(req,res)=>{
  try{
    const rows=await sbGet('activity',`?account_id=eq.${req.params.accountId}&order=created_at.desc`);
    res.json(rows.map(mapFromDb));
  }catch(e){
    const d=loadData();res.json([...getAccountActivity(d,req.params.accountId)].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)));
  }
});

app.post('/accounts/:accountId/activity',authMiddleware,async(req,res)=>{
  const{type,title,content,dueDate,repName,repEmail}=req.body;
  if(!type)return res.status(400).json({error:'type required'});
  const item={activityId:generateCode(10),accountId:req.params.accountId,type,title:title||'',content:content||'',status:type==='action_item'?'pending':type==='email_draft'?'draft':'logged',createdAt:Date.now(),updatedAt:Date.now(),dueDate:dueDate||null,repName:repName||'',repEmail:repEmail||'',checkedFacts:false,actionItems:[],sentAt:null};
  try{await sbUpsert('activity',mapToDb(item));}catch(e){const d=loadData();getAccountActivity(d,req.params.accountId).push(item);saveData(d);}
  res.json(item);
});

app.put('/accounts/:accountId/activity/:activityId',authMiddleware,async(req,res)=>{
  try{
    const rows=await sbGet('activity',`?activity_id=eq.${req.params.activityId}&limit=1`);
    if(!rows.length)throw new Error('not found');
    const updated={...mapFromDb(rows[0]),...req.body,activityId:rows[0].activity_id,accountId:rows[0].account_id,updatedAt:Date.now()};
    await sbUpsert('activity',mapToDb(updated));res.json(updated);
  }catch(e){
    const d=loadData();const items=getAccountActivity(d,req.params.accountId);
    const idx=items.findIndex(i=>i.activityId===req.params.activityId);
    if(idx===-1)return res.status(404).json({error:'Not found'});
    items[idx]={...items[idx],...req.body,activityId:items[idx].activityId,accountId:items[idx].accountId,updatedAt:Date.now()};
    saveData(d);res.json(items[idx]);
  }
});

app.delete('/accounts/:accountId/activity/:activityId',authMiddleware,async(req,res)=>{
  try{await sbDelete('activity',`?activity_id=eq.${req.params.activityId}`);}catch(e){
    const d=loadData();const items=getAccountActivity(d,req.params.accountId);
    const idx=items.findIndex(i=>i.activityId===req.params.activityId);
    if(idx!==-1){items.splice(idx,1);saveData(d);}
  }
  res.json({deleted:true});
});

// ══════════════════════════════════════════════════════════════
// WORKSPACES — Supabase-backed
// ══════════════════════════════════════════════════════════════

// ── Workspace persistence — Supabase only (no file fallback) ──
async function getWorkspace(id){
  const rows=await sbGet('workspaces',`?id=eq.${id}&limit=1`);
  if(!rows.length) return null;
  const r=rows[0];
  const ws={
    ...r,
    inviteCode: r.invite_code||r.inviteCode||'',
    createdBy: r.created_by||r.createdBy||'',
    createdAt: r.created_at||r.createdAt||Date.now(),
    knowledge: r.knowledge||{},
    members: r.members||[],
  };
  ['product','clinicalStudies','competitive','objections','reimbursement','insights'].forEach(k=>{
    if(!ws.knowledge[k])ws.knowledge[k]=[];
  });
  return ws;
}

async function saveWorkspace(ws){
  await sbUpsert('workspaces',{
    id:ws.id,name:ws.name,company:ws.company||'',created_by:ws.createdBy||'',
    invite_code:ws.inviteCode,members:ws.members||[],knowledge:ws.knowledge||{},
    updated_at:new Date().toISOString()
  });
}

app.post('/workspaces',authMiddleware,async(req,res)=>{
  const{name,company,repName,repEmail}=req.body;
  if(!name)return res.status(400).json({error:'Workspace name required'});
  const id=generateCode(12);const inviteCode=generateCode(6);
  const ws={id,name,company:company||'',createdBy:repEmail||'',createdAt:Date.now(),inviteCode,
    members:[{name:repName||'',email:repEmail||'',role:'admin',joinedAt:Date.now()}],
    knowledge:{product:[],clinicalStudies:[],competitive:[],objections:[],reimbursement:[],insights:[]}};
  await saveWorkspace(ws);
  res.json({workspaceId:id,inviteCode});
});

app.post('/workspaces/join',authMiddleware,async(req,res)=>{
  const{inviteCode,repName,repEmail}=req.body;
  const rows=await sbGet('workspaces',`?invite_code=eq.${inviteCode?.toUpperCase()}&limit=1`);
  if(!rows.length)return res.status(404).json({error:'Invalid invite code'});
  const ws=rows[0];
  if(!ws.members)ws.members=[];
  if(!ws.members.find(m=>m.email===repEmail))ws.members.push({name:repName||'',email:repEmail||'',role:'member',joinedAt:Date.now()});
  await saveWorkspace(ws);
  res.json({workspaceId:ws.id,workspaceName:ws.name});
});

app.get('/workspaces/:id',authMiddleware,async(req,res)=>{
  const ws=await getWorkspace(req.params.id);
  if(!ws)return res.status(404).json({error:'Not found'});
  if(!ws.knowledge)ws.knowledge={};
  ['product','clinicalStudies','competitive','objections','reimbursement','insights'].forEach(k=>{if(!ws.knowledge[k])ws.knowledge[k]=[];});
  res.json(ws);
});

app.get('/workspaces',authMiddleware,async(req,res)=>{
  try{
    const rows=await sbGet('workspaces','?order=updated_at.desc');
    res.json(rows.map(w=>({id:w.id,name:w.name,company:w.company,members:(w.members||[]).length,createdAt:w.created_at})));
  }catch(e){res.status(500).json({error:'Failed to load workspaces'});}
});

app.delete('/workspaces/:id/members/:email',authMiddleware,async(req,res)=>{
  const emailToRemove=decodeURIComponent(req.params.email);
  const ws=await getWorkspace(req.params.id);if(!ws)return res.status(404).json({error:'Not found'});
  const req_email=req.headers['x-requester-email'];
  const reqr=ws.members.find(m=>m.email===req_email);if(!reqr||reqr.role!=='admin')return res.status(403).json({error:'Only admins can remove members'});
  const target=ws.members.find(m=>m.email===emailToRemove);if(!target)return res.status(404).json({error:'Member not found'});
  if(target.role==='admin')return res.status(400).json({error:'Cannot remove admin'});
  ws.members=ws.members.filter(m=>m.email!==emailToRemove);
  await saveWorkspace(ws);
  res.json({removed:true,name:target.name});
});

app.post('/workspaces/:id/transfer',authMiddleware,async(req,res)=>{
  const{newAdminEmail,requesterEmail}=req.body;
  const ws=await getWorkspace(req.params.id);if(!ws)return res.status(404).json({error:'Not found'});
  const reqr=ws.members.find(m=>m.email===requesterEmail);if(!reqr||reqr.role!=='admin')return res.status(403).json({error:'Only admins can transfer'});
  const na=ws.members.find(m=>m.email===newAdminEmail);if(!na)return res.status(404).json({error:'New admin not found'});
  ws.members=ws.members.map(m=>({...m,role:m.email===newAdminEmail?'admin':m.email===requesterEmail?'member':m.role}));
  await saveWorkspace(ws);
  res.json({transferred:true,newAdmin:na.name});
});

// ── MERGE WORKSPACE ───────────────────────────────────────────
// Merges source workspace docs into target, adds rep as member, archives source
app.post('/workspaces/:id/merge',authMiddleware,async(req,res)=>{
  const{sourceWorkspaceId,requesterEmail}=req.body;
  if(!sourceWorkspaceId||!requesterEmail)return res.status(400).json({error:'sourceWorkspaceId and requesterEmail required'});
  const[target,source]=await Promise.all([getWorkspace(req.params.id),getWorkspace(sourceWorkspaceId)]);
  if(!target)return res.status(404).json({error:'Target workspace not found'});
  if(!source)return res.status(404).json({error:'Source workspace not found — it may have been deleted'});

  // Merge knowledge — add all source items not already in target (dedupe by title/content)
  const cats=['product','clinicalStudies','competitive','objections','reimbursement','insights'];
  let totalMerged=0;
  cats.forEach(cat=>{
    const sourceItems=source.knowledge?.[cat]||[];
    const targetItems=target.knowledge?.[cat]||[];
    // Deduplicate by itemId first, then by title similarity
    const existingIds=new Set(targetItems.map(i=>i.itemId));
    const existingTitles=new Set(targetItems.map(i=>(i.title||i.productName||i.competitorName||'').toLowerCase().trim()));
    const toAdd=sourceItems.filter(item=>{
      if(existingIds.has(item.itemId))return false;
      const title=(item.title||item.productName||item.competitorName||'').toLowerCase().trim();
      if(title&&existingTitles.has(title))return false;
      return true;
    }).map(item=>({...item,itemId:generateCode(8),mergedFrom:source.name,mergedAt:Date.now()}));
    target.knowledge[cat]=[...targetItems,...toAdd];
    totalMerged+=toAdd.length;
  });

  // Add requester as member of target if not already
  if(!target.members)target.members=[];
  const sourceMember=source.members?.find(m=>m.email===requesterEmail)||{name:requesterEmail,email:requesterEmail};
  if(!target.members.find(m=>m.email===requesterEmail)){
    target.members.push({name:sourceMember.name||requesterEmail,email:requesterEmail,role:'member',joinedAt:Date.now(),mergedFrom:source.name});
  }

  await saveWorkspace(target);
  res.json({merged:true,totalMerged,targetId:target.id,targetName:target.name,sourceName:source.name});
});

// ── KNOWLEDGE ─────────────────────────────────────────────────
app.post('/workspaces/:id/knowledge/:category',authMiddleware,async(req,res)=>{
  const{id,category}=req.params;const ws=await getWorkspace(id);if(!ws)return res.status(404).json({error:'Not found'});
  if(!ws.knowledge[category])ws.knowledge[category]=[];
  const item={itemId:generateCode(8),...req.body,addedAt:Date.now()};
  ws.knowledge[category].push(item);
  await saveWorkspace(ws);
  res.json(item);
});

app.delete('/workspaces/:id/knowledge/:category/:itemId',authMiddleware,async(req,res)=>{
  const{id,category,itemId}=req.params;const ws=await getWorkspace(id);if(!ws)return res.status(404).json({error:'Not found'});
  ws.knowledge[category]=(ws.knowledge[category]||[]).filter(i=>i.itemId!==itemId);
  await saveWorkspace(ws);
  res.json({deleted:true});
});

app.post('/workspaces/:id/knowledge/:category/upload',authMiddleware,upload.single('file'),async(req,res)=>{
  const{id,category}=req.params;const ws=await getWorkspace(id);
  if(!ws)return res.status(404).json({error:'Not found'});if(!req.file)return res.status(400).json({error:'No file'});
  const docLink=req.body.docLink||'';

  // ── Document limit check ──────────────────────────────────
  const adminEmail=ws.createdBy||ws.members?.find(m=>m.role==='admin')?.email;
  let docLimit=10; // base limit
  if(adminEmail){
    try{
      const adminRows=await sbGet('rep_profiles',`?email=eq.${encodeURIComponent(adminEmail)}&limit=1`);
      const bonus=adminRows[0]?.doc_limit_bonus||0;
      const isFounder=adminRows[0]?.is_founding_member||false;
      docLimit=isFounder?999:(10+bonus); // founding members get unlimited
    }catch(e){}
  }
  const totalDocs=Object.values(ws.knowledge||{}).reduce((sum,arr)=>sum+(arr?.length||0),0);
  if(totalDocs>=docLimit){
    return res.status(403).json({
      error:`Document limit reached (${docLimit} docs). Refer colleagues to unlock more, or upgrade your plan.`,
      limitReached:true,
      currentLimit:docLimit,
      currentCount:totalDocs,
    });
  }

  try{
    const b64=req.file.buffer.toString('base64');
    // Clinical studies get more tokens — we're asking for much more data
    const maxTokens=category==='clinicalStudies'?3500:2000;
    const cr=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:maxTokens,messages:[{role:'user',content:[{type:'document',source:{type:'base64',media_type:'application/pdf',data:b64}},{type:'text',text:getExtractionPrompt(category)}]}]})});
    const cd=await cr.json();const raw=cd.content?.map(b=>b.text||'').join('')||'';
    let extracted={};try{const jm=raw.match(/\{[\s\S]*\}/);if(jm)extracted=JSON.parse(jm[0]);}catch(e){extracted={summary:raw,raw:true};}
    const item={itemId:generateCode(8),filename:req.file.originalname,category,...extracted,docLink,addedAt:Date.now(),source:'pdf_upload'};
    if(!ws.knowledge[category])ws.knowledge[category]=[];ws.knowledge[category].push(item);
    await saveWorkspace(ws);
    res.json({item,needsInterview:extracted.gaps?.length>0});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/workspaces/:id/knowledge/:category/url',authMiddleware,async(req,res)=>{
  const{id,category}=req.params;const{url}=req.body;if(!url)return res.status(400).json({error:'URL required'});
  const ws=await getWorkspace(id);if(!ws)return res.status(404).json({error:'Not found'});
  let parsedUrl;try{parsedUrl=new URL(url);}catch(e){return res.status(400).json({error:'Invalid URL'});}
  try{
    const pr=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(15000)});
    if(!pr.ok)return res.status(400).json({error:`HTTP ${pr.status}`});
    const html=await pr.text();const text=html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().substring(0,15000);
    if(text.length<150)return res.status(400).json({error:'Not enough content'});
    const cr=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:2000,messages:[{role:'user',content:`${getExtractionPrompt(category)}\n\nSOURCE: ${url}\n\nCONTENT:\n${text}`}]})});
    const cd=await cr.json();const raw=cd.content?.map(b=>b.text||'').join('')||'';
    let extracted={};try{const jm=raw.match(/\{[\s\S]*\}/);if(jm)extracted=JSON.parse(jm[0]);}catch(e){extracted={summary:raw.substring(0,500),raw:true};}
    const item={itemId:generateCode(8),filename:parsedUrl.hostname,url,category,...extracted,addedAt:Date.now(),source:'url'};
    if(!ws.knowledge[category])ws.knowledge[category]=[];ws.knowledge[category].push(item);
    await saveWorkspace(ws);
    res.json({item});
  }catch(e){
    if(e.name==='TimeoutError'||e.name==='AbortError')return res.status(408).json({error:'Page timed out'});
    res.status(500).json({error:e.message});
  }
});

// ── INSIGHTS / COMPETITIVE ────────────────────────────────────
app.post('/workspaces/:id/insights/generate',authMiddleware,async(req,res)=>{
  const{id}=req.params;const{product,specialty,additionalContext,scope}=req.body;
  const ws=await getWorkspace(id);if(!ws)return res.status(404).json({error:'Not found'});
  const k=ws.knowledge||{};

  // Build knowledge context — sanitize to avoid breaking JSON template
  const clean=s=>(s||'').replace(/[\r\n]+/g,' ').replace(/["""]/g,"'").trim().substring(0,300);
  let kc='';
  if(k.product?.length)kc+=`PRODUCT INFO:\n${k.product.map(p=>`- ${clean(p.title||p.productName)}: ${clean(p.summary||p.content)}`).join('\n')}\n\n`;
  if(k.clinicalStudies?.length){
    kc+=`CLINICAL EVIDENCE:\n`;
    k.clinicalStudies.forEach(s=>{
      kc+=`- ${clean(s.title)}: ${clean(s.keyFindings)}\n`;
      if(s.hiddenGoldData)kc+=`  KEY COMMERCIAL DATA: ${clean(s.hiddenGoldData)}\n`;
      if(s.standardOfCareGaps)kc+=`  SOC GAPS: ${clean(s.standardOfCareGaps)}\n`;
      if(s.challengerAngle)kc+=`  REFRAME ANGLE: ${clean(s.challengerAngle)}\n`;
    });
    kc+='\n';
  }
  if(k.competitive?.length)kc+=`COMPETITIVE:\n${k.competitive.map(c=>`- ${clean(c.competitorName)}: ${(c.keyWeaknesses||[]).slice(0,3).map(w=>clean(w)).join('; ')}`).join('\n')}\n\n`;
  if(k.objections?.length)kc+=`KNOWN OBJECTIONS:\n${k.objections.slice(0,5).map(o=>{ const obj=o.objections?.[0]||o; return `- "${clean(obj.objection)}": ${clean(obj.response)}`; }).join('\n')}\n\n`;
  if(additionalContext)kc+=`ADDITIONAL CONTEXT: ${clean(additionalContext)}\n\n`;

  console.log('Generating insight — workspace:',id,'product:',product,'specialty:',specialty,'knowledge sections with data:',
    Object.entries(k).filter(([key,val])=>Array.isArray(val)&&val.length>0).map(([key,val])=>key+'('+val.length+')').join(','));

  const prompt=`You are an expert Challenger sales coach. Build a complete commercial insight for a medical device rep.

PRODUCT: ${product||'the product'}
TARGET SPECIALTY: ${specialty||'general'}

FIELD INTELLIGENCE:
${kc||'No field intelligence loaded yet — build a general Challenger insight for this product and specialty.'}

Return ONLY valid JSON with no markdown, no backticks, no extra text:
{"title":"Short memorable insight name","targetSpecialty":"${specialty||'general'}","product":"${product||''}","problemStatement":"The clinical or operational problem — specific and provocative","reframe":"Word-for-word provocative reframe 1-2 sentences backed by data","evidence":"Clinical data that makes the problem undeniable — include specific percentages","emotionalImpact":"Patient outcomes physician reputation institutional financial impact","newWayForward":"Category of solution without naming product","solution":"Connect product to insight — every feature tied back","bestPersonas":["skeptic","teacher"],"talkingPoints":["Point 1","Point 2","Point 3"],"proofPoints":["Proof 1","Proof 2"],"commonObjections":["Objection 1","Objection 2"],"scope":"${scope||'team'}"}`;

  try{
    const cr=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:2500,messages:[{role:'user',content:prompt}]})
    });
    const cd=await cr.json();
    if(cd.error)return res.status(500).json({error:cd.error.message||'Claude error'});
    const raw=cd.content?.map(b=>b.text||'').join('')||'';
    let insight={};
    try{
      // Try direct parse first, then regex extract
      const cleaned=raw.replace(/^```json\s*/,'').replace(/\s*```$/,'').trim();
      try{insight=JSON.parse(cleaned);}catch(e){const jm=raw.match(/\{[\s\S]*\}/);if(jm)insight=JSON.parse(jm[0]);}
    }catch(e){
      console.error('Insight parse error. Raw:',raw.substring(0,200));
      return res.status(500).json({error:'Could not parse insight — try again or add more Field Intelligence'});
    }
    const item={itemId:generateCode(8),...insight,addedAt:Date.now(),source:'ai_generated'};
    if(!ws.knowledge.insights)ws.knowledge.insights=[];ws.knowledge.insights.push(item);
    await saveWorkspace(ws);
    console.log('Insight generated:',item.title||'untitled','for workspace',id);
    res.json({item,success:true});
  }catch(e){
    console.error('Insight generation error:',e.message);
    res.status(500).json({error:e.message});
  }
});

// PUT — update an existing insight
app.put('/workspaces/:id/insights/:itemId',authMiddleware,async(req,res)=>{
  const{id,itemId}=req.params;
  const ws=await getWorkspace(id);if(!ws)return res.status(404).json({error:'Not found'});
  const idx=(ws.knowledge.insights||[]).findIndex(i=>i.itemId===itemId);
  if(idx===-1)return res.status(404).json({error:'Insight not found'});
  ws.knowledge.insights[idx]={...ws.knowledge.insights[idx],...req.body,itemId,updatedAt:Date.now()};
  await saveWorkspace(ws);
  res.json(ws.knowledge.insights[idx]);
});

app.post('/workspaces/:id/competitive-analysis',authMiddleware,async(req,res)=>{
  const{id}=req.params;const{competitorName,productName}=req.body;
  const ws=await getWorkspace(id);if(!ws)return res.status(404).json({error:'Not found'});
  try{
    const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:1500,messages:[{role:'user',content:`Competitive analysis: ${competitorName} vs ${productName}. Return ONLY valid JSON:{"competitorName":"${competitorName}","productName":"${productName}","knownWeaknesses":["w1"],"adverseEventPatterns":["p"],"clinicalDataGaps":["g"],"positioningOpportunities":["o"],"keyDifferentiators":["d"],"thingsToVerify":["v"]}`}]})});
    const cd=await r.json();const raw=cd.content?.map(b=>b.text||'').join('')||'';
    let analysis={};try{const jm=raw.match(/\{[\s\S]*\}/);if(jm)analysis=JSON.parse(jm[0]);}catch(e){analysis={raw};}
    const item={itemId:generateCode(8),...analysis,addedAt:Date.now(),source:'ai_analysis'};
    if(!ws.knowledge.competitive)ws.knowledge.competitive=[];ws.knowledge.competitive.push(item);
    await saveWorkspace(ws);res.json(item);
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/workspaces/:id/context',authMiddleware,async(req,res)=>{
  const ws=await getWorkspace(req.params.id);if(!ws)return res.status(404).json({error:'Not found'});
  const k=ws.knowledge||{};let ctx=`FIELD INTELLIGENCE: ${ws.name}\n\n`;
  if(k.product?.length){ctx+='PRODUCT:\n';k.product.forEach(p=>{ctx+=`- ${p.title||''}: ${p.content||p.summary||''}\n`;});ctx+='\n';}
  if(k.clinicalStudies?.length){ctx+='STUDIES:\n';k.clinicalStudies.forEach(s=>{ctx+=`- ${s.title||''}: ${s.keyFindings||s.summary||''}\n`;});ctx+='\n';}
  if(k.competitive?.length){ctx+='COMPETITIVE:\n';k.competitive.forEach(c=>{ctx+=`- ${c.competitorName||''}: ${(c.knownWeaknesses||[]).join('; ')}\n`;});ctx+='\n';}
  if(k.objections?.length){ctx+='OBJECTIONS:\n';k.objections.forEach(o=>{ctx+=`- "${o.objection||''}": ${o.response||''}\n`;});ctx+='\n';}
  if(k.insights?.length){ctx+='INSIGHTS:\n';k.insights.forEach(i=>{ctx+=`- "${i.title||''}": ${i.reframe||''}\n`;});ctx+='\n';}
  res.json({context:ctx,workspaceName:ws.name,company:ws.company});
});

// ── EMAIL DRAFT ───────────────────────────────────────────────
app.post('/accounts/:accountId/activity/draft-email',authMiddleware,async(req,res)=>{
  const{accountName,clinician,clinicianTitle,repName,repCompany,repProducts,whatResonated,objections,nextStep,callSummary,emailType,additionalContext}=req.body;
  const typeGuide={followup:'Professional follow-up after sales call.',clinical:'Clinical data share — lead with study.',meeting:'Meeting confirmation or recap.',intro:'First-contact Challenger intro — insight not product.'};
  try{
    const cr=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:1200,messages:[{role:'user',content:`Write a medical device sales email.\nTYPE: ${typeGuide[emailType]||typeGuide.followup}\nACCOUNT: ${accountName||''} CLINICIAN: ${clinician||''} (${clinicianTitle||''})\nREP: ${repName||''} at ${repCompany||''} selling ${repProducts||''}\nCALL SUMMARY: ${callSummary||''}\nWHAT RESONATED: ${whatResonated||''}\nOBJECTIONS: ${objections||''}\nNEXT STEP: ${nextStep||''}\nADDITIONAL: ${additionalContext||''}\nReturn ONLY valid JSON:{"subject":"compelling subject","body":"full email body"}`}]})});
    const cd=await cr.json();const raw=cd.content?.map(b=>b.text||'').join('\'')||''
    let parsed={};try{const jm=raw.match(/\{[\s\S]*\}/);if(jm)parsed=JSON.parse(jm[0]);}catch(e){return res.status(500).json({error:'Parse error'});}
    const item={activityId:generateCode(10),accountId:req.params.accountId,type:'email_draft',title:parsed.subject||'Email Draft',subject:parsed.subject||'',content:parsed.body||'',status:'draft',createdAt:Date.now(),updatedAt:Date.now(),repName:repName||'',repEmail:'',checkedFacts:false,actionItems:[],sentAt:null};
    const d=loadData();getAccountActivity(d,req.params.accountId).push(item);saveData(d);
    try{await sbUpsert('activity',mapToDb(item));}catch(e){}
    res.json(item);
  }catch(e){res.status(500).json({error:e.message});}
});

// ── FACT CHECK ────────────────────────────────────────────────
async function handleFactCheck(req,res){
  const{subject,content,repProducts,accountName,clinician}=req.body;
  const activityId=req.body.activityId||req.params.activityId;
  try{
    const cr=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:1000,messages:[{role:'user',content:`Fact-check this medical device email.\nPRODUCT:${repProducts||''} ACCOUNT:${accountName||''} CLINICIAN:${clinician||''}\nSUBJECT:${subject||''}\nEMAIL:\n${content||''}\nReturn ONLY valid JSON:{"flags":[{"type":"factual_claim|off_label|compliance|improvement","severity":"high|medium|low","text":"quoted text","issue":"what is wrong","suggestion":"how to fix"}],"overallRisk":"low|medium|high","summary":"2-sentence assessment"}`}]})});
    const cd=await cr.json();const raw=cd.content?.map(b=>b.text||'').join('')||'';
    let result={};try{const jm=raw.match(/\{[\s\S]*\}/);if(jm)result=JSON.parse(jm[0]);}catch(e){}
    if(activityId){
      try{const rows=await sbGet('activity',`?activity_id=eq.${activityId}&limit=1`);if(rows.length){const upd={...mapFromDb(rows[0]),factCheckResult:result};await sbUpsert('activity',mapToDb(upd));}}catch(e){
        const d=loadData();const items=getAccountActivity(d,req.params.accountId);const idx=items.findIndex(i=>i.activityId===activityId);if(idx!==-1){items[idx].factCheckResult=result;items[idx].checkedFacts=true;saveData(d);}
      }
    }
    res.json(result);
  }catch(e){res.status(500).json({error:e.message});}
}
app.post('/accounts/:accountId/activity/fact-check',authMiddleware,handleFactCheck);
app.post('/accounts/:accountId/activity/:activityId/fact-check',authMiddleware,handleFactCheck);

async function handleExtractActions(req,res){
  const{content,accountName,clinician}=req.body;
  const activityId=req.body.activityId||req.params.activityId;
  const d=loadData();const items=getAccountActivity(d,req.params.accountId);const item=items.find(i=>i.activityId===activityId);
  try{
    const cr=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:800,messages:[{role:'user',content:`Extract action items from this medical device email.\nACCOUNT:${accountName||''} CLINICIAN:${clinician||''}\nEMAIL:\n${content||''}\nReturn ONLY valid JSON:{"actionItems":[{"text":"specific action","owner":"rep|physician|clinic","priority":"high|medium|low","category":"follow_up|clinical|admin","suggestedDueDate":"YYYY-MM-DD or null"}],"summary":"what this email accomplished"}`}]})});
    const cd=await cr.json();const raw=cd.content?.map(b=>b.text||'').join('')||'';
    let result={};try{const jm=raw.match(/\{[\s\S]*\}/);if(jm)result=JSON.parse(jm[0]);}catch(e){return res.status(500).json({error:'Parse error'});}
    const newItems=[];
    for(const action of(result.actionItems||[])){
      const ni={activityId:generateCode(10),accountId:req.params.accountId,type:'action_item',title:action.text,content:action.text,owner:action.owner||'rep',priority:action.priority||'medium',category:action.category||'follow_up',suggestedDueDate:action.suggestedDueDate||null,status:'pending',sourceActivityId:activityId,createdAt:Date.now(),updatedAt:Date.now(),repName:item?.repName||'',repEmail:item?.repEmail||'',checkedFacts:false,actionItems:[],sentAt:null};
      items.push(ni);newItems.push(ni);
      try{await sbUpsert('activity',mapToDb(ni));}catch(e){}
    }
    saveData(d);res.json({actionItems:result.actionItems||[],createdItems:newItems,summary:result.summary||''});
  }catch(e){res.status(500).json({error:e.message});}
}
app.post('/accounts/:accountId/activity/extract-actions',authMiddleware,handleExtractActions);
app.post('/accounts/:accountId/activity/:activityId/extract-actions',authMiddleware,handleExtractActions);

// ── QUICK LOG ─────────────────────────────────────────────────
app.post('/accounts/:accountId/activity/quick-log',authMiddleware,async(req,res)=>{
  const{rawNote,accountName,repName,repEmail,enrich}=req.body;
  if(!rawNote)return res.status(400).json({error:'rawNote required'});
  let title='Call Note',content=rawNote,nextStep='';
  if(enrich){
    try{
      const cr=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:600,messages:[{role:'user',content:`Clean up this voice-logged call note.\nRAW: ${rawNote}\nReturn ONLY valid JSON:{"title":"5-10 word title","cleanedNote":"polished version","nextStep":"single next action or empty"}`}]})});
      const cd=await cr.json();const raw=cd.content?.map(b=>b.text||'').join('\'')||''
      let p={};try{const jm=raw.match(/\{[\s\S]*\}/);if(jm)p=JSON.parse(jm[0]);}catch(e){}
      if(p.cleanedNote)content=p.cleanedNote;if(p.title)title=p.title;if(p.nextStep)nextStep=p.nextStep;
    }catch(e){}
  }
  const item={activityId:generateCode(10),accountId:req.params.accountId,type:'call_note',title,content,rawNote,nextStep,status:'logged',createdAt:Date.now(),updatedAt:Date.now(),repName:repName||'',repEmail:repEmail||'',checkedFacts:false,actionItems:[],sentAt:null};
  const d=loadData();getAccountActivity(d,req.params.accountId).push(item);saveData(d);
  try{await sbUpsert('activity',mapToDb(item));}catch(e){}
  res.json(item);
});

// ── DAILY BRIEF ───────────────────────────────────────────────
app.post('/rep/daily-brief',authMiddleware,async(req,res)=>{
  const{repName,repEmail,products,specialties,territory,proscan,accounts,goals,quarter,
        expenseFreq,expenseLast,productiveTime,hasNextQuarter,
        territoryContacts,territoryActivity,yesterdayJournal,weeklyScore,platformUsage}=req.body;
  const today=new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
  const dayOfWeek=new Date().toLocaleDateString('en-US',{weekday:'long'});
  const isMonday=dayOfWeek==='Monday';
  const isFriday=dayOfWeek==='Friday';
  const isWeekend=dayOfWeek==='Saturday'||dayOfWeek==='Sunday';

  // ── Quarter end calculation ───────────────────────────────
  let daysLeftInQuarter=null;
  let quarterEndCtx='';
  if(quarter?.endDate){
    const end=new Date(quarter.endDate);
    const now=new Date();
    daysLeftInQuarter=Math.ceil((end-now)/(1000*60*60*24));
    if(daysLeftInQuarter<=0){
      quarterEndCtx=`QUARTER STATUS: Quarter has ended. Rep has NOT set up next quarter goals yet. Urgently nudge them to set up their next quarterly sprint today.`;
    }else if(daysLeftInQuarter<=5){
      quarterEndCtx=`QUARTER STATUS: Only ${daysLeftInQuarter} days left in the quarter. Sprint is almost over — push hard on what's still closeable. In their Strategic Block this week they should set up next quarter's goals and tactics.`;
    }else if(daysLeftInQuarter<=14){
      quarterEndCtx=`QUARTER STATUS: ${daysLeftInQuarter} days left in the quarterly sprint. Start thinking about what's still achievable and begin planning next quarter's goals. Mention using their Strategic Block for next quarter planning.`;
    }
  }

  // ── Expense report nudge ──────────────────────────────────
  let expenseCtx='';
  if(expenseFreq&&expenseLast){
    const lastDate=new Date(expenseLast);
    const daysSince=Math.floor((new Date()-lastDate)/(1000*60*60*24));
    const freqDays={weekly:7,biweekly:14,monthly:30}[expenseFreq]||14;
    const overdueDays=daysSince-freqDays;
    if(overdueDays>=0){
      expenseCtx=`EXPENSE REPORT: Rep is ${overdueDays===0?'due today':overdueDays+' day(s) overdue'} on their ${expenseFreq} expense report (last submitted ${daysSince} days ago). If today looks like a lighter day, nudge them to block 30 minutes and knock it out.`;
    }
  }else if(expenseFreq&&!expenseLast){
    expenseCtx=`EXPENSE REPORT: Rep set a ${expenseFreq} expense cadence but hasn't logged a submission date. Nudge them to submit and update their profile.`;
  }

  // ── Productive time label ─────────────────────────────────
  const productiveTimeLabel={
    early_morning:'early morning (before 8am)',
    mid_morning:'mid-morning (8am–11am)',
    afternoon:'afternoon (12pm–4pm)',
    evening:'evening (after 5pm)',
  }[productiveTime]||'their most productive hours';

  // ── Territory context ─────────────────────────────────────
  let territoryCtx='';
  if(territoryContacts?.length){
    const keyContacts=territoryContacts.filter(c=>c.influence>=7).slice(0,4);
    if(keyContacts.length){
      territoryCtx+=`KEY TERRITORY CONTACTS (high influence):\n${keyContacts.map(c=>`- ${c.name} (${c.title||c.type}): persona=${c.persona||'unknown'}, win="${c.win||''}"`).join('\n')}\n`;
    }
  }
  if(territoryActivity?.length){
    const typeLabels={general:'Activity',expense_report:'Expense Report',strategy_session:'Strategic Block',manager_1on1:'Manager 1:1',training:'Training',conference:'Conference',admin:'Admin'};
    const dueSoon=territoryActivity.filter(a=>a.dueDate);
    const recent=territoryActivity.filter(a=>!a.dueDate).slice(0,4);
    if(dueSoon.length){
      territoryCtx+=`TERRITORY ITEMS DUE:\n${dueSoon.map(a=>`- ${typeLabels[a.type]||'Activity'}: "${a.content}" — due ${a.dueDate}`).join('\n')}\n`;
    }
    if(recent.length){
      territoryCtx+=`RECENT TERRITORY ACTIVITY:\n${recent.map(a=>`- ${typeLabels[a.type]||'Activity'}: "${a.content}"`).join('\n')}\n`;
    }
  }

  // ── Yesterday's journal ───────────────────────────────────
  let journalCtx='';
  if(yesterdayJournal){
    if(yesterdayJournal.summary){
      journalCtx=`YESTERDAY'S DEBRIEF:\n${yesterdayJournal.summary}`;
      if(yesterdayJournal.tomorrowFocus)journalCtx+=`\nFocus for today: ${yesterdayJournal.tomorrowFocus}`;
      if((yesterdayJournal.customerActions||[]).length)journalCtx+=`\nCustomer commitments: ${yesterdayJournal.customerActions.join('; ')}`;
      if(yesterdayJournal.newIntel)journalCtx+=`\nNew intel captured: ${yesterdayJournal.newIntel}`;
      if((yesterdayJournal.followUps||[]).length)journalCtx+=`\nFollow-ups due today: ${yesterdayJournal.followUps.join('; ')}`;
    } else if(yesterdayJournal.wins||yesterdayJournal.challenges||yesterdayJournal.followUp){
      journalCtx=`YESTERDAY'S DEBRIEF:`;
      if(yesterdayJournal.wins)journalCtx+=`\nWins: ${yesterdayJournal.wins}`;
      if(yesterdayJournal.challenges)journalCtx+=`\nChallenges: ${yesterdayJournal.challenges}`;
      if(yesterdayJournal.learned)journalCtx+=`\nLearned: ${yesterdayJournal.learned}`;
      if(yesterdayJournal.followUp)journalCtx+=`\nFollow-up needed: ${yesterdayJournal.followUp}`;
    }
  }

  // Build weekly score context (shows on Monday brief)
  let weeklyScoreCtx='';
  if(weeklyScore?.scores){
    const catNames={goals:'Goal Execution',tactics:'Tactic Completion',accounts:'Account Development',bizacumen:'Business Acumen',overall:'Overall Week'};
    const scoreLines=Object.entries(weeklyScore.scores).map(([k,v])=>`${catNames[k]||k}: ${v}/5`).join(', ');
    weeklyScoreCtx=`LAST WEEK'S SELF-SCORE:\n${scoreLines}`;
    if(weeklyScore.reflection)weeklyScoreCtx+=`\nReflection: ${weeklyScore.reflection}`;
  }

  // Build platform usage coaching context
  let platformCtx='';
  if(platformUsage){
    const u=platformUsage;
    const nudges=[];
    if(u.isNewUser){
      // New user — personalized welcome based on ProScan if available
      if(proscan){
        const ns=proscan.naturalSelf||proscan;
        const dom=ns.dominance||ns.D||0;
        const ext=ns.extroversion||ns.E||0;
        const pac=ns.pace||ns.P||0;
        const con=ns.conformity||ns.C||0;
        let wire='';
        if(con>=60)wire=`Your high Conformity wiring means you'll get the most out of this platform by building your Field Intelligence foundation first — you prepare thoroughly before you call. Start there.`;
        else if(dom>=60)wire=`Your high Dominance wiring means you'll be tempted to jump straight into calls. Build at least one goal and one account first — give the coaching something real to work with.`;
        else if(ext>=60)wire=`Your high Extroversion wiring means you're built for the conversation. Use the role-play practice before your first real call — your natural energy gets even sharper with a rehearsal.`;
        else if(pac<=40)wire=`Your lower Pace score means you move fast. Take 5 minutes to set your Q2 goals before your first call — the coaching is dramatically sharper once it knows where you're going.`;
        else wire=`You're getting started — the coaching gets sharper with every step you complete. Add your first account and set a goal to unlock the full experience.`;
        nudges.push(`NEW USER WELCOME: ${wire}`);
      } else {
        nudges.push(`NEW USER WELCOME: Welcome to Conceromed. Your coaching experience is just getting started — complete your setup checklist on the Today panel to unlock the full platform. Start with adding your first account and setting a Q2 goal.`);
      }
    } else {
      // Returning user — platform usage coaching
      if(u.hasProScan&&!u.debriefViewed)nudges.push(`PLATFORM NUDGE: ${repName?.split(' ')[0]||'You'} has a ProScan uploaded but hasn't done the behavioral debrief yet. Mention this — understanding their wiring profile is where the personalized coaching gets powerful.`);
      if(u.daysSinceRoleplay!==null&&u.daysSinceRoleplay>=7)nudges.push(`PLATFORM NUDGE: No role-play practice in ${u.daysSinceRoleplay} days. Great reps practice when no one is watching — a quick 10 minutes in the Messaging Gym sharpens the next real call.`);
      else if(u.daysSinceRoleplay===null&&u.accountCount>0)nudges.push(`PLATFORM NUDGE: ${repName?.split(' ')[0]||'You'} hasn't used role-play practice yet. Encourage one session — the Messaging Gym button is at the top of the home screen.`);
      if(u.fiDocCount===0&&u.accountCount>0)nudges.push(`PLATFORM NUDGE: Field Intelligence workspace is empty — coaching is running on generic knowledge. Even one uploaded document makes it sharper.`);
      else if(u.fiDocCount>0&&u.fiDocCount<3)nudges.push(`PLATFORM NUDGE: ${u.fiDocCount} document${u.fiDocCount!==1?'s':''} in Field Intelligence — good start. ${u.hasTeammates?'':'Consider inviting a teammate — shared intel compounds fast and means not all the work falls on one rep.'}`);
      if(!u.hasTeammates&&u.fiDocCount>0)nudges.push(`PLATFORM NUDGE: Working solo in Field Intelligence. Mention that inviting one teammate can double the intel without doubling the work.`);
      if(u.accountCount>0&&!u.hasGoals)nudges.push(`PLATFORM NUDGE: Has accounts but no Q2 goals set. A goal without a tactic is just a wish — the morning brief gets dramatically more specific once goals are loaded.`);
      if(u.hasGoals&&!u.hasTactics)nudges.push(`PLATFORM NUDGE: Goals are set but no tactics added yet. Encourage adding 2-3 concrete tactics — that's where the accountability loop closes.`);
      if(!u.journaledYesterday&&u.accountCount>0)nudges.push(`PLATFORM NUDGE: No evening check-in yesterday. Reps who debrief daily improve faster — the Evening Journal button is on the Today panel.`);
    }
    if(nudges.length>0)platformCtx=`PLATFORM COACHING SIGNALS (weave 1-2 naturally into the brief, don't list them mechanically):\n${nudges.slice(0,2).join('\n')}`;
  }
  let acctCtx='';
  if(accounts?.length){
    acctCtx=`ACCOUNTS:\n${accounts.slice(0,8).map(a=>{
      const lastCall=a.calls?.slice(-1)[0];
      const nextStep=a.nextStep||lastCall?.nextStep||'';
      const nextDate=lastCall?.nextStepDate||'';
      const nca=a.strategy?.nextCustomerAction||'';
      const ncaDate=a.strategy?.nextCustomerActionDate||'';
      const pm=a.strategy?.processMap;
      const currentStage=pm?.stages?.[pm.currentStageIndex]?.label||'';
      const status=a.strategy?.status||'';
      return `- ${a.name}${a.location?' ('+a.location+')':''}${status?' ['+status+']':''}${currentStage?' | Stage: '+currentStage:''}${nca?' | Next customer action: '+nca+(ncaDate?' by '+ncaDate:''):''}${!nca&&nextStep?' | Rep next step: '+nextStep:''}`;
    }).join('\n')}`;
  }

  // Build goals context
  let goalsCtx='';
  if(quarter?.goals?.length){
    goalsCtx=`CURRENT QUARTERLY SPRINT GOALS:\n${quarter.goals.map(g=>{
      const overdueTactics=(g.tactics||[]).filter(t=>!t.done&&t.dueDate&&new Date(t.dueDate)<new Date());
      const todayTactics=(g.tactics||[]).filter(t=>!t.done&&t.dueDate&&new Date(t.dueDate+'T23:59:59').toDateString()===new Date().toDateString());
      return `- ${g.text} (${g.progressPct||0}% complete)${overdueTactics.length?' — '+overdueTactics.length+' overdue':''}${todayTactics.length?' — '+todayTactics.length+' due today':''}`;
    }).join('\n')}`;
  }

  // Build ProScan context — supports both legacy flat format and new three-self format
  let proscanCtx='';
  if(proscan){
    const ns=proscan.naturalSelf||proscan; // backward compat with old flat format
    const pe=proscan.priorityEnvironment||{};
    const os=proscan.outwardSelf||{};
    const cp=proscan.coachingProfile||{};
    const em=cp.energyManagement||{};
    const overrides=proscan.overrides||[];
    const calibration=proscan.calibrationNotes||[];

    // Core natural traits (works for both old and new format)
    const dom=ns.dominance||ns.dominanceDesc||'not specified';
    const ext=ns.extroversion||ns.extroversionDesc||'not specified';
    const pac=ns.pace||ns.paceDesc||'not specified';
    const con=ns.conformity||ns.conformityDesc||'not specified';
    const logic=ns.logicStyle||proscan.logicStyle||'not specified';
    const energy=ns.primaryEnergyStyle||proscan.energyStyle||'not specified';
    const kZone=ns.kineticEnergyZone||proscan.kineticEnergyZone||'not specified';
    const backup=ns.backupStyleDesc||ns.backupStyle||proscan.backupStyle||'not specified';
    const dominant=ns.dominantTrait||proscan.dominantTrait||'not specified';

    // Stress and energy state
    const availZone=pe.availableEnergyZone||'not specified';
    const tankGap=pe.tankGapAnalysis||'';
    const stressAdj=(pe.stressAdjustments||[]).filter(a=>a.isSignificant).map(a=>`${a.trait} (${a.direction}${a.isOppositeOfNatural?' — opposite of natural':''})`).join(', ');
    const energyDrain=pe.energyDrain||'not specified';
    const satLevel=pe.satisfactionLevel||'not specified';

    // Coaching profile
    const prepTend=cp.prepTendency||proscan.prepTendency||'not specified';
    const feedbackStyle=cp.feedbackStyle||'not specified';
    const coachRisks=(cp.coachingRisks||[]).join('; ');
    const coldCall=cp.coldCallProfile||proscan.coldCallChallenges||'not specified';
    const challengerFit=cp.challengerFit||proscan.challengerFit||'not specified';
    const recharge=em.rechargeStyle||'not specified';
    const depletion=em.depletionPattern||'not specified';
    const optimalStructure=em.optimalWorkStructure||'not specified';
    const tankWarnings=(em.warningSignsTankIsLow||[]).join('; ');
    const homeVsWork=cp.homeVsWorkInsight||'not specified';

    // Overrides — rep has flagged these as inaccurate
    const overrideCtx=overrides.length?`\nREP OVERRIDES (rep disagrees with these ProScan points — use their own description instead):\n${overrides.map(o=>`- ${o.field}: Rep says "${o.repDescription}" (not "${o.originalValue}")`).join('\n')}`:'';
    const calibCtx=calibration.length?`\nCOACHING CALIBRATION NOTES:\n${calibration.map(c=>`- ${c.note}`).join('\n')}`:'';

    proscanCtx=`REP BEHAVIORAL PROFILE (ProScan — Three-Self Model):

NATURAL SELF (factory settings — stable, who they are at home and when relaxed):
Dominant trait: ${dominant} | Dominance: ${dom} | Extroversion: ${ext} | Pace: ${pac} | Conformity: ${con}
Logic style: ${logic} — ${ns.logicDesc||''}
Energy style: ${energy} (alternate: ${ns.alternateEnergyStyle||'none'}) — ${ns.energyStyleDesc||''}
Natural energy tank: Zone ${kZone} — ${ns.kineticEnergyDesc||''}
Communication: ${ns.communicationStyle||''} — needs from others: ${(ns.whatTheyNeedFromOthers||[]).join(', ')}
Backup style under pressure: ${backup}
Backup warning signals: ${(ns.backupStyleWarningSignals||[]).join('; ')}
Growth edges: ${(ns.learnedResponsesToDevelop||[]).join('; ')}
Motivators: ${(ns.motivators||[]).join(', ')} | Demotivators: ${(ns.demotivators||[]).join(', ')}
${cp.motivatorCoachingLevers?.length?`Motivator coaching levers:\n${cp.motivatorCoachingLevers.map(m=>'  • '+m).join('\n')}`:''}${cp.demotivatorWarnings?.length?`\nDemotivator warnings:\n${cp.demotivatorWarnings.map(d=>'  • '+d).join('\n')}`:''}${cp.pressureBehaviors?.underPressureDescription?`\nPRESSURE BEHAVIORS:\nUnder pressure: ${cp.pressureBehaviors.underPressureDescription}\nEarly warning signals: ${(cp.pressureBehaviors.earlyWarningSignals||[]).join('; ')}\nTrigger situations: ${(cp.pressureBehaviors.triggerSituations||[]).join('; ')}\nSelf-management tip: ${cp.pressureBehaviors.selfManagementTip||''}`:''}

CURRENT STRESS STATE (Priority Environment):
Overall stress: ${pe.overallStressLevel||'not specified'} | Satisfaction: ${satLevel} | Energy drain: ${energyDrain}
Available energy right now: Zone ${availZone} — ${pe.availableEnergyDesc||''}
${tankGap?`Tank gap insight: ${tankGap}`:''}
${stressAdj?`Significant stress adjustments (traits being forced away from natural): ${stressAdj}`:''}
${pe.dimensionalAdjustment?`Dimensional adjustment: ${pe.dimensionalAdjustment}`:''}

HOW OTHERS SEE THEM NOW (Outward Self):
${os.outwardSelfSummary||'not specified'}
${os.gapInsight?`Gap insight: ${os.gapInsight}`:''}

COACHING IMPLICATIONS:
Prep tendency: ${prepTend} | Most productive time: ${productiveTimeLabel}
Cold call profile: ${coldCall}
Challenger fit: ${challengerFit}
How to deliver feedback to this rep: ${feedbackStyle}
Coaching risks to avoid: ${coachRisks}
Energy recharge style: ${recharge}
Depletion pattern: ${depletion}
Optimal work structure: ${optimalStructure}
Low tank warning signs: ${tankWarnings}
Home vs work: ${homeVsWork}
${overrideCtx}${calibCtx}`;
  }

  // Friday energy-aware recovery context
  let fridayEnergyCtx='';
  if(isFriday&&proscan){
    const ns=proscan.naturalSelf||proscan;
    const pe=proscan.priorityEnvironment||{};
    const cp=proscan.coachingProfile||{};
    const em=cp.energyManagement||{};
    const kZone=ns.kineticEnergyZone||proscan.kineticEnergyZone||4;
    const availZone=pe.availableEnergyZone||kZone;
    const energyStyle=ns.primaryEnergyStyle||proscan.energyStyle||'';
    const rechargeStyle=em.rechargeStyle||'';
    const depletionPattern=em.depletionPattern||'';
    const tankWarnings=(em.warningSignsTankIsLow||[]).join('; ');
    const bigTank=kZone>=5;
    const medTank=kZone>=3&&kZone<5;
    const tankDepleted=availZone<=2;
    fridayEnergyCtx=`FRIDAY RECOVERY (use to personalize weekend message):\nNatural tank: Zone ${kZone}/7 (${bigTank?'LARGE — high capacity':medTank?'MODERATE':'SMALLER'})\nAvailable now: Zone ${availZone}/7 (${tankDepleted?'NEARLY EMPTY — urgent':'ok'})\nEnergy style: ${energyStyle} | Recharge: ${rechargeStyle||'not specified'}\nDepletion pattern: ${depletionPattern||'not specified'}\n${tankWarnings?'Low tank signals: '+tankWarnings:''}\n${bigTank?'BIG TANK: Large tanks feel like they can keep going \u2014 that is the trap. The cost accumulates invisibly. Be direct with this rep: shut it down completely this weekend. No emails, no deal thinking. Connect with family and friends. Big tanks refill through people and genuine rest, not momentum.':''}\n${medTank?'MODERATE TANK: That Friday tiredness is real. Full disconnect this weekend. Honor it.':''}\n${tankDepleted?'CRITICAL LOW (Zone '+availZone+'): Running on fumes. This weekend is required maintenance. Be direct and strong.':''}\n${energyStyle==='thrust'?'THRUST: Sprint-crash pattern. Half-rest does not work. Needs a clean full stop, not gradual wind-down.':''}\n${energyStyle==='allegiance'?'ALLEGIANCE: Needs closure before disconnecting. Suggest a Friday wrap ritual to mentally close the week.':''}\n${energyStyle==='stenacity'?'STENACITY: Locomotive — hardest to stop. Needs explicit permission and a specific end-of-day signal that work is done.':''}`;
  }

  const prompt=`You are a personal sales coach writing a morning brief for a medical device rep. Today is ${today}.

REP: ${repName||'Rep'}, selling ${products||'medical devices'}, territory: ${territory||'not specified'}

${proscanCtx}
${acctCtx}
${goalsCtx}
${territoryCtx}
${journalCtx}
${weeklyScoreCtx}
${platformCtx}
${quarterEndCtx}
${expenseCtx}
${fridayEnergyCtx}

Write a morning brief in this EXACT format — use line breaks between sections, keep it warm, direct, and energizing. Do NOT use markdown headers or bullet symbols — use plain text with emoji:

🌟 [One powerful motivational quote relevant to sales or performance — attributed to a real person. Pick from a WIDE range of people: scientists, athletes, coaches, military leaders, artists, entrepreneurs, philosophers, historical figures. Vary the source every day — never use Bobby Unser, Vince Lombardi, or Wayne Gretzky. Today is ${today} — use the date to seed variety.]

✅ WHAT'S LOOKING GOOD
[2-3 sentences about what's going well — reference specific accounts, goal progress, or wins from yesterday's journal if available. Be specific and genuine.]

📋 TODAY'S FOCUS
[2-4 specific things to get done today. IMPORTANT: Frame around customer actions wherever possible — not "I need to follow up with Dr. Smith" but "I need to create the conditions for Dr. Smith to [next customer action]." Reference actual accounts and their current stage. If yesterday's journal mentioned follow-up items, include those. Numbered list, plain text.${expenseCtx?' If expense report is overdue and today looks light, include it as a numbered item.':''}]

🔮 ON THE HORIZON
[1-2 sentences about upcoming priorities — territory items due soon, goal deadlines, or manager relationships to nurture.${quarterEndCtx?' ADDRESS THE QUARTER END SITUATION here — be direct and specific.':''}]

🧠 TODAY'S COACHING
[3-5 sentences of coaching personalized to this rep. Choose ONE of the following angles based on what's most relevant today — do NOT try to cover all of them:
• If they have accounts stuck at a specific stage: coach them on what customer action would move that account forward and how their ProScan wiring affects their approach
• If they have adoption accounts with flat volume: coach them on which of the four levers is likely the constraint (surgeon capacity, referral flow, institutional momentum, or program visibility) and what the customer needs to DO
• If their journal revealed a challenge: coach them directly on it through the lens of their profile
• If it's a fresh week or there's no specific account focus: coach on their Challenger friction point — the specific stage where their wiring will want to pull the punch, and what to do when they feel it
Reference their specific traits by name. ${isMonday?'It is Monday — set the tone for the week. Remind them to make sure their weekly recurring tactics are set up to track this week.':isFriday?'It is Friday — the most important coaching moment of the week. Do THREE things: (1) Celebrate specific wins from this week by name. (2) Be direct about accountability: before you log off, go to your 90-Day Goals and honestly score your weekly tactics. No partial credit. The score only means something if it is honest. (3) USE THE FRIDAY RECOVERY COACHING section above to personalize the weekend message to their energy style and tank level. If they have a big tank, tell them directly their tank is large and that is exactly why they need to fully shut down — big tanks can push through weekends without feeling the cost until it compounds. Name their energy style and what recovery looks like for them specifically.':isWeekend?'It is the weekend — encourage real rest. The best reps recharge fully, not halfway.':'Mid-week momentum — be direct and specific.'}
At least once per week, challenge them to schedule a STRATEGIC BLOCK — ${productiveTimeLabel} when they do their best thinking, zero distractions, dedicated purely to thinking about their business.${quarterEndCtx&&daysLeftInQuarter<=14?' Use the Strategic Block for quarterly sprint planning this week.':''}]

💪 [One punchy, specific, personalized call to action — 1-2 sentences. Make it visceral and tied to their actual situation. Never generic. ${isFriday?'On Fridays this should always include a direct nudge to score their weekly tactics honestly before they log off.':''}]

Keep the entire brief under 380 words. Warm, human, direct. No corporate speak.`;

  try{
    const cr=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:900,messages:[{role:'user',content:prompt}]})
    });
    const cd=await cr.json();
    if(cd.error)return res.status(500).json({error:cd.error.message});
    const brief=cd.content?.map(b=>b.text||'').join('')||'';
    res.json({brief,date:new Date().toDateString()});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── PROXIES ───────────────────────────────────────────────────
app.post('/proxy/claude',authMiddleware,async(req,res)=>{
  try{const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify(req.body)});res.json(await r.json());}catch(e){res.status(500).json({error:e.message});}
});
app.post('/proxy/tts',async(req,res)=>{
  const{text,voiceId}=req.body;if(!text||!voiceId)return res.status(400).json({error:'text and voiceId required'});
  try{const r=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,{method:'POST',headers:{'Content-Type':'application/json','xi-api-key':ELEVENLABS_KEY},body:JSON.stringify({text,model_id:'eleven_monolingual_v1',voice_settings:{stability:0.5,similarity_boost:0.75}})});if(!r.ok){const e=await r.text();return res.status(r.status).json({error:e});}const buf=await r.arrayBuffer();res.set('Content-Type','audio/mpeg');res.send(Buffer.from(buf));}catch(e){res.status(500).json({error:e.message});}
});
app.post('/proxy/elevenlabs/:voiceId',async(req,res)=>{
  try{const r=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${req.params.voiceId}`,{method:'POST',headers:{'xi-api-key':ELEVENLABS_KEY,'Content-Type':'application/json'},body:JSON.stringify(req.body)});if(!r.ok){res.status(r.status).json({error:'ElevenLabs error'});return;}const buf=await r.arrayBuffer();res.set('Content-Type','audio/mpeg');res.send(Buffer.from(buf));}catch(e){res.status(500).json({error:e.message});}
});

// ── EXTRACTION PROMPTS ────────────────────────────────────────
function getExtractionPrompt(category){
  const p={
    clinicalStudies:`You are a medical device sales intelligence analyst. Extract ALL clinically and commercially relevant data from this study — including data the authors did NOT emphasize as primary findings.

CRITICAL: Medical device reps need the data that reveals gaps in current standard of care, not just what the authors wanted to prove. Look specifically for:
- Treatment completion/compliance rates (what % of patients actually completed treatment?)
- Patients who did NOT receive treatment and why (delays, toxicity, performance status, logistics)
- Control arm or standard-of-care arm data that reveals gaps or failures
- Secondary endpoint data, subgroup analyses, and footnote statistics
- Complication rates, toxicity rates, reoperation rates from competing approaches
- Time-to-treatment delays and their consequences
- Any number that shows the PROBLEM that a better solution would fix

Return ONLY valid JSON:
{
  "title": "full study title",
  "authors": "first author et al",
  "year": "publication year",
  "journal": "journal name",
  "studyType": "prospective|retrospective|RCT|meta-analysis|case series",
  "sampleSize": "n=X",
  "patientPopulation": "specific patient description",
  "primaryEndpoint": "what the study was designed to measure",
  "keyFindings": "2-3 sentence summary of primary results with specific numbers",
  "hiddenGoldData": "the most commercially powerful data NOT in the abstract — treatment gaps, completion failures, control arm weaknesses, buried secondary data. Quote specific percentages and numbers. This is the most important field.",
  "treatmentCompletionRate": "% of patients who actually completed the intended treatment (if reported)",
  "standardOfCareGaps": "specific data showing failures, delays, or inadequacies in the control/standard arm",
  "outcomes": "key outcome data with specific numbers and p-values",
  "clinicalImplication": "what this means for patient care",
  "limitations": "study limitations the authors acknowledged",
  "salesInsight": "how a rep should use this study in a sales conversation — specifically what question to ask the physician",
  "challengerAngle": "the provocative reframe this data enables — what does this data reveal that physicians may not be thinking about?",
  "gaps": ["what important data was missing or not reported"]
}`,
    competitive:`Extract competitive intel. Return ONLY valid JSON: {"competitorName":"","productCategory":"","keyWeaknesses":[],"clinicalData":"","knownIssues":"","marketPositioning":"","salesInsight":"","gaps":[]}`,
    product:`Extract product info. Return ONLY valid JSON: {"productName":"","indication":"","keyBenefits":[],"clinicalClaims":[],"differentiators":[],"targetPatient":"","summary":"","gaps":[]}`,
    objections:`Extract objections. Return ONLY valid JSON: {"objections":[{"objection":"","response":"","category":"price|clinical|competitive|access"}],"gaps":[]}`,
    reimbursement:`Extract reimbursement info. Return ONLY valid JSON: {"title":"","codes":[{"code":"","description":"","reimbursementRate":""}],"payerCoverage":"","priorAuth":"","financialValue":"","content":"","gaps":[]}`,
    insights:`Extract insight info. Return ONLY valid JSON: {"title":"","problemStatement":"","reframe":"","evidence":"","solution":"","targetSpecialty":"","bestPersonas":[],"talkingPoints":[],"gaps":[]}`
  };return p[category]||p.product;
}

// ══════════════════════════════════════════════════════════════
// STRIPE BILLING
// Pricing tiers (tracked by rep count in Supabase billing_meta):
//   Founding 10  → 100% coupon, no expiry
//   Next 40      → 100% coupon, 12 months
//   Next 50      → $50/mo coupon, 12 months
//   Full price   → $89/mo, no coupon
// Env vars needed: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, APP_URL
// ══════════════════════════════════════════════════════════════

const STRIPE_BASE = 'https://api.stripe.com/v1';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || ''; // $89/mo recurring price ID from Stripe dashboard

// Stripe helper — urlencoded POST
async function stripePost(path, params) {
  if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured');
  const body = new URLSearchParams(params).toString();
  const r = await fetch(`${STRIPE_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Stripe ${path} failed: ${r.status}`);
  return data;
}

// Stripe helper — GET
async function stripeGet(path) {
  if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured');
  const r = await fetch(`${STRIPE_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Stripe GET ${path} failed: ${r.status}`);
  return data;
}

// Determine which coupon to apply based on current paid subscriber count
async function getOnboardingCoupon() {
  try {
    const rows = await sbGet('billing_meta', '?select=total_paid_subs&limit=1');
    const count = rows[0]?.total_paid_subs || 0;
    // count includes both Stripe checkouts AND admin comps for founding tiers
    // Founding 10: first 10 total (slots 1-10)
    // Founding 40: next 40 total (slots 11-50)
    // Founding 50: next 50 total (slots 51-100)
    if (count < 10)  return process.env.STRIPE_COUPON_FOUNDING_10  || null; // 100% off, forever
    if (count < 50)  return process.env.STRIPE_COUPON_FOUNDING_40  || null; // 100% off, 12mo
    if (count < 100) return process.env.STRIPE_COUPON_FOUNDING_50  || null; // $50 off, 12mo
    return null; // full price
  } catch(e) {
    console.error('[STRIPE] getOnboardingCoupon error:', e.message);
    return null;
  }
}

// Simple Stripe webhook signature verify (no stripe-node library)
function verifyStripeWebhook(rawBody, sigHeader, secret) {
  if (!secret) return true; // skip verification if secret not configured (dev only)
  const parts = sigHeader.split(',').reduce((acc, p) => {
    const [k,v] = p.split('='); acc[k] = v; return acc;
  }, {});
  const ts = parts.t;
  const sig = parts.v1;
  const payload = `${ts}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return expected === sig;
}

// POST /billing/confirm-session — verify checkout session directly with Stripe
// Called immediately after redirect — faster than waiting for webhook
app.post('/billing/confirm-session', authMiddleware, async (req, res) => {
  const { sessionId, email } = req.body;
  if (!sessionId || !email) return res.status(400).json({ error: 'sessionId and email required' });
  try {
    const session = await stripeGet(`/checkout/sessions/${sessionId}`);
    if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
      const sub = await stripeGet(`/subscriptions/${session.subscription}`);
      // Determine tier
      const rows = await sbGet('billing_meta', '?select=total_paid_subs&limit=1');
      const count = rows[0]?.total_paid_subs || 0;
      let tier = 'paid';
      if (count <= 10) tier = 'founding_10';
      else if (count <= 50) tier = 'founding_40';
      else if (count <= 100) tier = 'founding_50';

      await sbUpsert('rep_billing', {
        email,
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
        plan: 'pro',
        tier,
        subscription_status: sub.status,
        current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      });
      res.json({ confirmed: true, plan: 'pro', tier, status: sub.status, currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString() });
    } else {
      res.json({ confirmed: false, paymentStatus: session.payment_status });
    }
  } catch(e) {
    console.error('[STRIPE] confirm-session error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /billing/status — returns plan info for a rep email
app.get('/billing/status', authMiddleware, async (req, res) => {
  const email = req.query.email;
  if (!email) return res.json({ plan: 'none', status: 'inactive' });
  try {
    const rows = await sbGet('rep_billing', `?email=eq.${encodeURIComponent(email)}&limit=1`);
    const b = rows[0];
    if (!b) return res.json({ plan: 'none', status: 'inactive' });
    res.json({
      plan: b.plan || 'none',
      status: b.subscription_status || 'inactive',
      tier: b.tier || 'none',
      trialEnd: b.trial_end || null,
      currentPeriodEnd: b.current_period_end || null,
    });
  } catch(e) {
    res.json({ plan: 'none', status: 'inactive' });
  }
});

// POST /billing/create-checkout — create a Stripe Checkout session
app.post('/billing/create-checkout', authMiddleware, async (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe not configured' });
  if (!STRIPE_PRICE_ID)   return res.status(500).json({ error: 'STRIPE_PRICE_ID not configured' });

  try {
    // Find or create Stripe customer
    let customerId;
    try {
      const rows = await sbGet('rep_billing', `?email=eq.${encodeURIComponent(email)}&limit=1`);
      customerId = rows[0]?.stripe_customer_id;
    } catch(e) {}

    if (!customerId) {
      const customer = await stripePost('/customers', { email, name: name || email });
      customerId = customer.id;
    }

    // Get applicable coupon
    const couponId = await getOnboardingCoupon();

    // Build checkout params
    const params = {
      'payment_method_types[]': 'card',
      'mode': 'subscription',
      'customer': customerId,
      'line_items[0][price]': STRIPE_PRICE_ID,
      'line_items[0][quantity]': '1',
      'success_url': `${APP_URL}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      'cancel_url': `${APP_URL}?checkout=cancel`,
      'customer_update[address]': 'auto',
    };
    if (couponId) {
      params['discounts[0][coupon]'] = couponId;
    } else {
      params['allow_promotion_codes'] = 'true';
    }

    const session = await stripePost('/checkout/sessions', params);
    res.json({ url: session.url, sessionId: session.id });
  } catch(e) {
    console.error('[STRIPE] create-checkout error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /billing/portal — create a Stripe customer portal session
app.post('/billing/portal', authMiddleware, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const rows = await sbGet('rep_billing', `?email=eq.${encodeURIComponent(email)}&limit=1`);
    const customerId = rows[0]?.stripe_customer_id;
    if (!customerId) return res.status(404).json({ error: 'No billing account found' });
    const session = await stripePost('/billing_portal/sessions', {
      customer: customerId,
      return_url: APP_URL,
    });
    res.json({ url: session.url });
  } catch(e) {
    console.error('[STRIPE] portal error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /stripe/webhook — handle Stripe events
app.post('/stripe/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!verifyStripeWebhook(req.rawBody, sig || '', STRIPE_WEBHOOK_SECRET)) {
    console.error('[STRIPE] Webhook signature mismatch');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try { event = JSON.parse(req.rawBody.toString('utf8')); }
  catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const obj = event.data?.object;

  try {
    if (event.type === 'checkout.session.completed') {
      // Subscription started — fetch subscription details
      const sub = await stripeGet(`/subscriptions/${obj.subscription}`);
      const customer = await stripeGet(`/customers/${obj.customer}`);
      const email = customer.email;

      // Determine tier label
      const rows = await sbGet('billing_meta', '?select=total_paid_subs&limit=1');
      const count = (rows[0]?.total_paid_subs || 0) + 1;
      let tier = 'paid';
      if (count <= 10)       tier = 'founding_10';
      else if (count <= 50)  tier = 'founding_40';
      else if (count <= 100) tier = 'founding_50';

      await sbUpsert('rep_billing', {
        email,
        stripe_customer_id: obj.customer,
        stripe_subscription_id: obj.subscription,
        plan: 'pro',
        tier,
        subscription_status: sub.status,
        current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Increment global paid sub count
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_paid_subs`, {
        method: 'POST',
        headers: { ...SB_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      console.log(`[STRIPE] New subscriber: ${email} (${tier})`);
    }

    if (event.type === 'customer.subscription.updated') {
      const customer = await stripeGet(`/customers/${obj.customer}`);
      await sbUpsert('rep_billing', {
        email: customer.email,
        stripe_customer_id: obj.customer,
        stripe_subscription_id: obj.id,
        subscription_status: obj.status,
        current_period_end: new Date(obj.current_period_end * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    if (event.type === 'customer.subscription.deleted') {
      const customer = await stripeGet(`/customers/${obj.customer}`);
      await sbUpsert('rep_billing', {
        email: customer.email,
        stripe_customer_id: obj.customer,
        stripe_subscription_id: obj.id,
        plan: 'none',
        subscription_status: 'canceled',
        updated_at: new Date().toISOString(),
      });
      console.log(`[STRIPE] Canceled: ${customer.email}`);
    }

    if (event.type === 'invoice.payment_failed') {
      const customer = await stripeGet(`/customers/${obj.customer}`);
      await sbUpsert('rep_billing', {
        email: customer.email,
        stripe_customer_id: obj.customer,
        subscription_status: 'past_due',
        updated_at: new Date().toISOString(),
      });
    }
  } catch(e) {
    console.error('[STRIPE] Webhook handler error:', e.message);
    // Return 200 to prevent Stripe retrying — log error for debugging
  }

  res.json({ received: true });
});

// ══════════════════════════════════════════════════════════════
// ADMIN — Comp / Manual Pro Access
// Protected by ADMIN_SECRET header (separate from app password)
// ══════════════════════════════════════════════════════════════

function adminAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!ADMIN_SECRET) return res.status(500).json({ error: 'ADMIN_SECRET not configured on server' });
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Invalid admin secret' });
  next();
}

// POST /admin/comp — grant Pro access to any email
app.post('/admin/comp', adminAuth, async (req, res) => {
  const { email, tier, expiryDate, note } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  const validTiers = ['founding_10', 'founding_40', 'comp_30', 'comp_90', 'comp_custom', 'paid'];
  if (!validTiers.includes(tier)) return res.status(400).json({ error: `Invalid tier. Must be one of: ${validTiers.join(', ')}` });

  let expiry = null;
  if (tier === 'comp_30') {
    expiry = new Date(Date.now() + 30*24*60*60*1000).toISOString();
  } else if (tier === 'comp_90') {
    expiry = new Date(Date.now() + 90*24*60*60*1000).toISOString();
  } else if (tier === 'comp_custom' && expiryDate) {
    expiry = new Date(expiryDate).toISOString();
  } else if (tier === 'founding_40') {
    expiry = new Date(Date.now() + 365*24*60*60*1000).toISOString();
  }

  try {
    await sbUpsert('rep_billing', {
      email,
      plan: 'pro',
      tier,
      subscription_status: 'active',
      current_period_end: expiry,
      comp_note: note || null,
      comp_granted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    // Increment global counter for founding tiers so checkout coupon logic stays accurate
    if (tier === 'founding_10' || tier === 'founding_40') {
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_paid_subs`, {
        method: 'POST',
        headers: { ...SB_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    }
    console.log(`[ADMIN COMP] ${email} → ${tier}${expiry ? ' expires ' + expiry : ' (no expiry)'}`);
    res.json({ success: true, email, tier, expiry });
  } catch(e) {
    console.error('[ADMIN COMP] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/revoke — remove Pro access
app.post('/admin/revoke', adminAuth, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    await sbUpsert('rep_billing', {
      email,
      plan: 'none',
      subscription_status: 'canceled',
      updated_at: new Date().toISOString(),
    });
    console.log(`[ADMIN REVOKE] ${email}`);
    res.json({ success: true, email });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/proscan-invite — mark ProScan invite as sent (or clear it)
app.post('/admin/proscan-invite', adminAuth, async (req, res) => {
  const { email, sent } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    await sbUpsert('rep_profiles', {
      email,
      proscan_invited_at: sent ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    });
    console.log(`[ADMIN PROSCAN INVITE] ${email} → ${sent ? 'sent' : 'cleared'}`);
    res.json({ success: true, email, sent });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/members — list all Pro members with ProScan status
app.get(`/admin/members`, adminAuth, async (req, res) => {
  try {
    const rows = await sbGet(`rep_billing`, `?order=updated_at.desc`);
    let profiles = [];
    try { profiles = await sbGet(`rep_profiles`, `?select=email,name,proscan_uploaded_at,proscan_invited_at`); } catch(e) {}
    const profileMap = {};
    profiles.forEach(p => { profileMap[p.email] = p; });
    const members = rows.map(m => ({
      ...m,
      rep_name: profileMap[m.email]?.name || null,
      proscan_uploaded_at: profileMap[m.email]?.proscan_uploaded_at || null,
      proscan_invited_at: profileMap[m.email]?.proscan_invited_at || null,
      has_proscan: !!(profileMap[m.email]?.proscan_uploaded_at),
    }));
    res.json({ members });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WELCOME EMAIL ────────────────────────────────────────────
function buildWelcomeEmail(name, products) {
  const firstName = name.split(' ')[0];
  const productLine = products ? `<p style="color:#555;font-size:14px;margin:0 0 20px;">I see you're working with <strong>${products}</strong> — the coaching will be personalized to your products and territory.</p>` : '';
  
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 20px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

  <!-- Header -->
  <tr><td style="background:#0a0c0f;border-radius:12px 12px 0 0;padding:32px 40px;text-align:center;">
    <p style="color:#00c9a7;font-size:11px;letter-spacing:3px;text-transform:uppercase;margin:0 0 8px;">Welcome to</p>
    <h1 style="color:#ffffff;font-size:28px;margin:0;font-weight:800;">MedDevice<span style="color:#00c9a7;font-style:italic;">SalesPro</span></h1>
    <p style="color:#9199aa;font-size:13px;margin:8px 0 0;">by Conceromed</p>
  </td></tr>

  <!-- Body -->
  <tr><td style="background:#ffffff;padding:40px;">
    <p style="font-size:16px;color:#1a1a2e;margin:0 0 16px;">Hi ${firstName},</p>
    <p style="font-size:15px;color:#333;line-height:1.7;margin:0 0 16px;">You're here because you want to be the best. Not just good — the best. The rep who walks into every call prepared, who understands their own wiring, who practices when no one is watching, and who wins because they outworked and out-thought everyone in their territory.</p>
    <p style="font-size:15px;color:#333;line-height:1.7;margin:0 0 16px;">That's exactly who I built this for. I spent 20+ years leading medical device sales teams and watching talented reps plateau — not because they lacked ability, but because no one ever coached them the way they were actually wired. MedDeviceSalesPro is the tool I wish every one of them had.</p>
    <p style="font-size:15px;color:#333;line-height:1.7;margin:0 0 16px;">This platform will challenge you to invest in yourself — your skills, your self-awareness, your preparation. That investment compounds. The reps who do the work here show up to every call differently than the ones who don't.</p>
    <p style="font-size:15px;color:#333;line-height:1.7;margin:0 0 24px;">Here's how to get started — and I'd encourage you to take each step seriously:</p>
    ${productLine}

    <!-- Step 1 -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
    <tr>
      <td width="48" valign="top" style="padding-top:2px;">
        <div style="width:36px;height:36px;border-radius:50%;background:#00c9a7;color:#000;font-weight:800;font-size:16px;text-align:center;line-height:36px;">1</div>
      </td>
      <td style="padding-left:12px;">
        <p style="font-size:15px;font-weight:700;color:#1a1a2e;margin:0 0 4px;">Take Your ProScan Assessment</p>
        <p style="font-size:14px;color:#555;line-height:1.6;margin:0;">This is the most important first step. ProScan tells the AI how you're wired — your dominant traits, how you perform under stress, and where your blind spots are. Every coaching session becomes personalized to <em>you</em>, not a generic rep. And here's the best part: <strong>you own this data forever</strong>, even if you ever cancel.</p>
        <p style="margin:8px 0 0;"><a href="https://www.pdp.guru" style="color:#00c9a7;font-weight:600;">Take your ProScan →</a></p>
        <p style="font-size:13px;color:#888;margin:4px 0 0;">Once complete, upload your PDF from your profile settings.</p>
      </td>
    </tr>
    </table>

    <!-- Step 2 -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
    <tr>
      <td width="48" valign="top" style="padding-top:2px;">
        <div style="width:36px;height:36px;border-radius:50%;background:#f0a500;color:#000;font-weight:800;font-size:16px;text-align:center;line-height:36px;">2</div>
      </td>
      <td style="padding-left:12px;">
        <p style="font-size:15px;font-weight:700;color:#1a1a2e;margin:0 0 4px;">Set Your 90-Day Goals</p>
        <p style="font-size:14px;color:#555;line-height:1.6;margin:0;">Block 20 minutes and open the <strong>90-Day Goals</strong> tab. Define what winning this quarter looks like. The AI references these goals in every coaching session — pre-call planning, debriefs, and your daily brief will all be anchored to what you're building toward.</p>
      </td>
    </tr>
    </table>

    <!-- Step 3 -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
    <tr>
      <td width="48" valign="top" style="padding-top:2px;">
        <div style="width:36px;height:36px;border-radius:50%;background:#4caf7d;color:#000;font-weight:800;font-size:16px;text-align:center;line-height:36px;">3</div>
      </td>
      <td style="padding-left:12px;">
        <p style="font-size:15px;font-weight:700;color:#1a1a2e;margin:0 0 4px;">Add Your Key Accounts</p>
        <p style="font-size:14px;color:#555;line-height:1.6;margin:0;">Add the 3–5 accounts that matter most right now. The more context you give about each account — stakeholders, history, objections — the more powerful your pre-call planning becomes. The AI will use this to build targeted Challenger briefs before every call.</p>
      </td>
    </tr>
    </table>

    <!-- Step 4 -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
    <tr>
      <td width="48" valign="top" style="padding-top:2px;">
        <div style="width:36px;height:36px;border-radius:50%;background:#7c5cbf;color:#fff;font-weight:800;font-size:16px;text-align:center;line-height:36px;">4</div>
      </td>
      <td style="padding-left:12px;">
        <p style="font-size:15px;font-weight:700;color:#1a1a2e;margin:0 0 4px;">Load Your Field Intelligence</p>
        <p style="font-size:14px;color:#555;line-height:1.6;margin:0;">Upload your product materials, clinical studies, competitive intel, and objection responses in the <strong>Field Intelligence</strong> tab. This becomes the foundation for your role plays and commercial insights. The richer your library, the sharper your coaching.</p>
      </td>
    </tr>
    </table>

    <!-- Step 5 -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
    <tr>
      <td width="48" valign="top" style="padding-top:2px;">
        <div style="width:36px;height:36px;border-radius:50%;background:#0a0c0f;color:#00c9a7;font-weight:800;font-size:16px;text-align:center;line-height:36px;">5</div>
      </td>
      <td style="padding-left:12px;">
        <p style="font-size:15px;font-weight:700;color:#1a1a2e;margin:0 0 4px;">Invite Your Team</p>
        <p style="font-size:14px;color:#555;line-height:1.6;margin:0;">Once you're getting value, share it. Create a team workspace and invite colleagues — the Field Intelligence becomes shared, objection responses get crowdsourced, and the whole team gets sharper together. The best teams learn from each other. Conceromed makes that systematic.</p>
      </td>
    </tr>
    </table>

    <!-- CTA -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
    <tr><td align="center">
      <a href="https://www.meddevicesalespro.com" style="display:inline-block;background:#00c9a7;color:#000;font-weight:700;font-size:15px;text-decoration:none;padding:14px 32px;border-radius:8px;">Open MedDeviceSalesPro →</a>
    </td></tr>
    </table>

    <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 16px;padding-top:20px;border-top:1px solid #eee;">The reps who get the most out of this platform are the ones who treat it like a serious investment in their career — not a tool they set up and forget. Take the ProScan. Set real goals. Load your intelligence. Practice the calls that make you uncomfortable.</p>
    <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 24px;">That's what separates the reps who plateau from the ones who keep climbing.</p>
    <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 24px;">Reply to this email anytime — you'll reach me directly. I want to know how it's working for you and what would make it better.</p>
    <p style="font-size:15px;color:#333;margin:0;">— Ty Atteberry<br><span style="color:#888;font-size:13px;">Founder, Conceromed</span><br><span style="color:#aaa;font-size:12px;font-style:italic;">Nearly 30 years in medical device sales · Medtronic, Abbott &amp; startups bringing new technologies to market</span></p>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#f4f6f8;border-radius:0 0 12px 12px;padding:20px 40px;text-align:center;">
    <p style="color:#aaa;font-size:11px;margin:0;">MedDeviceSalesPro is a product of Conceromed LLC · <a href="https://www.meddevicesalespro.com" style="color:#aaa;">meddevicesalespro.com</a></p>
    <p style="color:#aaa;font-size:11px;margin:4px 0 0;">You're receiving this because you just created your account.</p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// POST /rep/welcome-email — send welcome email after first profile save
app.post('/rep/welcome-email', authMiddleware, async (req, res) => {
  const { email, name, products } = req.body;
  if (!email || !name) return res.status(400).json({ error: 'email and name required' });

  // Check if we already sent a welcome email (avoid duplicates)
  try {
    const rows = await sbGet('rep_profiles', `?email=eq.${encodeURIComponent(email)}&select=welcome_sent&limit=1`);
    if (rows[0]?.welcome_sent) {
      return res.json({ sent: false, reason: 'already sent' });
    }
  } catch(e) {}

  try {
    const html = buildWelcomeEmail(name, products);
    const result = await sendEmail({
      to: email,
      subject: `${name.split(' ')[0]}, you're in — here's how to get everything out of this`,
      html,
      text: `Hi ${name.split(' ')[0]}, welcome to MedDeviceSalesPro! Here's your getting started guide: 1) Take your ProScan at pdp.guru, 2) Set your 90-day goals, 3) Add your key accounts, 4) Load Field Intelligence, 5) Invite your team. Open the app at meddevicesalespro.com`,
    });

    // Mark welcome email as sent
    if (result.sent) {
      await sbUpsert('rep_profiles', { email, welcome_sent: true, updated_at: new Date().toISOString() }).catch(()=>{});
    }

    res.json(result);
  } catch(e) {
    console.error('[WELCOME EMAIL] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const server=app.listen(PORT,()=>console.log(`Conceromed API v4.8 running on port ${PORT}`));
server.timeout=300000; // 5 min — ProScan extraction with large PDFs needs time
