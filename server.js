// ══════════════════════════════════════════════════════════════
// Conceromed — Backend Server v3.9
// Supabase integration for cross-device sync
// Deploy to Railway · Node 18+ native fetch
// ══════════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY  || '';
const ELEVENLABS_KEY = process.env.ELEVENLABS_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'SalesPro2026';
const SUPABASE_URL   = process.env.SUPABASE_URL   || 'https://ikxtgdwowdchvbwffymw.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_KEY   || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlreHRnZHdvd2RjaHZid2ZmeW13Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzMjQ3NzMsImV4cCI6MjA5MDkwMDc3M30.5f411xR3WG7dsfWWL63OWnDUFBJsYuy3-BBe3t3rze8';

app.use(cors({ origin: '*' }));
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

app.get('/debug',(req,res)=>res.json({hasAnthropicKey:!!ANTHROPIC_KEY,hasElevenLabsKey:!!ELEVENLABS_KEY,hasSupabaseKey:!!SUPABASE_KEY,supabaseUrl:SUPABASE_URL}));
app.get('/',(req,res)=>res.json({status:'Conceromed API',version:'4.5'}));

// ── AUTH ──────────────────────────────────────────────────────
const SESSION_STORE=new Map();
app.post('/auth/login',(req,res)=>{
  if(req.body.password!==ADMIN_PASSWORD)return res.status(401).json({error:'Invalid password'});
  const token=generateCode(24);SESSION_STORE.set(token,{createdAt:Date.now()});res.json({token});
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

// ── REFERRAL SYSTEM ──────────────────────────────────────────
app.post('/rep/referral/generate',authMiddleware,async(req,res)=>{
  const{email}=req.body;
  if(!email)return res.status(400).json({error:'email required'});
  try{
    // Check if already has a code
    const rows=await sbGet('rep_profiles',`?email=eq.${encodeURIComponent(email)}&limit=1`);
    let code=rows[0]?.referral_code;
    if(!code){
      // Generate unique 8-char code
      code=generateCode(8).toUpperCase();
      try{
        await sbUpsert('rep_profiles',{email,referral_code:code,updated_at:new Date().toISOString()});
      }catch(upsertErr){
        // If upsert fails, still return the code — client can cache it
        console.error('Referral code upsert failed:',upsertErr.message);
      }
    }
    // Return code + full status in one response to save a round trip
    const rep=rows[0]||{};
    const count=rep.referral_count||0;
    const bonus=rep.doc_limit_bonus||0;
    res.json({
      code,
      count,
      docLimit:10+bonus,
      bonus,
      isFoundingMember:rep.is_founding_member||false,
    });
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/rep/referral/redeem',authMiddleware,async(req,res)=>{
  const{newUserEmail,referralCode}=req.body;
  if(!newUserEmail||!referralCode)return res.status(400).json({error:'email and code required'});
  try{
    // Find referrer by code
    const rows=await sbGet('rep_profiles',`?referral_code=eq.${encodeURIComponent(referralCode)}&limit=1`);
    if(!rows.length)return res.status(404).json({error:'Invalid referral code'});
    const referrer=rows[0];
    if(referrer.email===newUserEmail)return res.status(400).json({error:'Cannot refer yourself'});
    // Check not already referred
    const newUserRows=await sbGet('rep_profiles',`?email=eq.${encodeURIComponent(newUserEmail)}&limit=1`);
    if(newUserRows[0]?.referred_by)return res.json({already:true,message:'Already redeemed'});
    // Increment referrer count + doc bonus
    const newCount=(referrer.referral_count||0)+1;
    const newBonus=(referrer.doc_limit_bonus||0)+5; // +5 docs per referral
    await sbUpsert('rep_profiles',{
      email:referrer.email,
      referral_count:newCount,
      doc_limit_bonus:newBonus,
      updated_at:new Date().toISOString()
    });
    // Mark new user as referred
    await sbUpsert('rep_profiles',{
      email:newUserEmail,
      referred_by:referralCode,
      updated_at:new Date().toISOString()
    });
    res.json({success:true,referrerEmail:referrer.email,newCount,newDocLimit:10+newBonus});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/rep/referral/status',authMiddleware,async(req,res)=>{
  const email=req.query.email;
  if(!email)return res.status(400).json({error:'email required'});
  try{
    const rows=await sbGet('rep_profiles',`?email=eq.${encodeURIComponent(email)}&limit=1`);
    const rep=rows[0]||{};
    const count=rep.referral_count||0;
    const bonus=rep.doc_limit_bonus||0;
    const docLimit=10+bonus;
    // Doc-based milestones only — no subscription rewards
    const milestones=[
      {at:1,docs:5,label:'5 bonus docs (15 total)'},
      {at:3,docs:15,label:'15 bonus docs (25 total)'},
      {at:5,docs:25,label:'25 bonus docs (35 total)'},
      {at:10,docs:50,label:'50 bonus docs (60 total) — power library'},
    ];
    const nextMilestone=milestones.find(m=>count<m.at)||null;
    const nextReward=nextMilestone?{at:nextMilestone.at,reward:`+${nextMilestone.at*5-bonus} more docs (${10+nextMilestone.at*5} total)`,remaining:nextMilestone.at-count}:null;
    res.json({
      code:rep.referral_code||null,
      count,
      docLimit,
      bonus,
      isFoundingMember:rep.is_founding_member||false,
      nextReward,
    });
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
    "coldCallProfile": "what happens naturally for this person on cold calls — strengths and vulnerabilities",
    "feedbackStyle": "how to deliver feedback so it actually lands for this person — what format, what tone, what to avoid",
    "coachingRisks": ["risk 1 — what could go wrong in coaching if you ignore their profile", "risk 2", "risk 3"],
    "energyManagement": {
      "naturalCapacity": "description of their natural energy tank size based on kinetic zone",
      "rechargeStyle": "how this profile typically recharges — solo vs social, active vs passive",
      "depletionPattern": "how this profile typically burns out — what it looks like before they crash",
      "optimalWorkStructure": "based on energy style and kinetic zone, what does their ideal workday/week structure look like",
      "warningSignsTankIsLow": ["observable warning sign 1", "observable warning sign 2", "observable warning sign 3"]
    },
    "homeVsWorkInsight": "insight on how this profile likely shows up differently at home vs work — what their family/partner probably experiences vs what colleagues experience",
    "managerCoachingCard": {
      "howToMotivate": "2-3 specific things that motivate this rep — actionable for a manager",
      "howToGiveFeedback": "exactly how feedback should be delivered to land well",
      "whatShutsThemDown": "2-3 specific things that will shut this rep down or erode their performance",
      "whatTheyNeedToThrive": "2-3 environmental or structural things this rep needs to do their best work",
      "redFlags": "early warning signs that this rep is struggling — what to watch for before it becomes a problem"
    }
  },

  "overrides": [],
  "calibrationNotes": []
}`;

    const cr=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:4000,messages:[{role:'user',content:[
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
        territoryContacts,territoryActivity,yesterdayJournal}=req.body;
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
    if(yesterdayJournal.summary)journalCtx=`YESTERDAY'S DEBRIEF:\n${yesterdayJournal.summary}`;
    else if(yesterdayJournal.wins||yesterdayJournal.challenges||yesterdayJournal.followUp){
      journalCtx=`YESTERDAY'S DEBRIEF:`;
      if(yesterdayJournal.wins)journalCtx+=`\nWins: ${yesterdayJournal.wins}`;
      if(yesterdayJournal.challenges)journalCtx+=`\nChallenges: ${yesterdayJournal.challenges}`;
      if(yesterdayJournal.learned)journalCtx+=`\nLearned: ${yesterdayJournal.learned}`;
      if(yesterdayJournal.followUp)journalCtx+=`\nFollow-up needed: ${yesterdayJournal.followUp}`;
    }
  }

  // Build account context
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
${quarterEndCtx}
${expenseCtx}
${fridayEnergyCtx}

Write a morning brief in this EXACT format — use line breaks between sections, keep it warm, direct, and energizing. Do NOT use markdown headers or bullet symbols — use plain text with emoji:

🌟 [One powerful motivational quote relevant to sales or performance — attributed to a real person]

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

const server=app.listen(PORT,()=>console.log(`MedDeviceSalesPro API v4.4 running on port ${PORT}`));
server.timeout=120000; // 2 min — ProScan extraction with large PDFs needs time
