// ══════════════════════════════════════════════════════════════
// MedDevice Sales Coach — Backend Server
// Deploy to Railway: railway.app
// ══════════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── ENV VARS (set in Railway dashboard) ──────────────────────
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY  || '';
const ELEVENLABS_KEY = process.env.ELEVENLABS_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'sales2026';

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ── DATA STORE (JSON file — simple, no SQL needed) ────────────
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

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'MedDevice Sales Coach API running', version: '1.0' });
});

// ══════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════
app.post('/auth/login', (req, res) => {
  const { password } = req.body;
  if(password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  // Simple session token
  const token = generateCode(16);
  const data = loadData();
  if(!data.sessions) data.sessions = {};
  data.sessions[token] = { createdAt: Date.now() };
  saveData(data);
  res.json({ token });
});

function authMiddleware(req, res, next) {
  const token = req.headers['x-session-token'];
  const data = loadData();
  if(!token || !data.sessions?.[token]) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// ══════════════════════════════════════════════════════════════
// WORKSPACES
// ══════════════════════════════════════════════════════════════

// Create a new workspace
app.post('/workspaces', authMiddleware, (req, res) => {
  const { name, company, repName, repEmail } = req.body;
  if(!name) return res.status(400).json({ error: 'Workspace name required' });

  const data = loadData();
  const id = generateCode(12);
  const inviteCode = generateCode(6);

  data.workspaces[id] = {
    id,
    name,
    company:    company || '',
    createdBy:  repEmail || '',
    createdAt:  Date.now(),
    inviteCode,
    members:    [{ name: repName || '', email: repEmail || '', role: 'admin', joinedAt: Date.now() }],
    knowledge:  {
      product:        [],   // marketing claims, overview
      clinicalStudies: [],  // extracted study data
      competitive:    [],   // competitor info
      adverseEvents:  [],   // adverse event data
      objections:     [],   // objection bank
      reimbursement:  [],   // billing/reimbursement info
    }
  };

  saveData(data);
  res.json({ workspaceId: id, inviteCode });
});

// Join workspace via invite code
app.post('/workspaces/join', authMiddleware, (req, res) => {
  const { inviteCode, repName, repEmail } = req.body;
  const data = loadData();

  const workspace = Object.values(data.workspaces).find(
    w => w.inviteCode === inviteCode?.toUpperCase()
  );

  if(!workspace) return res.status(404).json({ error: 'Invalid invite code' });

  // Add member if not already in
  const exists = workspace.members.find(m => m.email === repEmail);
  if(!exists) {
    workspace.members.push({
      name: repName || '', email: repEmail || '',
      role: 'member', joinedAt: Date.now()
    });
    saveData(data);
  }

  res.json({ workspaceId: workspace.id, workspaceName: workspace.name });
});

// Get workspace (knowledge base)
app.get('/workspaces/:id', authMiddleware, (req, res) => {
  const data = loadData();
  const workspace = data.workspaces[req.params.id];
  if(!workspace) return res.status(404).json({ error: 'Not found' });
  res.json(workspace);
});

// List workspaces (for admin)
app.get('/workspaces', authMiddleware, (req, res) => {
  const data = loadData();
  const list = Object.values(data.workspaces).map(w => ({
    id: w.id, name: w.name, company: w.company,
    members: w.members.length, createdAt: w.createdAt
  }));
  res.json(list);
});

// ══════════════════════════════════════════════════════════════
// KNOWLEDGE BASE
// ══════════════════════════════════════════════════════════════

// Add a knowledge item manually
app.post('/workspaces/:id/knowledge/:category', authMiddleware, (req, res) => {
  const { id, category } = req.params;
  const data = loadData();
  const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error: 'Not found' });
  if(!workspace.knowledge[category]) return res.status(400).json({ error: 'Invalid category' });

  const item = {
    itemId:    generateCode(8),
    ...req.body,
    addedAt:   Date.now(),
  };

  workspace.knowledge[category].push(item);
  saveData(data);
  res.json(item);
});

// Delete a knowledge item
app.delete('/workspaces/:id/knowledge/:category/:itemId', authMiddleware, (req, res) => {
  const { id, category, itemId } = req.params;
  const data = loadData();
  const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error: 'Not found' });

  workspace.knowledge[category] = (workspace.knowledge[category] || [])
    .filter(item => item.itemId !== itemId);
  saveData(data);
  res.json({ deleted: true });
});

