// ══════════════════════════════════════════════════════════════
// MedDevice Sales Coach — Backend Server v2.1
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

// ── ENV VARS ──────────────────────────────────────────────────
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY  || '';
const ELEVENLABS_KEY = process.env.ELEVENLABS_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'MedCoach2026';

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ── DATA STORE ────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch(e) {}
  return { workspaces: {}, users: {} };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function generateCode(length = 8) {
  return crypto.randomBytes(length).toString('hex').toUpperCase().slice(0, length);
}

// ── DEBUG ─────────────────────────────────────────────────────
app.get('/debug', (req, res) => {
  res.json({
    hasAnthropicKey:   !!ANTHROPIC_KEY,
    anthropicKeyLength: ANTHROPIC_KEY.length,
    anthropicKeyStart:  ANTHROPIC_KEY.substring(0, 7),
    hasElevenLabsKey:  !!ELEVENLABS_KEY,
    adminPasswordSet:  !!ADMIN_PASSWORD,
  });
});

app.get('/', (req, res) => {
  res.json({ status: 'MedDevice Sales Coach API running', version: '2.1' });
});

// ══════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════
const SESSION_STORE = new Map();

app.post('/auth/login', (req, res) => {
  const { password } = req.body;
  if(password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  const token = generateCode(24);
  SESSION_STORE.set(token, { createdAt: Date.now() });
  res.json({ token });
});

app.post('/auth/verify', (req, res) => {
  const token = req.headers['x-session-token'];
  res.json({ valid: SESSION_STORE.has(token) || isStatelessToken(token) });
});

function makeStatelessToken() {
  return crypto.createHmac('sha256', ADMIN_PASSWORD).update('mdsc-session').digest('hex').substring(0, 32);
}
function isStatelessToken(token) {
  try { return token === makeStatelessToken(); } catch(e) { return false; }
}
function authMiddleware(req, res, next) {
  const token = req.headers['x-session-token'];
  if(!token) return res.status(401).json({ error: 'Not authenticated' });
  if(SESSION_STORE.has(token) || isStatelessToken(token)) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// ══════════════════════════════════════════════════════════════
// REP PROFILE
// ══════════════════════════════════════════════════════════════
app.get('/config/elkey', authMiddleware, (req, res) => {
  res.json({ key: ELEVENLABS_KEY });
});

app.post('/rep/profile', authMiddleware, (req, res) => {
  const { name, company, products, specialties, territory, email, notify } = req.body;
  const data = loadData();
  if(!data.reps) data.reps = {};
  const token = req.headers['x-session-token'];
  data.reps[token] = { name, company, products, specialties, territory, email, notify, updatedAt: Date.now() };
  saveData(data);
  res.json({ saved: true });
});

app.get('/rep/profile', authMiddleware, (req, res) => {
  const data = loadData();
  const token = req.headers['x-session-token'];
  res.json(data.reps?.[token] || {});
});

// ══════════════════════════════════════════════════════════════
// WORKSPACES
// ══════════════════════════════════════════════════════════════
app.post('/workspaces', authMiddleware, (req, res) => {
  const { name, company, repName, repEmail } = req.body;
  if(!name) return res.status(400).json({ error: 'Workspace name required' });
  const data = loadData();
  const id = generateCode(12);
  const inviteCode = generateCode(6);
  data.workspaces[id] = {
    id, name, company: company||'', createdBy: repEmail||'', createdAt: Date.now(), inviteCode,
    members: [{ name: repName||'', email: repEmail||'', role:'admin', joinedAt: Date.now() }],
    knowledge: {
      product:[], clinicalStudies:[], competitive:[], objections:[], reimbursement:[], insights:[]
    }
  };
  saveData(data);
  res.json({ workspaceId: id, inviteCode });
});

app.post('/workspaces/join', authMiddleware, (req, res) => {
  const { inviteCode, repName, repEmail } = req.body;
  const data = loadData();
  const workspace = Object.values(data.workspaces).find(w => w.inviteCode === inviteCode?.toUpperCase());
  if(!workspace) return res.status(404).json({ error: 'Invalid invite code' });
  if(!workspace.members.find(m => m.email === repEmail)) {
    workspace.members.push({ name: repName||'', email: repEmail||'', role:'member', joinedAt: Date.now() });
    saveData(data);
  }
  res.json({ workspaceId: workspace.id, workspaceName: workspace.name });
});

app.get('/workspaces/:id', authMiddleware, (req, res) => {
  const data = loadData();
  const workspace = data.workspaces[req.params.id];
  if(!workspace) return res.status(404).json({ error: 'Not found' });
  if(!workspace.knowledge.insights) workspace.knowledge.insights = [];
  res.json(workspace);
});

app.get('/workspaces', authMiddleware, (req, res) => {
  const data = loadData();
  res.json(Object.values(data.workspaces).map(w => ({ id:w.id, name:w.name, company:w.company, members:w.members.length, createdAt:w.createdAt })));
});

// ══════════════════════════════════════════════════════════════
// KNOWLEDGE — Manual add
// ══════════════════════════════════════════════════════════════
app.post('/workspaces/:id/knowledge/:category', authMiddleware, (req, res) => {
  const { id, category } = req.params;
  const data = loadData();
  const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error: 'Not found' });
  if(!workspace.knowledge[category]) workspace.knowledge[category] = [];
  const item = { itemId: generateCode(8), ...req.body, addedAt: Date.now() };
  workspace.knowledge[category].push(item);
  saveData(data);
  res.json(item);
});

