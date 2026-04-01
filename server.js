// ══════════════════════════════════════════════════════════════
// MedDevice Sales Coach — Backend Server v2.3
// Module 2: Activity Feed · Email Workflow · Action Items
// Deploy to Railway: railway.app
// Uses Node 18+ native fetch — no node-fetch needed
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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'MedCoach2026';

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const DATA_FILE = path.join(__dirname, 'data.json');
function loadData() { try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e){} return { workspaces:{}, users:{}, activity:{} }; }
function saveData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
function generateCode(length=8) { return crypto.randomBytes(length).toString('hex').toUpperCase().slice(0,length); }

app.get('/debug', (req,res) => res.json({ hasAnthropicKey:!!ANTHROPIC_KEY, anthropicKeyLength:ANTHROPIC_KEY.length, anthropicKeyStart:ANTHROPIC_KEY.substring(0,7), hasElevenLabsKey:!!ELEVENLABS_KEY }));
app.get('/', (req,res) => res.json({ status:'MedDevice Sales Coach API running', version:'2.3' }));

// ── AUTH ──────────────────────────────────────────────────────
const SESSION_STORE = new Map();
app.post('/auth/login', (req,res) => {
  const { password } = req.body;
  if(password !== ADMIN_PASSWORD) return res.status(401).json({ error:'Invalid password' });
  const token = generateCode(24);
  SESSION_STORE.set(token, { createdAt: Date.now() });
  res.json({ token });
});
app.post('/auth/verify', (req,res) => {
  const token = req.headers['x-session-token'];
  res.json({ valid: SESSION_STORE.has(token) || isStatelessToken(token) });
});
function makeStatelessToken() { return crypto.createHmac('sha256', ADMIN_PASSWORD).update('mdsc-session').digest('hex').substring(0,32); }
function isStatelessToken(t) { try { return t === makeStatelessToken(); } catch(e) { return false; } }
function authMiddleware(req,res,next) {
  const token = req.headers['x-session-token'];
  if(!token) return res.status(401).json({ error:'Not authenticated' });
  if(SESSION_STORE.has(token) || isStatelessToken(token)) return next();
  return res.status(401).json({ error:'Not authenticated' });
}

// ── REP PROFILE ───────────────────────────────────────────────
app.get('/config/elkey', authMiddleware, (req,res) => res.json({ key: ELEVENLABS_KEY }));
app.post('/rep/profile', authMiddleware, (req,res) => {
  const data = loadData(); if(!data.reps) data.reps={};
  const token = req.headers['x-session-token'];
  data.reps[token] = { ...req.body, updatedAt: Date.now() };
  saveData(data); res.json({ saved:true });
});
app.get('/rep/profile', authMiddleware, (req,res) => {
  const data = loadData(); const token = req.headers['x-session-token'];
  res.json(data.reps?.[token] || {});
});

// ══════════════════════════════════════════════════════════════
// WORKSPACES
// ══════════════════════════════════════════════════════════════
app.post('/workspaces', authMiddleware, (req,res) => {
  const { name, company, repName, repEmail } = req.body;
  if(!name) return res.status(400).json({ error:'Workspace name required' });
  const data = loadData();
  const id = generateCode(12); const inviteCode = generateCode(6);
  data.workspaces[id] = {
    id, name, company:company||'', createdBy:repEmail||'', createdAt:Date.now(), inviteCode,
    members:[{ name:repName||'', email:repEmail||'', role:'admin', joinedAt:Date.now() }],
    knowledge:{ product:[], clinicalStudies:[], competitive:[], objections:[], reimbursement:[], insights:[] }
  };
  saveData(data); res.json({ workspaceId:id, inviteCode });
});

app.post('/workspaces/join', authMiddleware, (req,res) => {
  const { inviteCode, repName, repEmail } = req.body;
  const data = loadData();
  const workspace = Object.values(data.workspaces).find(w => w.inviteCode === inviteCode?.toUpperCase());
  if(!workspace) return res.status(404).json({ error:'Invalid invite code' });
  if(!workspace.members.find(m => m.email === repEmail)) {
    workspace.members.push({ name:repName||'', email:repEmail||'', role:'member', joinedAt:Date.now() });
    saveData(data);
  }
  res.json({ workspaceId:workspace.id, workspaceName:workspace.name });
});