// Upload and extract PDF knowledge
app.post('/workspaces/:id/knowledge/:category/upload', authMiddleware, upload.single('file'), async (req, res) => {
  const { id, category } = req.params;
  const data = loadData();
  const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error: 'Workspace not found' });
  if(!req.file)  return res.status(400).json({ error: 'No file uploaded' });

  try {
    // Convert PDF to base64 for Claude
    const base64 = req.file.buffer.toString('base64');
    const filename = req.file.originalname;

    // Ask Claude to extract key information from the PDF
    const extractPrompt = getExtractionPrompt(category);

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 }
            },
            { type: 'text', text: extractPrompt }
          ]
        }]
      })
    });

    const claudeData = await claudeResp.json();
    const raw = claudeData.content?.map(b => b.text || '').join('') || '';

    // Parse JSON from Claude response
    let extracted = {};
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if(jsonMatch) extracted = JSON.parse(jsonMatch[0]);
    } catch(e) {
      extracted = { summary: raw, raw: true };
    }

    const item = {
      itemId:    generateCode(8),
      filename,
      category,
      ...extracted,
      addedAt:   Date.now(),
      source:    'pdf_upload'
    };

    workspace.knowledge[category].push(item);
    saveData(data);
    res.json({ item, needsInterview: extracted.gaps?.length > 0 });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// AI gap analysis for competitive intelligence
app.post('/workspaces/:id/competitive-analysis', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { productName, competitorName } = req.body;
  const data = loadData();
  const workspace = data.workspaces[id];
  if(!workspace) return res.status(404).json({ error: 'Not found' });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `You are a medical device competitive intelligence expert. Analyze ${competitorName} as a competitor to ${productName}.

Return ONLY valid JSON:
{
  "competitorName": "${competitorName}",
  "productName": "${productName}",
  "knownWeaknesses": ["weakness 1 with clinical/data context", "weakness 2"],
  "adverseEventPatterns": ["any known patterns from FDA MAUDE database or published literature"],
  "clinicalDataGaps": ["areas where their clinical evidence is weak or limited"],
  "positioningOpportunities": ["how to position ${productName} against this competitor"],
  "keyDifferentiators": ["where ${productName} likely has advantage"],
  "thingsToVerify": ["gaps in this analysis that the rep should verify with their own data"]
}`
        }]
      })
    });

    const claudeData = await resp.json();
    const raw = claudeData.content?.map(b => b.text || '').join('') || '';
    let analysis = {};
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if(jsonMatch) analysis = JSON.parse(jsonMatch[0]);
    } catch(e) { analysis = { raw }; }

    // Save to workspace competitive knowledge
    const item = {
      itemId:    generateCode(8),
      ...analysis,
      addedAt:   Date.now(),
      source:    'ai_analysis'
    };
    workspace.knowledge.competitive.push(item);
    saveData(data);
    res.json(item);

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get full knowledge context string (used by frontend to inject into AI prompts)
app.get('/workspaces/:id/context', authMiddleware, (req, res) => {
  const data = loadData();
  const workspace = data.workspaces[req.params.id];
  if(!workspace) return res.status(404).json({ error: 'Not found' });

  const k = workspace.knowledge;
  let context = `PRODUCT KNOWLEDGE BASE FOR: ${workspace.name} (${workspace.company})\n\n`;

  if(k.product?.length) {
    context += `PRODUCT & MARKETING:\n`;
    k.product.forEach(p => { context += `- ${p.title||''}: ${p.content||p.summary||''}\n`; });
    context += '\n';
  }

  if(k.clinicalStudies?.length) {
    context += `CLINICAL STUDIES:\n`;
    k.clinicalStudies.forEach(s => {
      context += `- ${s.title||s.filename||'Study'}: ${s.keyFindings||s.summary||''}\n`;
      if(s.endpoints)     context += `  Endpoints: ${s.endpoints}\n`;
      if(s.sampleSize)    context += `  N=${s.sampleSize}\n`;
      if(s.outcomes)      context += `  Outcomes: ${s.outcomes}\n`;
    });
    context += '\n';
  }

  if(k.competitive?.length) {
    context += `COMPETITIVE INTELLIGENCE:\n`;
    k.competitive.forEach(c => {
      context += `- ${c.competitorName||c.title||'Competitor'}:\n`;
      if(c.knownWeaknesses?.length)         context += `  Weaknesses: ${c.knownWeaknesses.join('; ')}\n`;
      if(c.positioningOpportunities?.length) context += `  Opportunities: ${c.positioningOpportunities.join('; ')}\n`;
      if(c.clinicalDataGaps?.length)         context += `  Clinical gaps: ${c.clinicalDataGaps.join('; ')}\n`;
    });
    context += '\n';
  }

  if(k.adverseEvents?.length) {
    context += `ADVERSE EVENT DATA:\n`;
    k.adverseEvents.forEach(a => { context += `- ${a.product||''}: ${a.content||a.summary||''}\n`; });
    context += '\n';
  }

  if(k.objections?.length) {
    context += `APPROVED OBJECTION RESPONSES:\n`;
    k.objections.forEach(o => { context += `- Objection: ${o.objection||''}\n  Response: ${o.response||''}\n`; });
    context += '\n';
  }

  if(k.reimbursement?.length) {
    context += `REIMBURSEMENT & BILLING:\n`;
    k.reimbursement.forEach(r => { context += `- ${r.code||''}: ${r.content||r.summary||''}\n`; });
    context += '\n';
  }

  res.json({ context, workspaceName: workspace.name, company: workspace.company });
});