// Delete
app.delete('/workspaces/:id/knowledge/:category/:itemId', authMiddleware, (req, res) => {
  const { id, category, itemId } = req.params;
  const data = loadData();
  const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error: 'Not found' });
  workspace.knowledge[category] = (workspace.knowledge[category]||[]).filter(i => i.itemId !== itemId);
  saveData(data);
  res.json({ deleted: true });
});

// ══════════════════════════════════════════════════════════════
// KNOWLEDGE — PDF Upload
// ══════════════════════════════════════════════════════════════
app.post('/workspaces/:id/knowledge/:category/upload', authMiddleware, upload.single('file'), async (req, res) => {
  const { id, category } = req.params;
  const data = loadData();
  const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error: 'Workspace not found' });
  if(!req.file)  return res.status(400).json({ error: 'No file uploaded' });

  try {
    const base64  = req.file.buffer.toString('base64');
    const filename = req.file.originalname;
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 2000,
        messages: [{ role:'user', content: [
          { type:'document', source:{ type:'base64', media_type:'application/pdf', data:base64 } },
          { type:'text', text: getExtractionPrompt(category) }
        ]}]
      })
    });
    const claudeData = await claudeResp.json();
    const raw = claudeData.content?.map(b=>b.text||'').join('')||'';
    let extracted = {};
    try { const jm = raw.match(/\{[\s\S]*\}/); if(jm) extracted = JSON.parse(jm[0]); } catch(e) { extracted = { summary:raw, raw:true }; }
    const item = { itemId:generateCode(8), filename, category, ...extracted, addedAt:Date.now(), source:'pdf_upload' };
    if(!workspace.knowledge[category]) workspace.knowledge[category]=[];
    workspace.knowledge[category].push(item);
    saveData(data);
    res.json({ item, needsInterview: extracted.gaps?.length > 0 });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════════════════