app.get('/workspaces/:id', authMiddleware, (req,res) => {
  const data = loadData(); const workspace = data.workspaces[req.params.id];
  if(!workspace) return res.status(404).json({ error:'Not found' });
  if(!workspace.knowledge.insights) workspace.knowledge.insights = [];
  res.json(workspace);
});

app.get('/workspaces', authMiddleware, (req,res) => {
  const data = loadData();
  res.json(Object.values(data.workspaces).map(w => ({ id:w.id, name:w.name, company:w.company, members:w.members.length, createdAt:w.createdAt })));
});

// ── MEMBER MANAGEMENT ─────────────────────────────────────────
app.delete('/workspaces/:id/members/:email', authMiddleware, (req,res) => {
  const { id } = req.params;
  const emailToRemove = decodeURIComponent(req.params.email);
  const data = loadData(); const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error:'Not found' });
  const requesterEmail = req.headers['x-requester-email'];
  const requester = workspace.members.find(m => m.email === requesterEmail);
  if(!requester || requester.role !== 'admin') return res.status(403).json({ error:'Only admins can remove members' });
  const targetMember = workspace.members.find(m => m.email === emailToRemove);
  if(!targetMember) return res.status(404).json({ error:'Member not found' });
  if(targetMember.role === 'admin') return res.status(400).json({ error:'Cannot remove the workspace admin. Transfer ownership first.' });
  workspace.members = workspace.members.filter(m => m.email !== emailToRemove);
  saveData(data);
  res.json({ removed:true, name:targetMember.name });
});

app.post('/workspaces/:id/transfer', authMiddleware, (req,res) => {
  const { id } = req.params;
  const { newAdminEmail, requesterEmail } = req.body;
  const data = loadData(); const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error:'Not found' });
  const requester = workspace.members.find(m => m.email === requesterEmail);
  if(!requester || requester.role !== 'admin') return res.status(403).json({ error:'Only admins can transfer ownership' });
  const newAdmin = workspace.members.find(m => m.email === newAdminEmail);
  if(!newAdmin) return res.status(404).json({ error:'New admin not found in workspace' });
  workspace.members = workspace.members.map(m => ({
    ...m,
    role: m.email === newAdminEmail ? 'admin' : m.email === requesterEmail ? 'member' : m.role
  }));
  saveData(data);
  res.json({ transferred:true, newAdmin:newAdmin.name });
});

// ══════════════════════════════════════════════════════════════
// KNOWLEDGE — Manual add
// ══════════════════════════════════════════════════════════════
app.post('/workspaces/:id/knowledge/:category', authMiddleware, (req,res) => {
  const { id, category } = req.params;
  const data = loadData(); const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error:'Not found' });
  if(!workspace.knowledge[category]) workspace.knowledge[category] = [];
  const item = { itemId:generateCode(8), ...req.body, addedAt:Date.now() };
  workspace.knowledge[category].push(item);
  saveData(data); res.json(item);
});

app.delete('/workspaces/:id/knowledge/:category/:itemId', authMiddleware, (req,res) => {
  const { id, category, itemId } = req.params;
  const data = loadData(); const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error:'Not found' });
  workspace.knowledge[category] = (workspace.knowledge[category]||[]).filter(i => i.itemId !== itemId);
  saveData(data); res.json({ deleted:true });
});

// ══════════════════════════════════════════════════════════════
// KNOWLEDGE — PDF Upload
// ══════════════════════════════════════════════════════════════
app.post('/workspaces/:id/knowledge/:category/upload', authMiddleware, upload.single('file'), async (req,res) => {
  const { id, category } = req.params;
  const data = loadData(); const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error:'Workspace not found' });
  if(!req.file)  return res.status(400).json({ error:'No file uploaded' });
  try {
    const base64 = req.file.buffer.toString('base64');
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:2000, messages:[{ role:'user', content:[
        { type:'document', source:{ type:'base64', media_type:'application/pdf', data:base64 } },
        { type:'text', text:getExtractionPrompt(category) }
      ]}]})
    });
    const claudeData = await claudeResp.json();
    const raw = claudeData.content?.map(b=>b.text||'').join('')||'';
    let extracted = {};
    try { const jm=raw.match(/\{[\s\S]*\}/); if(jm) extracted=JSON.parse(jm[0]); } catch(e) { extracted={summary:raw,raw:true}; }
    const item = { itemId:generateCode(8), filename:req.file.originalname, category, ...extracted, addedAt:Date.now(), source:'pdf_upload' };
    if(!workspace.knowledge[category]) workspace.knowledge[category]=[];
    workspace.knowledge[category].push(item);
    saveData(data); res.json({ item, needsInterview:extracted.gaps?.length>0 });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════════════════