// ══════════════════════════════════════════════════════════════
// PROXY — Claude & ElevenLabs (keys stay on server)
// ══════════════════════════════════════════════════════════════

app.post('/proxy/claude', authMiddleware, async (req, res) => {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await resp.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/proxy/elevenlabs/:voiceId', authMiddleware, async (req, res) => {
  try {
    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${req.params.voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });
    if(!resp.ok) { res.status(resp.status).json({ error: 'ElevenLabs error' }); return; }
    const buf = await resp.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(buf));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

function getExtractionPrompt(category) {
  const prompts = {
    clinicalStudies: `Extract key information from this clinical study. Return ONLY valid JSON:
{
  "title": "study title",
  "authors": "authors",
  "year": "year",
  "journal": "journal name",
  "studyType": "RCT/observational/meta-analysis/etc",
  "sampleSize": "n=XXX",
  "patientPopulation": "who was studied",
  "primaryEndpoint": "what was measured",
  "keyFindings": "most important results in 2-3 sentences",
  "outcomes": "specific outcome data with numbers",
  "clinicalImplication": "what this means for clinical practice",
  "limitations": "study limitations",
  "salesInsight": "how a rep could use this in a sales conversation",
  "gaps": ["any information that would be useful but isn't in this document"]
}`,
    competitive: `Extract competitive intelligence from this document. Return ONLY valid JSON:
{
  "competitorName": "product/company name",
  "productCategory": "what type of device",
  "keyWeaknesses": ["weakness 1", "weakness 2"],
  "clinicalData": "what clinical claims they make",
  "knownIssues": "any known problems or limitations",
  "marketPositioning": "how they position themselves",
  "salesInsight": "how to position against this competitor",
  "gaps": ["information not found that would be useful"]
}`,
    adverseEvents: `Extract adverse event information. Return ONLY valid JSON:
{
  "product": "product name",
  "manufacturer": "company",
  "eventType": "type of adverse event",
  "frequency": "how common",
  "severity": "severity level",
  "clinicalContext": "clinical context",
  "salesInsight": "how to use this information appropriately in a sales conversation",
  "gaps": []
}`,
    product: `Extract key product and marketing information. Return ONLY valid JSON:
{
  "productName": "name",
  "indication": "what it's indicated for",
  "keyBenefits": ["benefit 1", "benefit 2"],
  "clinicalClaims": ["approved claim 1", "approved claim 2"],
  "differentiators": ["what makes this unique"],
  "targetPatient": "ideal patient profile",
  "summary": "2-3 sentence product overview",
  "gaps": ["missing information that would strengthen the sales story"]
}`,
    objections: `Extract objection handling information. Return ONLY valid JSON:
{
  "objections": [
    {"objection": "the objection", "response": "the approved response", "category": "price/clinical/competitive/access"}
  ],
  "gaps": []
}`,
    reimbursement: `Extract reimbursement and billing information. Return ONLY valid JSON:
{
  "codes": [{"code": "CPT/ICD code", "description": "what it covers", "reimbursementRate": "approximate rate"}],
  "payerCoverage": "which payers cover this",
  "priorAuth": "prior authorization requirements",
  "financialValue": "financial value story for the hospital/practice",
  "gaps": []
}`
  };
  return prompts[category] || prompts.product;
}

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`MedDevice Sales Coach API running on port ${PORT}`);
});