// KNOWLEDGE — URL Ingestion (NEW)
// ══════════════════════════════════════════════════════════════
app.post('/workspaces/:id/knowledge/:category/url', authMiddleware, async (req, res) => {
  const { id, category } = req.params;
  const { url } = req.body;
  if(!url) return res.status(400).json({ error: 'URL required' });

  const data = loadData();
  const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error: 'Workspace not found' });

  let parsedUrl;
  try { parsedUrl = new URL(url); } catch(e) { return res.status(400).json({ error:'Invalid URL — make sure it starts with https://' }); }

  try {
    const pageResp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: AbortSignal.timeout(15000),
    });

    if(!pageResp.ok) return res.status(400).json({ error:`Could not load page (HTTP ${pageResp.status}). Try a different URL or paste the content manually.` });

    const html = await pageResp.text();

    // Strip HTML to clean readable text
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 15000);

    if(text.length < 150) return res.status(400).json({ error:'Not enough readable content found. This page may require login or block automated access. Try pasting the content manually instead.' });

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 2000,
        messages: [{ role:'user', content:`${getExtractionPrompt(category)}\n\nSOURCE URL: ${url}\nDOMAIN: ${parsedUrl.hostname}\n\nPAGE CONTENT:\n${text}` }]
      })
    });

    const claudeData = await claudeResp.json();
    const raw = claudeData.content?.map(b=>b.text||'').join('')||'';
    let extracted = {};
    try { const jm = raw.match(/\{[\s\S]*\}/); if(jm) extracted = JSON.parse(jm[0]); } catch(e) { extracted = { summary:raw.substring(0,500), raw:true }; }

    const item = { itemId:generateCode(8), filename:parsedUrl.hostname, url, category, ...extracted, addedAt:Date.now(), source:'url' };
    if(!workspace.knowledge[category]) workspace.knowledge[category]=[];
    workspace.knowledge[category].push(item);
    saveData(data);
    res.json({ item });

  } catch(e) {
    if(e.name==='TimeoutError'||e.name==='AbortError') return res.status(408).json({ error:'Page took too long to load. Try a different URL or add the content manually.' });
    res.status(500).json({ error:e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// COMMERCIAL INSIGHTS — AI Generator (NEW)
// ══════════════════════════════════════════════════════════════
app.post('/workspaces/:id/insights/generate', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { product, specialty, additionalContext, scope } = req.body;
  const data = loadData();
  const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error:'Not found' });

  const k = workspace.knowledge;
  let knowledgeContext = '';
  if(k.product?.length)          knowledgeContext += `PRODUCT INFO:\n${k.product.map(p=>`- ${p.title||p.productName||''}: ${p.summary||p.content||''} ${(p.keyBenefits||[]).join(', ')}`).join('\n')}\n\n`;
  if(k.clinicalStudies?.length)  knowledgeContext += `CLINICAL STUDIES:\n${k.clinicalStudies.map(s=>`- ${s.title||s.filename||'Study'}: ${s.keyFindings||s.summary||''} (n=${s.sampleSize||'?'})`).join('\n')}\n\n`;
  if(k.competitive?.length)      knowledgeContext += `COMPETITIVE INTEL:\n${k.competitive.map(c=>`- ${c.competitorName||c.title||'Competitor'}: weaknesses: ${(c.knownWeaknesses||c.keyWeaknesses||[]).join('; ')}`).join('\n')}\n\n`;
  if(k.objections?.length)       knowledgeContext += `APPROVED OBJECTIONS:\n${k.objections.map(o=>`- "${o.objection||''}": ${o.response||''}`).join('\n')}\n\n`;
  if(k.reimbursement?.length)    knowledgeContext += `REIMBURSEMENT:\n${k.reimbursement.map(r=>`- ${r.title||''}: ${r.content||r.financialValue||''}`).join('\n')}\n\n`;

  try {
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model:'claude-sonnet-4-20250514', max_tokens:2500,
        messages:[{ role:'user', content:`You are an expert Challenger sales coach helping a medical device rep build a commercial insight. Using the team's field intelligence below, create a compelling Challenger-style commercial insight story.

PRODUCT: ${product||'the product'}
TARGET SPECIALTY: ${specialty||'general'}
ADDITIONAL CONTEXT FROM REP: ${additionalContext||'none provided'}

TEAM FIELD INTELLIGENCE:
${knowledgeContext||'No knowledge base content yet — generate based on the product and specialty provided, drawing on your knowledge of the medical device space.'}

Generate a complete commercial insight. Return ONLY valid JSON with no markdown:
{
  "title": "Short memorable name for this insight — something a rep would remember and use (e.g. 'The Hidden Revision Risk' or 'The Programming Time Problem')",
  "targetSpecialty": "${specialty||'general'}",
  "product": "${product||''}",
  "problemStatement": "The clinical or operational problem this insight is built around. Something the clinician may not be framing correctly or fully aware of. Be specific, provocative, and grounded in the specialty.",
  "reframe": "Word-for-word provocative reframe — 1-2 sentences. This is the sting. A surprising truth that shifts how they see their world. Must be backed by data from the knowledge base where possible.",
  "evidence": "The clinical data and evidence that makes the problem undeniable. Reference specific studies, statistics, or outcomes from the knowledge base. Include n= and outcomes data where available.",
  "emotionalImpact": "Three layers: (1) how this affects patients, (2) how it affects the physician's reputation or outcomes, (3) how it affects the institution financially.",
  "newWayForward": "Introduce the category of solution without naming the product. What would the ideal world look like for this clinician?",
  "solution": "Connect the product to the insight. Show how it solves the specific problem — every feature tied back to the insight, not just listed as benefits.",
  "bestPersonas": ["list of persona types this insight works best with — skeptic/teacher/go-getter/guide/friend/climber"],
  "talkingPoints": ["Specific talking point 1 tailored to this specialty", "Specific talking point 2", "Specific talking point 3"],
  "proofPoints": ["Specific proof point or study reference 1", "Specific proof point 2"],
  "commonObjections": ["Most likely objection in this specialty to this insight", "Second common pushback and how to handle it"],
  "scope": "${scope||'team'}"
}` }]
      })
    });

    const claudeData = await claudeResp.json();
    const raw = claudeData.content?.map(b=>b.text||'').join('')||'';
    let insight = {};
    try { const jm = raw.match(/\{[\s\S]*\}/); if(jm) insight = JSON.parse(jm[0]); } catch(e) { return res.status(500).json({ error:'Could not parse insight — please try again' }); }

    const item = { itemId:generateCode(8), ...insight, addedAt:Date.now(), source:'ai_generated' };
    if(!workspace.knowledge.insights) workspace.knowledge.insights=[];
    workspace.knowledge.insights.push(item);
    saveData(data);
    res.json({ item });

  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════════════════