// KNOWLEDGE — URL Ingestion
// ══════════════════════════════════════════════════════════════
app.post('/workspaces/:id/knowledge/:category/url', authMiddleware, async (req,res) => {
  const { id, category } = req.params; const { url } = req.body;
  if(!url) return res.status(400).json({ error:'URL required' });
  const data = loadData(); const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error:'Workspace not found' });
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch(e) { return res.status(400).json({ error:'Invalid URL — make sure it starts with https://' }); }
  try {
    const pageResp = await fetch(url, {
      headers:{ 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal:AbortSignal.timeout(15000),
    });
    if(!pageResp.ok) return res.status(400).json({ error:`Could not load page (HTTP ${pageResp.status}). Try a different URL or paste the content manually.` });
    const html = await pageResp.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'')
      .replace(/<nav[\s\S]*?<\/nav>/gi,'').replace(/<footer[\s\S]*?<\/footer>/gi,'').replace(/<header[\s\S]*?<\/header>/gi,'')
      .replace(/<!--[\s\S]*?-->/g,'').replace(/<[^>]+>/g,' ')
      .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
      .replace(/\s+/g,' ').trim().substring(0,15000);
    if(text.length<150) return res.status(400).json({ error:'Not enough readable content found. This page may require login or block automated access.' });
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:2000, messages:[{ role:'user', content:`${getExtractionPrompt(category)}\n\nSOURCE URL: ${url}\nDOMAIN: ${parsedUrl.hostname}\n\nPAGE CONTENT:\n${text}` }]})
    });
    const claudeData = await claudeResp.json();
    const raw = claudeData.content?.map(b=>b.text||'').join('')||'';
    let extracted = {};
    try { const jm=raw.match(/\{[\s\S]*\}/); if(jm) extracted=JSON.parse(jm[0]); } catch(e) { extracted={summary:raw.substring(0,500),raw:true}; }
    const item = { itemId:generateCode(8), filename:parsedUrl.hostname, url, category, ...extracted, addedAt:Date.now(), source:'url' };
    if(!workspace.knowledge[category]) workspace.knowledge[category]=[];
    workspace.knowledge[category].push(item);
    saveData(data); res.json({ item });
  } catch(e) {
    if(e.name==='TimeoutError'||e.name==='AbortError') return res.status(408).json({ error:'Page took too long to load. Try a different URL or add the content manually.' });
    res.status(500).json({ error:e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// COMMERCIAL INSIGHTS
// ══════════════════════════════════════════════════════════════
app.post('/workspaces/:id/insights/generate', authMiddleware, async (req,res) => {
  const { id } = req.params; const { product, specialty, additionalContext, scope } = req.body;
  const data = loadData(); const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error:'Not found' });
  const k = workspace.knowledge; let knowledgeContext='';
  if(k.product?.length)         knowledgeContext+=`PRODUCT INFO:\n${k.product.map(p=>`- ${p.title||p.productName||''}: ${p.summary||p.content||''} ${(p.keyBenefits||[]).join(', ')}`).join('\n')}\n\n`;
  if(k.clinicalStudies?.length) knowledgeContext+=`CLINICAL STUDIES:\n${k.clinicalStudies.map(s=>`- ${s.title||s.filename||'Study'}: ${s.keyFindings||s.summary||''} (n=${s.sampleSize||'?'})`).join('\n')}\n\n`;
  if(k.competitive?.length)     knowledgeContext+=`COMPETITIVE INTEL:\n${k.competitive.map(c=>`- ${c.competitorName||c.title||'Competitor'}: weaknesses: ${(c.knownWeaknesses||c.keyWeaknesses||[]).join('; ')}`).join('\n')}\n\n`;
  if(k.objections?.length)      knowledgeContext+=`APPROVED OBJECTIONS:\n${k.objections.map(o=>`- "${o.objection||''}": ${o.response||''}`).join('\n')}\n\n`;
  if(k.reimbursement?.length)   knowledgeContext+=`REIMBURSEMENT:\n${k.reimbursement.map(r=>`- ${r.title||''}: ${r.content||r.financialValue||''}`).join('\n')}\n\n`;
  try {
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:2500, messages:[{ role:'user', content:`You are an expert Challenger sales coach. Build a complete commercial insight for a medical device rep.

PRODUCT: ${product||'the product'}
TARGET SPECIALTY: ${specialty||'general'}
ADDITIONAL CONTEXT: ${additionalContext||''}

TEAM FIELD INTELLIGENCE:\n${knowledgeContext||'None yet — generate based on product and specialty.'}

Return ONLY valid JSON:
{"title":"Short memorable insight name","targetSpecialty":"${specialty||'general'}","product":"${product||''}","problemStatement":"The clinical or operational problem — specific and provocative","reframe":"Word-for-word provocative reframe, 1-2 sentences, backed by data","evidence":"Clinical data that makes the problem undeniable","emotionalImpact":"Patient outcomes, physician reputation, institutional financial impact","newWayForward":"Category of solution without naming the product","solution":"Connect product to insight — every feature tied back","bestPersonas":["skeptic","teacher"],"talkingPoints":["Point 1","Point 2","Point 3"],"proofPoints":["Proof 1","Proof 2"],"commonObjections":["Objection 1","Objection 2"],"scope":"${scope||'team'}"}` }]})
    });
    const claudeData = await claudeResp.json();
    const raw = claudeData.content?.map(b=>b.text||'').join('')||'';
    let insight = {};
    try { const jm=raw.match(/\{[\s\S]*\}/); if(jm) insight=JSON.parse(jm[0]); } catch(e) { return res.status(500).json({ error:'Could not parse insight — try again' }); }
    const item = { itemId:generateCode(8), ...insight, addedAt:Date.now(), source:'ai_generated' };
    if(!workspace.knowledge.insights) workspace.knowledge.insights=[];
    workspace.knowledge.insights.push(item);
    saveData(data); res.json({ item });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════════════════
// COMPETITIVE ANALYSIS
// ══════════════════════════════════════════════════════════════
app.post('/workspaces/:id/competitive-analysis', authMiddleware, async (req,res) => {
  const { id } = req.params; const { productName, competitorName } = req.body;
  const data = loadData(); const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error:'Not found' });
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:1500, messages:[{ role:'user', content:`Medical device competitive intelligence. Analyze ${competitorName} vs ${productName}. Return ONLY valid JSON:
{"competitorName":"${competitorName}","productName":"${productName}","knownWeaknesses":["w1","w2"],"adverseEventPatterns":["pattern"],"clinicalDataGaps":["gap"],"positioningOpportunities":["opp"],"keyDifferentiators":["diff"],"thingsToVerify":["verify"]}` }]})
    });
    const claudeData = await resp.json();
    const raw = claudeData.content?.map(b=>b.text||'').join('')||'';
    let analysis = {}; try { const jm=raw.match(/\{[\s\S]*\}/); if(jm) analysis=JSON.parse(jm[0]); } catch(e) { analysis={raw}; }
    const item = { itemId:generateCode(8), ...analysis, addedAt:Date.now(), source:'ai_analysis' };
    if(!workspace.knowledge.competitive) workspace.knowledge.competitive=[];
    workspace.knowledge.competitive.push(item);
    saveData(data); res.json(item);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════════════════
// KNOWLEDGE CONTEXT
// ══════════════════════════════════════════════════════════════
app.get('/workspaces/:id/context', authMiddleware, (req,res) => {
  const data = loadData(); const workspace = data.workspaces[req.params.id];
  if(!workspace) return res.status(404).json({ error:'Not found' });
  const k = workspace.knowledge; let context=`FIELD INTELLIGENCE FOR: ${workspace.name} (${workspace.company})\n\n`;
  if(k.product?.length)         { context+=`PRODUCT & MARKETING:\n`; k.product.forEach(p=>{context+=`- ${p.title||''}: ${p.content||p.summary||''}\n`;}); context+='\n'; }
  if(k.clinicalStudies?.length) { context+=`CLINICAL STUDIES:\n`; k.clinicalStudies.forEach(s=>{context+=`- ${s.title||s.filename||'Study'}: ${s.keyFindings||s.summary||''}\n`; if(s.sampleSize) context+=`  n=${s.sampleSize}\n`;}); context+='\n'; }
  if(k.competitive?.length)     { context+=`COMPETITIVE INTELLIGENCE:\n`; k.competitive.forEach(c=>{context+=`- ${c.competitorName||c.title||'Competitor'}:\n`; if(c.knownWeaknesses?.length) context+=`  Weaknesses: ${c.knownWeaknesses.join('; ')}\n`; if(c.positioningOpportunities?.length) context+=`  Opportunities: ${c.positioningOpportunities.join('; ')}\n`;}); context+='\n'; }
  if(k.objections?.length)      { context+=`APPROVED OBJECTION RESPONSES:\n`; k.objections.forEach(o=>{context+=`- "${o.objection||''}": ${o.response||''}\n`;}); context+='\n'; }
  if(k.reimbursement?.length)   { context+=`REIMBURSEMENT & BILLING:\n`; k.reimbursement.forEach(r=>{context+=`- ${r.title||r.code||''}: ${r.content||r.summary||''}\n`;}); context+='\n'; }
  if(k.insights?.length)        { context+=`COMMERCIAL INSIGHTS:\n`; k.insights.forEach(i=>{context+=`- "${i.title||''}": Reframe: ${i.reframe||''} | Evidence: ${i.evidence||''}\n`;}); context+='\n'; }
  res.json({ context, workspaceName:workspace.name, company:workspace.company });
});