// COMPETITIVE ANALYSIS
// ══════════════════════════════════════════════════════════════
app.post('/workspaces/:id/competitive-analysis', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { productName, competitorName } = req.body;
  const data = loadData();
  const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error:'Not found' });
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model:'claude-sonnet-4-20250514', max_tokens:1500,
        messages:[{ role:'user', content:`You are a medical device competitive intelligence expert. Analyze ${competitorName} as a competitor to ${productName}. Return ONLY valid JSON:
{
  "competitorName":"${competitorName}","productName":"${productName}",
  "knownWeaknesses":["weakness 1 with clinical context","weakness 2"],
  "adverseEventPatterns":["any known patterns from FDA MAUDE or published literature"],
  "clinicalDataGaps":["areas where their clinical evidence is weak"],
  "positioningOpportunities":["how to position ${productName} against this competitor"],
  "keyDifferentiators":["where ${productName} likely has advantage"],
  "thingsToVerify":["gaps in this analysis the rep should verify with their own data"]
}` }]
      })
    });
    const claudeData = await resp.json();
    const raw = claudeData.content?.map(b=>b.text||'').join('')||'';
    let analysis = {};
    try { const jm = raw.match(/\{[\s\S]*\}/); if(jm) analysis = JSON.parse(jm[0]); } catch(e) { analysis={raw}; }
    const item = { itemId:generateCode(8), ...analysis, addedAt:Date.now(), source:'ai_analysis' };
    if(!workspace.knowledge.competitive) workspace.knowledge.competitive=[];
    workspace.knowledge.competitive.push(item);
    saveData(data);
    res.json(item);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════════════════
// KNOWLEDGE CONTEXT (injected into AI prompts)
// ══════════════════════════════════════════════════════════════
app.get('/workspaces/:id/context', authMiddleware, (req, res) => {
  const data = loadData();
  const workspace = data.workspaces[req.params.id];
  if(!workspace) return res.status(404).json({ error:'Not found' });
  const k = workspace.knowledge;
  let context = `FIELD INTELLIGENCE FOR: ${workspace.name} (${workspace.company})\n\n`;
  if(k.product?.length)         { context+=`PRODUCT & MARKETING:\n`; k.product.forEach(p=>{context+=`- ${p.title||''}: ${p.content||p.summary||''}\n`;}); context+='\n'; }
  if(k.clinicalStudies?.length) { context+=`CLINICAL STUDIES:\n`; k.clinicalStudies.forEach(s=>{context+=`- ${s.title||s.filename||'Study'}: ${s.keyFindings||s.summary||''}\n`;if(s.sampleSize)context+=`  n=${s.sampleSize}\n`;}); context+='\n'; }
  if(k.competitive?.length)     { context+=`COMPETITIVE INTELLIGENCE:\n`; k.competitive.forEach(c=>{context+=`- ${c.competitorName||c.title||'Competitor'}:\n`;if(c.knownWeaknesses?.length)context+=`  Weaknesses: ${c.knownWeaknesses.join('; ')}\n`;if(c.positioningOpportunities?.length)context+=`  Opportunities: ${c.positioningOpportunities.join('; ')}\n`;}); context+='\n'; }
  if(k.objections?.length)      { context+=`APPROVED OBJECTION RESPONSES:\n`; k.objections.forEach(o=>{context+=`- "${o.objection||''}": ${o.response||''}\n`;}); context+='\n'; }
  if(k.reimbursement?.length)   { context+=`REIMBURSEMENT & BILLING:\n`; k.reimbursement.forEach(r=>{context+=`- ${r.title||r.code||''}: ${r.content||r.summary||''}\n`;}); context+='\n'; }
  if(k.insights?.length)        { context+=`COMMERCIAL INSIGHTS (Challenger Stories):\n`; k.insights.forEach(i=>{context+=`- "${i.title||''}": Reframe: ${i.reframe||''} | Evidence: ${i.evidence||''} | Best for: ${(i.bestPersonas||[]).join(', ')}\n`;}); context+='\n'; }
  res.json({ context, workspaceName:workspace.name, company:workspace.company });
});