// ══════════════════════════════════════════════════════════════
// MODULE 2 — ACTIVITY FEED
// ══════════════════════════════════════════════════════════════
// Activity items stored per account in data.activity[accountId][]
// Types: call_note | email_draft | meeting_summary | action_item
// Each item: { activityId, accountId, type, title, content, status, createdAt, updatedAt, dueDate, repName, repEmail, checkedFacts, actionItems[], sentAt }

function getAccountActivity(data, accountId) {
  if(!data.activity) data.activity = {};
  if(!data.activity[accountId]) data.activity[accountId] = [];
  return data.activity[accountId];
}

// GET all activity for an account
app.get('/accounts/:accountId/activity', authMiddleware, (req,res) => {
  const data = loadData();
  const items = getAccountActivity(data, req.params.accountId);
  res.json([...items].sort((a,b) => (b.createdAt||0) - (a.createdAt||0)));
});

// POST — create a new activity item (call note, meeting summary, action item, email draft shell)
app.post('/accounts/:accountId/activity', authMiddleware, (req,res) => {
  const data = loadData();
  const { type, title, content, dueDate, repName, repEmail } = req.body;
  if(!type) return res.status(400).json({ error:'type required' });
  const items = getAccountActivity(data, req.params.accountId);
  const item = {
    activityId: generateCode(10),
    accountId: req.params.accountId,
    type,
    title: title || '',
    content: content || '',
    status: type === 'action_item' ? 'pending' : type === 'email_draft' ? 'draft' : 'logged',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dueDate: dueDate || null,
    repName: repName || '',
    repEmail: repEmail || '',
    checkedFacts: false,
    actionItems: [],
    sentAt: null,
  };
  items.push(item);
  saveData(data);
  res.json(item);
});

// PUT — update an activity item (edit content, mark sent, mark complete, update status)
app.put('/accounts/:accountId/activity/:activityId', authMiddleware, (req,res) => {
  const data = loadData();
  const items = getAccountActivity(data, req.params.accountId);
  const idx = items.findIndex(i => i.activityId === req.params.activityId);
  if(idx === -1) return res.status(404).json({ error:'Not found' });
  items[idx] = { ...items[idx], ...req.body, activityId: items[idx].activityId, accountId: items[idx].accountId, updatedAt: Date.now() };
  saveData(data);
  res.json(items[idx]);
});

// DELETE — remove an activity item
app.delete('/accounts/:accountId/activity/:activityId', authMiddleware, (req,res) => {
  const data = loadData();
  const items = getAccountActivity(data, req.params.accountId);
  const idx = items.findIndex(i => i.activityId === req.params.activityId);
  if(idx === -1) return res.status(404).json({ error:'Not found' });
  items.splice(idx, 1);
  saveData(data);
  res.json({ deleted: true });
});