// ══════════════════════════════════════════════════════════════
// PROXY — Claude & ElevenLabs
// ══════════════════════════════════════════════════════════════
app.post('/proxy/claude', authMiddleware, async (req, res) => {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify(req.body)
    });
    res.json(await resp.json());
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// TTS — no authMiddleware (key stays server-side, safe without auth)
app.post('/proxy/tts', async (req, res) => {
  const { text, voiceId } = req.body;
  if(!text||!voiceId) return res.status(400).json({ error:'text and voiceId required' });
  try {
    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'xi-api-key':ELEVENLABS_KEY },
      body: JSON.stringify({ text, model_id:'eleven_monolingual_v1', voice_settings:{ stability:0.5, similarity_boost:0.75 } }),
    });
    if(!resp.ok) { const err=await resp.text(); return res.status(resp.status).json({ error:err }); }
    const buf = await resp.arrayBuffer();
    res.set('Content-Type','audio/mpeg');
    res.send(Buffer.from(buf));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/proxy/elevenlabs/:voiceId', async (req, res) => {
  try {
    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${req.params.voiceId}`, {
      method:'POST', headers:{ 'xi-api-key':ELEVENLABS_KEY, 'Content-Type':'application/json' }, body:JSON.stringify(req.body)
    });
    if(!resp.ok) { res.status(resp.status).json({ error:'ElevenLabs error' }); return; }
    const buf = await resp.arrayBuffer();
    res.set('Content-Type','audio/mpeg');
    res.send(Buffer.from(buf));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════════════════
// EXTRACTION PROMPTS
// ══════════════════════════════════════════════════════════════
function getExtractionPrompt(category) {
  const prompts = {
    clinicalStudies:`Extract key information from this clinical study. Return ONLY valid JSON:
{"title":"study title","authors":"authors","year":"year","journal":"journal name","studyType":"RCT/observational/meta-analysis/etc","sampleSize":"n=XXX","patientPopulation":"who was studied","primaryEndpoint":"what was measured","keyFindings":"most important results in 2-3 sentences","outcomes":"specific outcome data with numbers","clinicalImplication":"what this means for clinical practice","limitations":"study limitations","salesInsight":"how a rep could use this in a sales conversation","gaps":["any information that would be useful but is missing"]}`,
    competitive:`Extract competitive intelligence. Return ONLY valid JSON:
{"competitorName":"product/company name","productCategory":"type of device","keyWeaknesses":["weakness 1","weakness 2"],"clinicalData":"what clinical claims they make","knownIssues":"known problems or limitations","marketPositioning":"how they position themselves","salesInsight":"how to position against this competitor","gaps":["information not found that would be useful"]}`,
    product:`Extract key product and marketing information. Return ONLY valid JSON:
{"productName":"name","indication":"what it's indicated for","keyBenefits":["benefit 1","benefit 2"],"clinicalClaims":["approved claim 1","approved claim 2"],"differentiators":["what makes this unique"],"targetPatient":"ideal patient profile","summary":"2-3 sentence product overview","gaps":["missing information that would strengthen the sales story"]}`,
    objections:`Extract objection handling information. Return ONLY valid JSON:
{"objections":[{"objection":"the objection","response":"the approved response","category":"price/clinical/competitive/access"}],"gaps":[]}`,
    reimbursement:`Extract reimbursement and billing information. Return ONLY valid JSON:
{"title":"topic or code name","codes":[{"code":"CPT/ICD code","description":"what it covers","reimbursementRate":"approximate rate"}],"payerCoverage":"which payers cover this","priorAuth":"prior authorization requirements","financialValue":"financial value story for the hospital/practice","content":"summary of key reimbursement information","gaps":[]}`,
    insights:`Extract commercial insight information. Return ONLY valid JSON:
{"title":"insight name","problemStatement":"the clinical problem","reframe":"the provocative reframe statement","evidence":"supporting evidence","solution":"how a solution addresses this","targetSpecialty":"relevant specialty","bestPersonas":[],"talkingPoints":[],"gaps":[]}`
  };
  return prompts[category] || prompts.product;
}

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`MedDevice Sales Coach API v2.1 running on port ${PORT}`);
});