// ══════════════════════════════════════════════════════════════
// MODULE 2 — AI EMAIL DRAFT
// POST /accounts/:accountId/activity/draft-email
// Generates a draft follow-up email using Claude, then saves as activity item
// ══════════════════════════════════════════════════════════════
app.post('/accounts/:accountId/activity/draft-email', authMiddleware, async (req,res) => {
  const { accountName, clinician, clinicianTitle, repName, repCompany, repProducts,
          whatResonated, objections, nextStep, callSummary, emailType, additionalContext } = req.body;

  const typeGuide = {
    followup: 'A warm professional follow-up email after a sales call. Reference what was discussed and the next step.',
    clinical: 'A clinical data share email. Lead with the most relevant study, connect it to the physician\'s stated concern.',
    meeting: 'A meeting confirmation or recap email. Clear subject, bullet summary, single CTA.',
    intro: 'A first-contact introduction email. Hook with insight, not product. Challenger approach.'
  };
  const typeLabel = typeGuide[emailType] || typeGuide.followup;

  const prompt = `You are an expert medical device sales coach. Generate a professional email draft.

EMAIL TYPE: ${typeLabel}
REP: ${repName||'Rep'} from ${repCompany||'the company'}, selling ${repProducts||'medical devices'}
RECIPIENT: ${clinician||'Dr. Physician'}${clinicianTitle ? ', ' + clinicianTitle : ''}
ACCOUNT: ${accountName||'the account'}
WHAT RESONATED ON THE CALL: ${whatResonated||'not specified'}
OBJECTIONS RAISED: ${(objections||[]).join(', ')||'none'}
NEXT STEP: ${nextStep||'not specified'}
CALL SUMMARY: ${callSummary||'not specified'}
ADDITIONAL CONTEXT: ${additionalContext||''}

Write a compelling, human email. Do NOT use generic phrases like "I hope this email finds you well" or "touching base". Be specific to the conversation.

Return ONLY valid JSON:
{"subject":"...","body":"Full email body. Sign off as ${repName||'[Rep Name]'}.","dataClaimsToCheck":["any specific clinical data claims, statistics, or study references in the email that should be verified before sending"],"suggestedEdits":["1-2 optional tweaks rep might want to consider"]}`;

  try {
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:1800, messages:[{ role:'user', content:prompt }]})
    });
    const claudeData = await claudeResp.json();
    const raw = claudeData.content?.map(b=>b.text||'').join('')||'';
    let emailData = {};
    try { const jm=raw.match(/\{[\s\S]*\}/); if(jm) emailData=JSON.parse(jm[0]); } catch(e) { return res.status(500).json({ error:'Could not parse email draft' }); }

    // Save as activity item
    const data = loadData();
    const items = getAccountActivity(data, req.params.accountId);
    const item = {
      activityId: generateCode(10),
      accountId: req.params.accountId,
      type: 'email_draft',
      emailType: emailType || 'followup',
      title: emailData.subject || 'Email Draft',
      content: emailData.body || '',
      subject: emailData.subject || '',
      status: 'draft',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      repName: repName || '',
      repEmail: req.body.repEmail || '',
      checkedFacts: false,
      dataClaimsToCheck: emailData.dataClaimsToCheck || [],
      suggestedEdits: emailData.suggestedEdits || [],
      actionItems: [],
      sentAt: null,
    };
    items.push(item);
    saveData(data);
    res.json(item);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════════════════
// MODULE 2 — FACT CHECK
// POST /accounts/:accountId/activity/:activityId/fact-check
// Claude reviews the email content and flags data claims
// ══════════════════════════════════════════════════════════════
app.post('/accounts/:accountId/activity/:activityId/fact-check', authMiddleware, async (req,res) => {
  const data = loadData();
  const items = getAccountActivity(data, req.params.accountId);
  const item = items.find(i => i.activityId === req.params.activityId);
  if(!item) return res.status(404).json({ error:'Not found' });

  const { content } = req.body; // allow passing updated content
  const emailBody = content || item.content;

  const prompt = `You are a medical device compliance and accuracy coach. Review this email draft and flag any data claims that a rep should verify before sending.

EMAIL CONTENT:
${emailBody}

Look for:
- Specific statistics or percentages ("reduces X by 40%")
- Clinical study references ("a 2023 study showed...")
- Comparative claims ("outperforms competitor X")
- Outcome claims ("patients experience...")
- Regulatory or reimbursement claims ("covered under CPT...")

Return ONLY valid JSON:
{"flags":[{"claim":"exact quoted text from email","concern":"what needs to be verified","severity":"high|medium|low","suggestion":"how to rephrase more safely if needed"}],"overallRisk":"low|medium|high","summary":"1-2 sentence summary of what to watch for","passedIfNoFlags":true}

If there are no data claims to flag, return an empty flags array with overallRisk "low".`;

  try {
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:1200, messages:[{ role:'user', content:prompt }]})
    });
    const claudeData = await claudeResp.json();
    const raw = claudeData.content?.map(b=>b.text||'').join('')||'';
    let result = {};
    try { const jm=raw.match(/\{[\s\S]*\}/); if(jm) result=JSON.parse(jm[0]); } catch(e) { return res.status(500).json({ error:'Could not parse fact check' }); }

    // Update item with fact check result
    const idx = items.findIndex(i => i.activityId === req.params.activityId);
    if(idx !== -1) {
      items[idx].factCheckResult = result;
      items[idx].checkedFacts = true;
      items[idx].updatedAt = Date.now();
      saveData(data);
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════════════════
// MODULE 2 — ACTION ITEM EXTRACTION
// POST /accounts/:accountId/activity/:activityId/extract-actions
// Claude reads call note or email and extracts action items
// ══════════════════════════════════════════════════════════════
app.post('/accounts/:accountId/activity/:activityId/extract-actions', authMiddleware, async (req,res) => {
  const data = loadData();
  const items = getAccountActivity(data, req.params.accountId);
  const item = items.find(i => i.activityId === req.params.activityId);
  if(!item) return res.status(404).json({ error:'Not found' });

  const { content } = req.body;
  const sourceContent = content || item.content;

  const prompt = `You are a medical device sales coach. Extract concrete action items from this ${item.type === 'email_draft' ? 'email' : 'call note or summary'}.

ACTION ITEMS should be:
- Specific and ownable ("Send CPT code guide to Dr. Chen" not "send info")
- Assigned (rep vs. physician vs. clinic)
- Time-bound when possible

CONTENT:
${sourceContent}

Return ONLY valid JSON:
{"actionItems":[{"text":"specific action description","owner":"rep|physician|clinic|other","priority":"high|medium|low","suggestedDueDate":"relative like 'by end of week' or 'within 48 hours' or null","category":"send_material|schedule|follow_up|research|clinical|admin"}],"summary":"1 sentence on what this activity was"}

Extract 1-5 action items. If there are genuinely none, return empty array.`;

  try {
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:800, messages:[{ role:'user', content:prompt }]})
    });
    const claudeData = await claudeResp.json();
    const raw = claudeData.content?.map(b=>b.text||'').join('')||'';
    let result = {};
    try { const jm=raw.match(/\{[\s\S]*\}/); if(jm) result=JSON.parse(jm[0]); } catch(e) { return res.status(500).json({ error:'Could not extract actions' }); }

    // Save extracted action items back onto the source item
    const idx = items.findIndex(i => i.activityId === req.params.activityId);
    if(idx !== -1) {
      items[idx].extractedActionItems = result.actionItems || [];
      items[idx].updatedAt = Date.now();
    }

    // Also create standalone action_item entries for each extracted item
    const newItems = [];
    for(const action of (result.actionItems || [])) {
      const newItem = {
        activityId: generateCode(10),
        accountId: req.params.accountId,
        type: 'action_item',
        title: action.text,
        content: action.text,
        owner: action.owner || 'rep',
        priority: action.priority || 'medium',
        category: action.category || 'follow_up',
        suggestedDueDate: action.suggestedDueDate || null,
        status: 'pending',
        sourceActivityId: req.params.activityId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        repName: item.repName || '',
        repEmail: item.repEmail || '',
        checkedFacts: false,
        actionItems: [],
        sentAt: null,
      };
      items.push(newItem);
      newItems.push(newItem);
    }

    saveData(data);
    res.json({ actionItems: result.actionItems || [], createdItems: newItems, summary: result.summary || '' });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════════════════
// MODULE 2 — QUICK LOG (voice/text note → save as call_note)
// POST /accounts/:accountId/activity/quick-log
// Accepts raw note text, optionally enriches with Claude summary
// ══════════════════════════════════════════════════════════════
app.post('/accounts/:accountId/activity/quick-log', authMiddleware, async (req,res) => {
  const { rawNote, accountName, repName, repEmail, enrich } = req.body;
  if(!rawNote) return res.status(400).json({ error:'rawNote required' });

  let title = 'Call Note';
  let content = rawNote;
  let nextStep = '';

  if(enrich) {
    try {
      const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:600, messages:[{ role:'user', content:`A medical device rep just voice-logged this call note. Clean it up and extract a title and next step.

RAW NOTE:
${rawNote}

Return ONLY valid JSON:
{"title":"Short 5-10 word title for this activity","cleanedNote":"Polished version of the note, keeping all facts, fixing speech-to-text errors","nextStep":"single most important next action, or empty string if none"}` }]})
      });
      const cd = await claudeResp.json();
      const raw = cd.content?.map(b=>b.text||'').join('')||'';
      let parsed = {};
      try { const jm=raw.match(/\{[\s\S]*\}/); if(jm) parsed=JSON.parse(jm[0]); } catch(e) {}
      if(parsed.cleanedNote) content = parsed.cleanedNote;
      if(parsed.title) title = parsed.title;
      if(parsed.nextStep) nextStep = parsed.nextStep;
    } catch(e) { /* fall through with raw note */ }
  }

  const data = loadData();
  const items = getAccountActivity(data, req.params.accountId);
  const item = {
    activityId: generateCode(10),
    accountId: req.params.accountId,
    type: 'call_note',
    title,
    content,
    rawNote,
    nextStep,
    status: 'logged',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    repName: repName || '',
    repEmail: repEmail || '',
    checkedFacts: false,
    actionItems: [],
    sentAt: null,
  };
  items.push(item);
  saveData(data);
  res.json(item);
});

// ══════════════════════════════════════════════════════════════
// PROXIES
// ══════════════════════════════════════════════════════════════
app.post('/proxy/claude', authMiddleware, async (req,res) => {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' }, body:JSON.stringify(req.body) });
    res.json(await resp.json());
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/proxy/tts', async (req,res) => {
  const { text, voiceId } = req.body;
  if(!text||!voiceId) return res.status(400).json({ error:'text and voiceId required' });
  try {
    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, { method:'POST', headers:{ 'Content-Type':'application/json', 'xi-api-key':ELEVENLABS_KEY }, body:JSON.stringify({ text, model_id:'eleven_monolingual_v1', voice_settings:{ stability:0.5, similarity_boost:0.75 } }) });
    if(!resp.ok) { const err=await resp.text(); return res.status(resp.status).json({ error:err }); }
    const buf = await resp.arrayBuffer(); res.set('Content-Type','audio/mpeg'); res.send(Buffer.from(buf));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/proxy/elevenlabs/:voiceId', async (req,res) => {
  try {
    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${req.params.voiceId}`, { method:'POST', headers:{ 'xi-api-key':ELEVENLABS_KEY, 'Content-Type':'application/json' }, body:JSON.stringify(req.body) });
    if(!resp.ok) { res.status(resp.status).json({ error:'ElevenLabs error' }); return; }
    const buf = await resp.arrayBuffer(); res.set('Content-Type','audio/mpeg'); res.send(Buffer.from(buf));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════════════════
// EXTRACTION PROMPTS
// ══════════════════════════════════════════════════════════════
function getExtractionPrompt(category) {
  const prompts = {
    clinicalStudies:`Extract key info from this clinical study. Return ONLY valid JSON: {"title":"...","authors":"...","year":"...","journal":"...","studyType":"...","sampleSize":"n=X","patientPopulation":"...","primaryEndpoint":"...","keyFindings":"2-3 sentence summary","outcomes":"specific data with numbers","clinicalImplication":"...","limitations":"...","salesInsight":"how a rep should use this","gaps":["missing info"]}`,
    competitive:`Extract competitive intelligence. Return ONLY valid JSON: {"competitorName":"...","productCategory":"...","keyWeaknesses":["w1","w2"],"clinicalData":"...","knownIssues":"...","marketPositioning":"...","salesInsight":"...","gaps":["..."]}`,
    product:`Extract product and marketing info. Return ONLY valid JSON: {"productName":"...","indication":"...","keyBenefits":["b1","b2"],"clinicalClaims":["c1"],"differentiators":["d1"],"targetPatient":"...","summary":"2-3 sentence overview","gaps":["..."]}`,
    objections:`Extract objection handling info. Return ONLY valid JSON: {"objections":[{"objection":"...","response":"...","category":"price|clinical|competitive|access"}],"gaps":[]}`,
    reimbursement:`Extract reimbursement info. Return ONLY valid JSON: {"title":"...","codes":[{"code":"...","description":"...","reimbursementRate":"..."}],"payerCoverage":"...","priorAuth":"...","financialValue":"...","content":"...","gaps":[]}`,
    insights:`Extract commercial insight info. Return ONLY valid JSON: {"title":"...","problemStatement":"...","reframe":"...","evidence":"...","solution":"...","targetSpecialty":"...","bestPersonas":[],"talkingPoints":[],"gaps":[]}`
  };
  return prompts[category] || prompts.product;
}

app.listen(PORT, () => console.log(`MedDevice Sales Coach API v2.3 running on port ${PORT}`));
