const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
// Blueprint API v2 — audit diffs, WS full-state sync, keepalive pings
const { WebSocketServer } = require('ws');
const { OAuth2Client } = require('google-auth-library');
// Inline minimal computation helpers (avoids require path issues on Railway where only api/ is deployed)
const CP = (() => {
  const DEFAULT_SIZE_MAP = { XS: 0.5, S: 1, M: 2, L: 3, XL: 5, XXL: 8, XXXL: 13 };
  function sizeToSprints(size, sizeMap) {
    if (!size || size === '' || size === 'NaN') return 0;
    return (sizeMap || DEFAULT_SIZE_MAP)[size] || 0;
  }
  function computeProjectSprints(project, sizeMap) {
    const ov = project.sprintOverrides || {};
    const b = ov.backend != null ? ov.backend : sizeToSprints(project.backend, sizeMap);
    const f = ov.frontend != null ? ov.frontend : sizeToSprints(project.frontend, sizeMap);
    const n = ov.natives != null ? ov.natives : sizeToSprints(project.natives, sizeMap);
    return { backend: b, frontend: f, natives: n, total: b + f + n };
  }
  return { DEFAULT_SIZE_MAP, sizeToSprints, computeProjectSprints };
})();

// ── Config ──
const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = '487456084105-01l0m47e7up61qb40sf2v7gtjmrp6hqt.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ── JWT Token Cache ──
const tokenCache = new Map();
const TOKEN_CACHE_CLEANUP_INTERVAL = 5 * 60 * 1000;

async function verifyGoogleToken(token) {
  if (!token) return null;

  // Check cache first
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    // Validate domain server-side
    if (!payload.email || !payload.email.endsWith('@novibet.com')) {
      return null;
    }

    // Cache the verified result
    tokenCache.set(token, {
      payload,
      expiresAt: payload.exp * 1000,
    });

    return payload;
  } catch (err) {
    console.error('JWT verification failed:', err.message);
    return null;
  }
}

const tokenCacheCleanup = setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokenCache) {
    if (entry.expiresAt <= now) tokenCache.delete(token);
  }
}, TOKEN_CACHE_CLEANUP_INTERVAL);
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'https://capacity-planner-amber.vercel.app';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── JSON File Storage ──
function loadJSON(filename, defaultVal) {
  const fp = path.join(DATA_DIR, filename);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) { console.error(`Error loading ${filename}:`, e.message); }
  return defaultVal;
}

function saveJSON(filename, data) {
  const fp = path.join(DATA_DIR, filename);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
}

function getProjectsFile(key) { return `projects_${key}.json`; }
function getStateFile(key) { return `state_${key}.json`; }
function getCommentsFile(key) { return `comments_${key}.json`; }
function getAlertsFile(key) { return `alerts_${key}.json`; }
const AUDIT_FILE = 'audit_log.json';
const AUDIT_MAX_DAYS = 30;
const EDITORS_FILE = 'editors.json';
const ACCESS_REQUESTS_FILE = 'access_requests.json';
const ADMIN_EMAIL = 'kmermigkas@novibet.com';

const CUSTOM_VERTICALS_FILE = 'custom_verticals.json';

const BUILTIN_VERTICALS = [
  { key: 'growth', label: 'Growth', color: '#6c5ce7', icon: '\u{1F4C8}', builtIn: true },
  { key: 'sportsbook', label: 'Sportsbook', color: '#00b894', icon: '\u{26BD}', builtIn: true },
  { key: 'casino', label: 'Casino', color: '#e84393', icon: '\u{1F3B0}', builtIn: true },
  { key: 'account', label: 'Account', color: '#0984e3', icon: '\u{1F464}', builtIn: true },
  { key: 'payments', label: 'Payments', color: '#fdcb6e', icon: '\u{1F4B3}', builtIn: true },
  { key: 'social', label: 'Social', color: '#00cec9', icon: '\u{1F4F1}', builtIn: true },
];

function loadCustomVerticals() {
  return loadJSON(CUSTOM_VERTICALS_FILE, []);
}

function getAllVerticals() {
  return [...BUILTIN_VERTICALS, ...loadCustomVerticals()];
}

function isValidVertical(key) {
  return getAllVerticals().some(v => v.key === key);
}

// Normalize editor entry: strings (old format) → {email, verticals: ["all"]}
function normalizeEditor(entry) {
  if (typeof entry === 'string') return { email: entry.toLowerCase().trim(), verticals: ['all'] };
  return { email: (entry.email || '').toLowerCase().trim(), verticals: entry.verticals || ['all'] };
}

function loadEditors() {
  return loadJSON(EDITORS_FILE, []).map(normalizeEditor);
}

function isEditorUser(email) {
  if (!email) return false;
  const e = email.toLowerCase();
  if (e === ADMIN_EMAIL) return true;
  return loadEditors().some(ed => ed.email === e);
}

function isEditorForVertical(email, vertical) {
  if (!email) return false;
  const e = email.toLowerCase();
  if (e === ADMIN_EMAIL) return true;
  const ed = loadEditors().find(ed => ed.email === e);
  if (!ed) return false;
  return ed.verticals.includes('all') || ed.verticals.includes(vertical);
}

// ── Input Sanitization ──
const KNOWN_KPIS = new Set(['Revenue', 'Efficiency', 'Experience', '']);

function stripHtmlTags(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '');
}

function sanitizeString(str, maxLength) {
  if (typeof str !== 'string') return str;
  return stripHtmlTags(str).trim().slice(0, maxLength);
}

const SAFE_NOTE_TAGS = new Set(['b','i','u','em','strong','h1','h2','h3','p','br','ul','ol','li','span','blockquote']);
function sanitizeNoteHtml(html, maxLength) {
  if (typeof html !== 'string') return '';
  // Remove on* event attributes and javascript: urls
  let clean = html.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  clean = clean.replace(/href\s*=\s*["']?\s*javascript:[^"'>]*/gi, '');
  // Strip tags not in allowlist
  clean = clean.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*\/?>/gi, (match, tag) => {
    return SAFE_NOTE_TAGS.has(tag.toLowerCase()) ? match.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '') : '';
  });
  return clean.slice(0, maxLength);
}

const PROJECT_STRING_LIMITS = {
  nvrd: 50, masterEpic: 200, subTask: 300,
  pillar: 100, targetMarket: 50, targetKPI: 50,
  description: 2000,
};

function sanitizeProject(project) {
  const sanitized = { ...project };
  for (const [field, limit] of Object.entries(PROJECT_STRING_LIMITS)) {
    if (sanitized[field] != null) {
      sanitized[field] = field === 'description'
        ? sanitizeNoteHtml(String(sanitized[field]), limit)
        : sanitizeString(String(sanitized[field]), limit);
    }
  }
  if (sanitized.targetKPI && !KNOWN_KPIS.has(sanitized.targetKPI)) {
    console.warn(`[sanitize] Unknown targetKPI "${sanitized.targetKPI}" for project ${sanitized.id}`);
  }
  // Sanitize sprintOverrides: keep only valid discipline keys with numeric values
  if (sanitized.sprintOverrides && typeof sanitized.sprintOverrides === 'object' && !Array.isArray(sanitized.sprintOverrides)) {
    const cleaned = {};
    for (const d of ['backend', 'frontend', 'natives']) {
      if (sanitized.sprintOverrides[d] != null) {
        const v = Number(sanitized.sprintOverrides[d]);
        if (!isNaN(v) && v >= 0) cleaned[d] = v;
      }
    }
    sanitized.sprintOverrides = Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }
  return sanitized;
}

function sanitizeMilestones(milestones) {
  if (!Array.isArray(milestones)) return milestones;
  return milestones.map(m => {
    const cleaned = { ...m };
    if (typeof cleaned.name === 'string') cleaned.name = sanitizeString(cleaned.name, 100);
    if (typeof cleaned.label === 'string') cleaned.label = sanitizeString(cleaned.label, 100);
    if (typeof cleaned.description === 'string') cleaned.description = sanitizeString(cleaned.description, 500);
    return cleaned;
  });
}

// ── Audit Logging ──
function logAudit(req, action, details) {
  try {
    // details can be a string or { summary, diffs } object
    const isRich = typeof details === 'object' && details !== null && details.summary;
    const summary = isRich ? details.summary : details;
    if (summary === 'No changes detected') return;
    const userEmail = req.auth.email || (req.body && req.body._userEmail) || 'unknown';
    const userName = req.auth.name || (req.body && req.body._userName) || 'unknown';
    const vertical = req.params.key || '';
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      userEmail,
      userName,
      action,
      vertical,
      details: summary,
      diffs: isRich ? details.diffs : undefined,
      method: req.method,
      endpoint: req.originalUrl || req.url,
    };
    const log = loadJSON(AUDIT_FILE, []);
    log.unshift(entry);
    // Prune entries older than 30 days
    const cutoff = Date.now() - AUDIT_MAX_DAYS * 24 * 60 * 60 * 1000;
    const pruned = log.filter(e => new Date(e.timestamp).getTime() > cutoff);
    saveJSON(AUDIT_FILE, pruned);
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
}

function describeStateChanges(body, existing, vertical) {
  const fields = ['capacity', 'tracks', 'trackCapacity', 'splits', 'splitStatuses', 'timelineConfig', 'milestones', 'timelineOverrides', 'sizeMap', 'trackSubLaneCounts', 'timelineLaneAssignments', 'trackBlockOrder', 'buffer', 'quarterlyCapacity', 'quarterlyTrackCapacity', 'deliveryBlockOrder'];
  const changed = fields.filter(f => {
    if (body[f] === undefined) return false;
    if (!existing || existing[f] === undefined) return true;
    return JSON.stringify(body[f]) !== JSON.stringify(existing[f]);
  });
  if (changed.length === 0) return { summary: 'No changes detected', diffs: [] };

  // Load project names for human-readable descriptions
  const projectLookup = {};
  try {
    const projects = loadJSON(getProjectsFile(vertical), []);
    for (const p of projects) {
      projectLookup[String(p.id)] = p.subTask || p.masterEpic || `Project #${p.id}`;
    }
  } catch (e) { /* ignore */ }

  const defaultTrackNames = { 'core-bonus': 'Core Bonus', 'gateway': 'Gateway', 'seo-aff': 'SEO & Affiliates' };
  const trackNameLookup = { ...defaultTrackNames };
  const trackConfig = (existing && existing.trackConfig) || body.trackConfig;
  if (Array.isArray(trackConfig)) {
    for (const t of trackConfig) trackNameLookup[t.key] = t.label;
  }
  const disciplineNames = { backend: 'Backend', frontend: 'Frontend', natives: 'Natives' };

  const resolveProject = (id) => projectLookup[String(id)] || `Project #${id}`;
  const resolveTrack = (tk) => trackNameLookup[tk] || tk;

  // Build narrative descriptions for each changed field
  const narratives = [];
  for (const f of changed) {
    const before = existing ? existing[f] : undefined;
    const after = body[f];
    try {
      const fieldNarrs = buildNarratives(f, before, after, resolveProject, resolveTrack, disciplineNames);
      narratives.push(...fieldNarrs);
    } catch (e) {
      narratives.push({ text: `Updated ${f}`, icon: 'pencil' });
    }
  }

  // Build a short summary from the first 2 narratives
  const summaryTexts = narratives.slice(0, 2).map(n => n.text);
  if (narratives.length > 2) summaryTexts.push(`and ${narratives.length - 2} more change${narratives.length - 2 > 1 ? 's' : ''}`);
  const summary = summaryTexts.join('; ');

  return { summary, diffs: narratives };
}

// Build human-readable narrative descriptions for a field change
function buildNarratives(field, before, after, resolveProject, resolveTrack, disciplineNames) {
  const narrs = [];

  if (field === 'capacity' || field === 'buffer') {
    // Team capacity or buffer changes — e.g. "Changed Backend capacity from 40 to 46 SP"
    const label = field === 'buffer' ? 'buffer' : 'capacity';
    const allKeys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const k of allKeys) {
      const bVal = (before || {})[k];
      const aVal = (after || {})[k];
      if (bVal !== aVal) {
        const name = disciplineNames[k] || k;
        if (bVal === undefined) narrs.push({ text: `Set ${name} ${label} to ${aVal} SP`, icon: 'plus' });
        else if (aVal === undefined) narrs.push({ text: `Removed ${name} ${label} (was ${bVal} SP)`, icon: 'minus' });
        else narrs.push({ text: `Changed ${name} ${label} from ${bVal} to ${aVal} SP`, icon: bVal < aVal ? 'arrow-up' : 'arrow-down' });
      }
    }
  } else if (field === 'trackCapacity') {
    // Per-track capacity — e.g. "Changed Gateway Backend capacity from 20 to 25 SP"
    const allTracks = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const tk of allTracks) {
      const bObj = (before || {})[tk] || {};
      const aObj = (after || {})[tk] || {};
      const allDisc = new Set([...Object.keys(bObj), ...Object.keys(aObj)]);
      for (const d of allDisc) {
        if (bObj[d] !== aObj[d]) {
          const trackName = resolveTrack(tk);
          const discName = disciplineNames[d] || d;
          if (bObj[d] === undefined) narrs.push({ text: `Set ${trackName} ${discName} capacity to ${aObj[d]} SP`, icon: 'plus' });
          else if (aObj[d] === undefined) narrs.push({ text: `Removed ${trackName} ${discName} capacity (was ${bObj[d]} SP)`, icon: 'minus' });
          else narrs.push({ text: `Changed ${trackName} ${discName} capacity from ${bObj[d]} to ${aObj[d]} SP`, icon: bObj[d] < aObj[d] ? 'arrow-up' : 'arrow-down' });
        }
      }
    }
  } else if (field === 'tracks') {
    // Swimlane assignments — e.g. "Moved 'Casino In-game Offers Widget' to the Gateway swimlane"
    const allTracks = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const tk of allTracks) {
      const bArr = (before || {})[tk] || [];
      const aArr = (after || {})[tk] || [];
      const added = aArr.filter(id => !bArr.includes(id));
      const removed = bArr.filter(id => !aArr.includes(id));
      const trackName = resolveTrack(tk);
      for (const id of added) {
        narrs.push({ text: `Moved "${resolveProject(id)}" to the ${trackName} swimlane`, icon: 'move' });
      }
      for (const id of removed) {
        // Check if it was moved to another track
        let movedTo = null;
        for (const otherTk of allTracks) {
          if (otherTk !== tk && ((after || {})[otherTk] || []).includes(id) && !((before || {})[otherTk] || []).includes(id)) {
            movedTo = resolveTrack(otherTk);
          }
        }
        if (!movedTo) {
          narrs.push({ text: `Removed "${resolveProject(id)}" from the ${trackName} swimlane`, icon: 'minus' });
        }
        // If moved to another track, the "added" entry in the other track handles the description
      }
    }
  } else if (field === 'splits') {
    // Project splits — e.g. "Split 'Casino In-game Offers Widget' to Gateway with 4 Backend SP"
    const allIds = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const pid of allIds) {
      const bSplit = (before || {})[pid];
      const aSplit = (after || {})[pid];
      const projName = resolveProject(pid);
      if (!bSplit && aSplit) {
        // New split
        const parts = [];
        if (aSplit.targetTrack) parts.push(`to ${resolveTrack(aSplit.targetTrack)}`);
        const spParts = [];
        for (const d of ['backend', 'frontend', 'natives']) {
          if (aSplit[d]) spParts.push(`${aSplit[d]} ${disciplineNames[d] || d}`);
        }
        if (spParts.length) parts.push(`with ${spParts.join(', ')}`);
        narrs.push({ text: `Split "${projName}" ${parts.join(' ')}`, icon: 'split' });
      } else if (bSplit && !aSplit) {
        narrs.push({ text: `Removed the split for "${projName}"`, icon: 'minus' });
      } else if (JSON.stringify(bSplit) !== JSON.stringify(aSplit)) {
        // Changed split details
        const changes = [];
        if (bSplit.targetTrack !== aSplit.targetTrack) {
          changes.push(`moved to ${resolveTrack(aSplit.targetTrack)}`);
        }
        for (const d of ['backend', 'frontend', 'natives']) {
          if ((bSplit[d] || 0) !== (aSplit[d] || 0)) {
            changes.push(`${disciplineNames[d] || d}: ${bSplit[d] || 0} → ${aSplit[d] || 0} SP`);
          }
        }
        if (changes.length > 0) {
          narrs.push({ text: `Updated split for "${projName}" — ${changes.join(', ')}`, icon: 'pencil' });
        } else {
          narrs.push({ text: `Updated split settings for "${projName}"`, icon: 'pencil' });
        }
      }
    }
  } else if (field === 'trackBlockOrder') {
    // Block reordering — e.g. "Reordered items in the Gateway swimlane"
    const allTracks = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const tk of allTracks) {
      const bArr = (before || {})[tk] || [];
      const aArr = (after || {})[tk] || [];
      if (JSON.stringify(bArr) !== JSON.stringify(aArr)) {
        const trackName = resolveTrack(tk);
        const added = aArr.filter(k => !bArr.includes(k));
        const removed = bArr.filter(k => !aArr.includes(k));
        if (added.length > 0 && removed.length === 0) {
          // Items added to the order
          const names = added.map(k => {
            const isGhost = k.startsWith('ghost:');
            const id = isGhost ? k.replace('ghost:', '') : k;
            return `"${resolveProject(id)}"${isGhost ? ' (split)' : ''}`;
          });
          narrs.push({ text: `Added ${names.join(', ')} to ${trackName} ordering`, icon: 'move' });
        } else if (removed.length > 0 && added.length === 0) {
          narrs.push({ text: `Removed items from ${trackName} ordering`, icon: 'minus' });
        } else {
          // Pure reorder — figure out which item moved
          const movedItem = findMovedItem(bArr, aArr, resolveProject);
          if (movedItem) {
            narrs.push({ text: movedItem, icon: 'move' });
          } else {
            narrs.push({ text: `Reordered items in the ${trackName} swimlane`, icon: 'move' });
          }
        }
      }
    }
  } else if (field === 'milestones') {
    const bArr = before || [];
    const aArr = after || [];
    if (aArr.length > bArr.length) {
      const newOnes = aArr.slice(bArr.length);
      for (const m of newOnes) {
        narrs.push({ text: `Added milestone "${m.label || m.name || 'Unnamed'}" at week ${m.week || '?'}`, icon: 'plus' });
      }
    } else if (aArr.length < bArr.length) {
      narrs.push({ text: `Removed ${bArr.length - aArr.length} milestone${bArr.length - aArr.length > 1 ? 's' : ''}`, icon: 'minus' });
    } else {
      narrs.push({ text: `Updated milestone settings`, icon: 'pencil' });
    }
  } else if (field === 'timelineConfig') {
    const changes = [];
    if ((before || {}).totalWeeks !== (after || {}).totalWeeks) {
      changes.push(`timeline length from ${(before || {}).totalWeeks || '?'} to ${(after || {}).totalWeeks || '?'} weeks`);
    }
    if ((before || {}).sprintWeeks !== (after || {}).sprintWeeks) {
      changes.push(`sprint length from ${(before || {}).sprintWeeks || '?'} to ${(after || {}).sprintWeeks || '?'} weeks`);
    }
    if (changes.length > 0) {
      narrs.push({ text: `Changed ${changes.join(' and ')}`, icon: 'pencil' });
    } else {
      narrs.push({ text: `Updated timeline configuration`, icon: 'pencil' });
    }
  } else if (field === 'timelineOverrides') {
    // Bar position changes — "Moved timeline bar for project X to start at week 3"
    const allIds = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    let count = 0;
    for (const pid of allIds) {
      const bOvr = (before || {})[pid];
      const aOvr = (after || {})[pid];
      if (JSON.stringify(bOvr) !== JSON.stringify(aOvr)) {
        count++;
        if (count <= 3) {
          const projName = resolveProject(pid);
          if (!bOvr && aOvr) {
            narrs.push({ text: `Positioned "${projName}" on the timeline at week ${aOvr.startWeek || '?'}`, icon: 'move' });
          } else if (bOvr && !aOvr) {
            narrs.push({ text: `Reset timeline position for "${projName}"`, icon: 'minus' });
          } else {
            const parts = [];
            if ((bOvr || {}).startWeek !== (aOvr || {}).startWeek) parts.push(`start: week ${(bOvr || {}).startWeek || '?'} → ${(aOvr || {}).startWeek || '?'}`);
            if ((bOvr || {}).endWeek !== (aOvr || {}).endWeek) parts.push(`end: week ${(bOvr || {}).endWeek || '?'} → ${(aOvr || {}).endWeek || '?'}`);
            narrs.push({ text: `Moved "${projName}" on the timeline (${parts.join(', ') || 'adjusted position'})`, icon: 'move' });
          }
        }
      }
    }
    if (count > 3) {
      narrs.push({ text: `...and ${count - 3} more timeline position change${count - 3 > 1 ? 's' : ''}`, icon: 'pencil' });
    }
  } else if (field === 'sizeMap') {
    narrs.push({ text: `Updated size estimation settings`, icon: 'pencil' });
  } else if (field === 'trackSubLaneCounts') {
    const allTracks = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const tk of allTracks) {
      const bVal = (before || {})[tk];
      const aVal = (after || {})[tk];
      if (bVal !== aVal) {
        narrs.push({ text: `Changed ${resolveTrack(tk)} sub-lanes from ${bVal || 1} to ${aVal || 1}`, icon: 'pencil' });
      }
    }
  } else if (field === 'timelineLaneAssignments') {
    const count = Object.keys(after || {}).length;
    narrs.push({ text: `Updated timeline lane assignments (${count} project${count !== 1 ? 's' : ''})`, icon: 'pencil' });
  } else if (field === 'quarterlyCapacity') {
    const allQs = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const q of allQs) {
      const bQ = (before || {})[q] || {};
      const aQ = (after || {})[q] || {};
      for (const d of ['backend', 'frontend', 'natives']) {
        if ((bQ[d] || 0) !== (aQ[d] || 0)) {
          const name = disciplineNames[d] || d;
          narrs.push({ text: `Changed ${q} ${name} capacity from ${bQ[d] || 0} to ${aQ[d] || 0} SP`, icon: (bQ[d] || 0) < (aQ[d] || 0) ? 'arrow-up' : 'arrow-down' });
        }
      }
    }
  } else if (field === 'quarterlyTrackCapacity') {
    const allQs = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const q of allQs) {
      const bQ = (before || {})[q] || {};
      const aQ = (after || {})[q] || {};
      const allTracks = new Set([...Object.keys(bQ), ...Object.keys(aQ)]);
      for (const tk of allTracks) {
        const bT = bQ[tk] || {};
        const aT = aQ[tk] || {};
        for (const d of ['backend', 'frontend', 'natives']) {
          if ((bT[d] || 0) !== (aT[d] || 0)) {
            const trackName = resolveTrack(tk);
            const name = disciplineNames[d] || d;
            narrs.push({ text: `Changed ${q} ${trackName} ${name} capacity from ${bT[d] || 0} to ${aT[d] || 0} SP`, icon: (bT[d] || 0) < (aT[d] || 0) ? 'arrow-up' : 'arrow-down' });
          }
        }
      }
    }
  } else if (field === 'deliveryBlockOrder') {
    narrs.push({ text: 'Reordered delivery board', icon: 'reorder' });
  } else {
    narrs.push({ text: `Updated ${field}`, icon: 'pencil' });
  }

  return narrs.length > 0 ? narrs : [{ text: `Updated ${field}`, icon: 'pencil' }];
}

// Try to identify which item was moved in a reorder
function findMovedItem(bArr, aArr, resolveProject) {
  if (bArr.length !== aArr.length) return null;
  // Find the item whose position changed most
  for (let i = 0; i < aArr.length; i++) {
    const oldIdx = bArr.indexOf(aArr[i]);
    if (oldIdx !== i && oldIdx !== -1) {
      const id = aArr[i];
      const isGhost = id.startsWith('ghost:');
      const projId = isGhost ? id.replace('ghost:', '') : id;
      const projName = resolveProject(projId);
      const suffix = isGhost ? ' (split)' : '';
      if (i === 0) return `Moved "${projName}"${suffix} to the beginning of the row`;
      if (i === aArr.length - 1) return `Moved "${projName}"${suffix} to the end of the row`;
      return `Moved "${projName}"${suffix} to position ${i + 1}`;
    }
  }
  return null;
}

function summarizeValue(val) {
  if (val === undefined || val === null) return '—';
  if (typeof val !== 'object') return String(val);
  const json = JSON.stringify(val);
  return json.length > 80 ? json.substring(0, 77) + '...' : json;
}

const DEFAULT_CAPACITY = { backend: 40, frontend: 30, natives: 25 };
const DEFAULT_TRACKS = { 'core-bonus': [], 'gateway': [], 'seo-aff': [] };

// ── Seed Growth data if empty ──
if (!fs.existsSync(path.join(DATA_DIR, getProjectsFile('growth')))) {
  console.log('Seeding Growth vertical data...');
  const SEED = [
    {id:1,nvrd:"PGR-362",masterEpic:"Marketplace",subTask:"[Marketplace] CY Expansion",pillar:"Expansion",targetMarket:"CY",targetKPI:"Revenue",impact:"L",backend:"S",frontend:"XS",natives:"S",inProgress:true},
    {id:2,nvrd:"PGR-363",masterEpic:"Marketplace",subTask:"[Marketplace] MX Expansion",pillar:"Expansion",targetMarket:"MX",targetKPI:"Revenue",impact:"XL",backend:"XS",frontend:"XS",natives:"S",inProgress:false},
    {id:3,nvrd:"PGR-293",masterEpic:"Nova",subTask:"Nova Integration: New customers",pillar:"Acquisition",targetMarket:"GR",targetKPI:"Revenue",impact:"XS",backend:"M",frontend:"",natives:"",inProgress:false},
    {id:4,nvrd:"PGR-376",masterEpic:"Marketplace",subTask:"[Marketplace] CoinHunt Scalability",pillar:"Core Platform",targetMarket:"Global",targetKPI:"Efficiency",impact:"XL",backend:"L",frontend:"",natives:"",inProgress:false},
    {id:5,nvrd:"PGR-199",masterEpic:"Comms",subTask:"In-app Notification Channel",pillar:"Comms",targetMarket:"Global",targetKPI:"Experience",impact:"L",backend:"S",frontend:"S",natives:"M",inProgress:false},
    {id:6,nvrd:"PGR-21",masterEpic:"Challenges",subTask:"[EPIC] Challenges Revamp (SB & CA)",pillar:"Comms",targetMarket:"Global",targetKPI:"Experience",impact:"L",backend:"XL",frontend:"L",natives:"XL",inProgress:false},
    {id:7,nvrd:"PGR-359",masterEpic:"Reporting",subTask:"[EPIC] Internal Campaign Reporting & Rewards Progress",pillar:"Core Platform",targetMarket:"Global",targetKPI:"Efficiency",impact:"XXXL",backend:"L",frontend:"",natives:"",inProgress:false},
    {id:8,nvrd:"PGR-299",masterEpic:"Optimove",subTask:"[Optimove] Inbox Integration",pillar:"Comms",targetMarket:"Global",targetKPI:"Efficiency",impact:"M",backend:"M",frontend:"",natives:"",inProgress:false},
    {id:9,nvrd:"PGR-313",masterEpic:"Marketplace",subTask:"Update Casino Loyalty Config - Novibet Club",pillar:"Expansion",targetMarket:"BR",targetKPI:"Revenue",impact:"M",backend:"S",frontend:"",natives:"",inProgress:false},
    {id:10,nvrd:"PGR-149",masterEpic:"Offers",subTask:"Casino In-game Offers Widget",pillar:"Comms",targetMarket:"Global",targetKPI:"Experience",impact:"L",backend:"XL",frontend:"M",natives:"L",inProgress:false},
    {id:11,nvrd:"PGR-145",masterEpic:"Offers",subTask:"[EPIC] 1-click Offers Opt-in",pillar:"Comms",targetMarket:"Global",targetKPI:"Revenue",impact:"M",backend:"XL",frontend:"S",natives:"M",inProgress:false},
    {id:12,nvrd:"PGR-148",masterEpic:"Offers",subTask:"[EPIC] Offers Consolidation & Unification",pillar:"Core Platform",targetMarket:"Global",targetKPI:"Efficiency",impact:"XXL",backend:"XXXL",frontend:"XXXL",natives:"XXXL",inProgress:false},
    {id:13,nvrd:"PGR-314",masterEpic:"Welcome Offer v2",subTask:"Welcome Offer Revamp v2",pillar:"Acquisition",targetMarket:"GR",targetKPI:"Revenue",impact:"XL",backend:"XXL",frontend:"L",natives:"L",inProgress:false},
    {id:14,nvrd:"PGR-315",masterEpic:"Welcome Offer v2",subTask:"[Welcome Offer v2] Casino WO",pillar:"Acquisition",targetMarket:"GR",targetKPI:"Revenue",impact:"L",backend:"XL",frontend:"M",natives:"M",inProgress:false},
    {id:15,nvrd:"PGR-316",masterEpic:"Marketplace",subTask:"Marketplace: In-play mini game (Predictor / Slot / Wheel)",pillar:"Gamification",targetMarket:"Global",targetKPI:"Experience",impact:"XL",backend:"XXL",frontend:"M",natives:"L",inProgress:false},
    {id:16,nvrd:"PGR-317",masterEpic:"Challenges",subTask:"[Challenges] Leader Board",pillar:"Gamification",targetMarket:"Global",targetKPI:"Experience",impact:"L",backend:"XL",frontend:"L",natives:"XL",inProgress:false},
    {id:17,nvrd:"PGR-318",masterEpic:"Challenges",subTask:"[Challenges] Teams/Guilds/Social",pillar:"Gamification",targetMarket:"Global",targetKPI:"Experience",impact:"L",backend:"XXL",frontend:"L",natives:"XL",inProgress:false},
    {id:18,nvrd:"PGR-319",masterEpic:"Offers",subTask:"[Offers] Deep-link Offers from External Channels (Email/Push)",pillar:"Comms",targetMarket:"Global",targetKPI:"Revenue",impact:"M",backend:"M",frontend:"S",natives:"M",inProgress:false},
    {id:19,nvrd:"PGR-320",masterEpic:"Comms",subTask:"[Comms] WhatsApp Channel Integration",pillar:"Comms",targetMarket:"BR",targetKPI:"Revenue",impact:"M",backend:"M",frontend:"",natives:"",inProgress:false},
    {id:20,nvrd:"PGR-321",masterEpic:"Comms",subTask:"[Comms] Telegram Channel Integration",pillar:"Comms",targetMarket:"Global",targetKPI:"Experience",impact:"S",backend:"M",frontend:"",natives:"",inProgress:false},
    {id:21,nvrd:"PGR-322",masterEpic:"Comms",subTask:"Onsite Notification Feed Panel",pillar:"Comms",targetMarket:"Global",targetKPI:"Experience",impact:"M",backend:"S",frontend:"M",natives:"M",inProgress:false},
    {id:22,nvrd:"PGR-323",masterEpic:"Optimove",subTask:"[Optimove] Triggered Campaign Support",pillar:"Comms",targetMarket:"Global",targetKPI:"Revenue",impact:"L",backend:"L",frontend:"",natives:"",inProgress:false},
    {id:23,nvrd:"PGR-324",masterEpic:"Optimove",subTask:"[Optimove] A/B Testing Integration",pillar:"Comms",targetMarket:"Global",targetKPI:"Efficiency",impact:"M",backend:"M",frontend:"",natives:"",inProgress:false},
    {id:24,nvrd:"PGR-325",masterEpic:"Offers",subTask:"[Offers] Automated Bonus Suggestions (AI/ML)",pillar:"Core Platform",targetMarket:"Global",targetKPI:"Revenue",impact:"XXL",backend:"XXL",frontend:"M",natives:"M",inProgress:false},
    {id:25,nvrd:"PGR-326",masterEpic:"Reporting",subTask:"[Reporting] Campaign ROI Dashboard",pillar:"Core Platform",targetMarket:"Global",targetKPI:"Efficiency",impact:"XL",backend:"L",frontend:"L",natives:"",inProgress:false},
    {id:26,nvrd:"PGR-327",masterEpic:"Reporting",subTask:"[Reporting] Player Lifecycle Analytics",pillar:"Core Platform",targetMarket:"Global",targetKPI:"Efficiency",impact:"L",backend:"L",frontend:"M",natives:"",inProgress:false},
    {id:27,nvrd:"PGR-328",masterEpic:"Budget Optimization",subTask:"[Budget] Dynamic Budget Allocation Engine",pillar:"Core Platform",targetMarket:"Global",targetKPI:"Revenue",impact:"XXL",backend:"XXL",frontend:"L",natives:"",inProgress:false},
    {id:28,nvrd:"PGR-329",masterEpic:"Budget Optimization",subTask:"[Budget] Spend vs Performance Tracker",pillar:"Core Platform",targetMarket:"Global",targetKPI:"Efficiency",impact:"L",backend:"L",frontend:"M",natives:"",inProgress:false},
    {id:29,nvrd:"PGR-330",masterEpic:"Marketplace",subTask:"[Marketplace] Reward Shop",pillar:"Gamification",targetMarket:"Global",targetKPI:"Experience",impact:"XL",backend:"XL",frontend:"L",natives:"L",inProgress:false},
    {id:30,nvrd:"PGR-331",masterEpic:"Marketplace",subTask:"[Marketplace] BR Expansion",pillar:"Expansion",targetMarket:"BR",targetKPI:"Revenue",impact:"XL",backend:"S",frontend:"XS",natives:"S",inProgress:false},
    {id:31,nvrd:"PGR-332",masterEpic:"Challenges",subTask:"[Challenges] Daily/Weekly Streaks",pillar:"Gamification",targetMarket:"Global",targetKPI:"Experience",impact:"M",backend:"L",frontend:"M",natives:"L",inProgress:false},
    {id:32,nvrd:"PGR-333",masterEpic:"Challenges",subTask:"[Challenges] Custom Challenge Builder (Internal Tool)",pillar:"Core Platform",targetMarket:"Global",targetKPI:"Efficiency",impact:"L",backend:"XL",frontend:"XL",natives:"",inProgress:false},
    {id:33,nvrd:"PGR-334",masterEpic:"Comms",subTask:"[Comms] Rich Push Notifications (Images/Actions)",pillar:"Comms",targetMarket:"Global",targetKPI:"Experience",impact:"S",backend:"S",frontend:"",natives:"M",inProgress:false},
    {id:34,nvrd:"PGR-335",masterEpic:"Comms",subTask:"[Comms] SMS Fallback for Critical Notifications",pillar:"Comms",targetMarket:"Global",targetKPI:"Experience",impact:"S",backend:"M",frontend:"",natives:"",inProgress:false},
    {id:35,nvrd:"PGR-336",masterEpic:"Nova",subTask:"[Nova] Existing Customer Re-engagement Campaigns",pillar:"Acquisition",targetMarket:"GR",targetKPI:"Revenue",impact:"M",backend:"M",frontend:"S",natives:"",inProgress:false},
    {id:36,nvrd:"PGR-337",masterEpic:"Nova",subTask:"[Nova] Attribution & Tracking Improvements",pillar:"Acquisition",targetMarket:"GR",targetKPI:"Efficiency",impact:"M",backend:"L",frontend:"S",natives:"XS",inProgress:false},
    {id:37,nvrd:"PGR-338",masterEpic:"SEO & Affiliates",subTask:"[SEO] Content Management & SEO Toolkit",pillar:"Acquisition",targetMarket:"Global",targetKPI:"Revenue",impact:"L",backend:"M",frontend:"L",natives:"",inProgress:false},
    {id:38,nvrd:"PGR-339",masterEpic:"SEO & Affiliates",subTask:"[Affiliates] Partner Dashboard & Tracking",pillar:"Acquisition",targetMarket:"Global",targetKPI:"Revenue",impact:"L",backend:"L",frontend:"L",natives:"",inProgress:false},
    {id:39,nvrd:"PGR-340",masterEpic:"Offers",subTask:"[Offers] Geo-targeted Promotions",pillar:"Expansion",targetMarket:"Global",targetKPI:"Revenue",impact:"M",backend:"M",frontend:"S",natives:"S",inProgress:false},
    {id:40,nvrd:"PGR-341",masterEpic:"Offers",subTask:"[Offers] Time-limited Flash Deals Engine",pillar:"Core Bonus",targetMarket:"Global",targetKPI:"Revenue",impact:"L",backend:"L",frontend:"M",natives:"M",inProgress:false},
    {id:41,nvrd:"PGR-342",masterEpic:"Offers",subTask:"[Offers] VIP Tier-based Rewards System",pillar:"Core Bonus",targetMarket:"Global",targetKPI:"Revenue",impact:"XL",backend:"XXL",frontend:"L",natives:"L",inProgress:false},
    {id:42,nvrd:"PGR-343",masterEpic:"Offers",subTask:"[Offers] Cross-product Bundle Offers",pillar:"Core Bonus",targetMarket:"Global",targetKPI:"Revenue",impact:"L",backend:"L",frontend:"M",natives:"M",inProgress:false},
    {id:43,nvrd:"PGR-344",masterEpic:"Predictor",subTask:"[Predictor] Free-to-Play Predictor Game",pillar:"Gamification",targetMarket:"Global",targetKPI:"Experience",impact:"XL",backend:"XXL",frontend:"L",natives:"L",inProgress:false},
    {id:44,nvrd:"PGR-345",masterEpic:"Predictor",subTask:"[Predictor] Social Sharing & Leaderboards",pillar:"Gamification",targetMarket:"Global",targetKPI:"Experience",impact:"M",backend:"L",frontend:"M",natives:"M",inProgress:false},
    {id:45,nvrd:"PGR-346",masterEpic:"Marketplace",subTask:"[Marketplace] Dynamic Pricing Engine",pillar:"Core Platform",targetMarket:"Global",targetKPI:"Revenue",impact:"XXL",backend:"XXL",frontend:"S",natives:"S",inProgress:false},
    {id:46,nvrd:"PGR-347",masterEpic:"Marketplace",subTask:"[Marketplace] Multi-currency Support Enhancement",pillar:"Expansion",targetMarket:"Global",targetKPI:"Efficiency",impact:"L",backend:"L",frontend:"S",natives:"S",inProgress:false},
    {id:47,nvrd:"PGR-348",masterEpic:"Reporting",subTask:"[Reporting] Real-time Engagement Metrics Dashboard",pillar:"Core Platform",targetMarket:"Global",targetKPI:"Efficiency",impact:"L",backend:"M",frontend:"L",natives:"",inProgress:false},
    {id:48,nvrd:"PGR-349",masterEpic:"Comms",subTask:"[Comms] Preference Center & Opt-in Management",pillar:"Comms",targetMarket:"Global",targetKPI:"Experience",impact:"M",backend:"M",frontend:"M",natives:"M",inProgress:false},
    {id:49,nvrd:"PGR-350",masterEpic:"Challenges",subTask:"[Challenges] Achievement Badges & Collectibles",pillar:"Gamification",targetMarket:"Global",targetKPI:"Experience",impact:"M",backend:"L",frontend:"M",natives:"L",inProgress:false},
    {id:50,nvrd:"PGR-351",masterEpic:"Welcome Offer v2",subTask:"[Welcome Offer v2] Personalized Onboarding Flow",pillar:"Acquisition",targetMarket:"Global",targetKPI:"Revenue",impact:"L",backend:"L",frontend:"L",natives:"L",inProgress:false},
    {id:51,nvrd:"PGR-352",masterEpic:"Optimove",subTask:"[Optimove] Predictive Churn Prevention",pillar:"Comms",targetMarket:"Global",targetKPI:"Revenue",impact:"XL",backend:"XL",frontend:"S",natives:"",inProgress:false},
    {id:52,nvrd:"PGR-353",masterEpic:"Budget Optimization",subTask:"[Budget] Channel Mix Optimizer",pillar:"Core Platform",targetMarket:"Global",targetKPI:"Revenue",impact:"L",backend:"L",frontend:"M",natives:"",inProgress:false},
    {id:53,nvrd:"PGR-354",masterEpic:"Offers",subTask:"[Offers] Cashback & Rebate System",pillar:"Core Bonus",targetMarket:"Global",targetKPI:"Revenue",impact:"L",backend:"XL",frontend:"M",natives:"M",inProgress:false},
    {id:54,nvrd:"PGR-355",masterEpic:"Marketplace",subTask:"[Marketplace] Vendor Onboarding Portal",pillar:"Core Platform",targetMarket:"Global",targetKPI:"Efficiency",impact:"M",backend:"L",frontend:"L",natives:"",inProgress:false},
    {id:55,nvrd:"PGR-356",masterEpic:"Comms",subTask:"[Comms] In-app Survey & Feedback Module",pillar:"Comms",targetMarket:"Global",targetKPI:"Experience",impact:"S",backend:"M",frontend:"M",natives:"M",inProgress:false},
    {id:56,nvrd:"PGR-357",masterEpic:"Nova",subTask:"[Nova] Referral Program 2.0",pillar:"Acquisition",targetMarket:"GR",targetKPI:"Revenue",impact:"L",backend:"L",frontend:"M",natives:"M",inProgress:false},
    {id:57,nvrd:"PGR-358",masterEpic:"Reporting",subTask:"[Reporting] Automated Weekly Stakeholder Reports",pillar:"Core Platform",targetMarket:"Global",targetKPI:"Efficiency",impact:"M",backend:"M",frontend:"S",natives:"",inProgress:false},
    {id:58,nvrd:"PGR-360",masterEpic:"Challenges",subTask:"[Challenges] Multi-sport Challenge Templates",pillar:"Gamification",targetMarket:"Global",targetKPI:"Experience",impact:"M",backend:"L",frontend:"M",natives:"L",inProgress:false},
    {id:59,nvrd:"PGR-361",masterEpic:"Offers",subTask:"[Offers] Loyalty Points Exchange System",pillar:"Core Bonus",targetMarket:"Global",targetKPI:"Revenue",impact:"L",backend:"XL",frontend:"L",natives:"L",inProgress:false},
    {id:60,nvrd:"PGR-364",masterEpic:"Marketplace",subTask:"[Marketplace] GR Enhancement Pack",pillar:"Expansion",targetMarket:"GR",targetKPI:"Revenue",impact:"M",backend:"S",frontend:"S",natives:"S",inProgress:false},
    {id:61,nvrd:"PGR-365",masterEpic:"Comms",subTask:"[Comms] Email Template Builder",pillar:"Comms",targetMarket:"Global",targetKPI:"Efficiency",impact:"M",backend:"S",frontend:"L",natives:"",inProgress:false},
    {id:62,nvrd:"PGR-366",masterEpic:"Predictor",subTask:"[Predictor] Integration with Live Events",pillar:"Gamification",targetMarket:"Global",targetKPI:"Experience",impact:"L",backend:"XL",frontend:"M",natives:"M",inProgress:false},
    {id:63,nvrd:"PGR-367",masterEpic:"SEO & Affiliates",subTask:"[SEO] Technical SEO Automation Suite",pillar:"Acquisition",targetMarket:"Global",targetKPI:"Efficiency",impact:"M",backend:"L",frontend:"M",natives:"",inProgress:false},
  ];
  saveJSON(getProjectsFile('growth'), SEED);

  const inProgressIds = SEED.filter(p => p.inProgress).map(p => p.id);
  saveJSON(getStateFile('growth'), {
    capacity: { ...DEFAULT_CAPACITY },
    tracks: { 'core-bonus': inProgressIds, 'gateway': [], 'seo-aff': [] },
    trackConfig: [
      { key: 'core-bonus', label: 'Core Bonus', color: '#636e72' },
      { key: 'gateway', label: 'Gateway', color: '#636e72' },
      { key: 'seo-aff', label: 'SEO & AFF', color: '#636e72' },
    ],
  });
  console.log(`Seeded ${SEED.length} Growth projects`);
}

// ── Seed "test" custom vertical (admin-only playground) ──
const _existingCustom = loadCustomVerticals();
if (!_existingCustom.some(v => v.key === 'test')) {
  _existingCustom.push({
    key: 'test', label: 'Test', color: '#a29bfe', icon: '\u{1F9EA}',
    builtIn: false, adminOnly: true,
    createdAt: new Date().toISOString(), createdBy: ADMIN_EMAIL,
  });
  saveJSON(CUSTOM_VERTICALS_FILE, _existingCustom);
  console.log('Seeded "test" custom vertical (admin-only)');
}

// ── Express App ──
const app = express();
app.use(cors({
  origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(','),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Email', 'X-User-Name', 'X-User-Picture', 'X-WS-ID'],
}));
app.use(express.json({ limit: '5mb' }));

// ── Security headers ──
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ── Rate limiting ──
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 200; // requests per window
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { start: now, count: 1 });
  } else {
    entry.count++;
    if (entry.count > RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
  }
  next();
});
// Clean up stale rate limit entries every 5 minutes
const rateLimitCleanup = setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW;
  for (const [ip, entry] of rateLimitMap) {
    if (entry.start < cutoff) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

// ── Authentication: verify JWT and populate req.auth ──
app.use(async (req, res, next) => {
  req.auth = { email: '', name: '', picture: '', verified: false };

  // Extract token from Authorization header or body
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.body && req.body._token) {
    token = req.body._token;
  }

  if (token) {
    const payload = await verifyGoogleToken(token);
    if (payload) {
      req.auth = {
        email: payload.email.toLowerCase(),
        name: payload.name || '',
        picture: payload.picture || '',
        verified: true,
      };
    } else {
      console.warn('[auth] JWT verification failed, falling back to headers for:', req.method, req.path);
    }
  }

  // Fallback: use X-User-Email headers when JWT is absent or verification failed
  // This covers test mode AND production graceful degradation (e.g. expired tokens)
  if (!req.auth.verified) {
    const headerEmail = req.headers['x-user-email'];
    if (headerEmail) {
      req.auth = {
        email: headerEmail.toLowerCase(),
        name: req.headers['x-user-name'] ? decodeURIComponent(req.headers['x-user-name']) : '',
        picture: req.headers['x-user-picture'] || '',
        verified: false,
      };
    }
  }

  next();
});

// ── Authorization: reject writes from non-authenticated/non-editors ──
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    if (req.path === '/api/test-post' || req.path === '/api/health' || req.path === '/api/editors/request') return next();

    const email = req.auth.email;
    // Check per-vertical access for vertical routes
    const verticalMatch = req.path.match(/^\/api\/verticals\/([^/]+)/);
    if (verticalMatch) {
      if (!isEditorForVertical(email, verticalMatch[1])) {
        return res.status(403).json({ error: 'No editor access for this vertical.' });
      }
    } else if (!isEditorUser(email)) {
      return res.status(403).json({ error: 'View-only access. Contact admin for editor permissions.' });
    }
  }
  next();
});

// ── Debug: test POST endpoint ──
app.post('/api/test-post', (req, res) => {
  res.json({ ok: true, method: req.method, path: req.path, bodyKeys: Object.keys(req.body || {}) });
});

// ── Health ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Auth status (debug) ──
app.get('/api/auth-status', (req, res) => {
  res.json({
    email: req.auth.email || null,
    name: req.auth.name || null,
    verified: req.auth.verified,
    method: req.auth.verified ? 'jwt' : (req.auth.email ? 'header-fallback' : 'none'),
    tokenCacheSize: tokenCache.size,
  });
});

// ── List verticals ──
app.get('/api/verticals', (req, res) => {
  const email = req.auth.email;
  const isAdmin = email === ADMIN_EMAIL;
  let verticals = getAllVerticals();
  if (!isAdmin) {
    verticals = verticals.filter(v => !v.adminOnly);
  }
  const result = verticals.map(v => {
    const projects = loadJSON(getProjectsFile(v.key), []);
    return { key: v.key, label: v.label, color: v.color, icon: v.icon, builtIn: !!v.builtIn, adminOnly: !!v.adminOnly, projectCount: projects.length };
  });
  res.json(result);
});

// ── Get projects for a vertical ──
app.get('/api/verticals/:key/projects', (req, res) => {
  if (!isValidVertical(req.params.key)) return res.status(400).json({ error: 'Invalid vertical' });
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const projects = loadJSON(getProjectsFile(req.params.key), []);
  res.json({ projects, totalCount: projects.length });
});

// ── Lightweight poll endpoint — returns updatedAt + project count without full state ──
app.get('/api/verticals/:key/poll', (req, res) => {
  if (!isValidVertical(req.params.key)) return res.status(400).json({ error: 'Invalid vertical' });
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const state = loadJSON(getStateFile(req.params.key), {});
  const projects = loadJSON(getProjectsFile(req.params.key), []);
  res.json({
    updatedAt: state.updatedAt || null,
    _fieldTs: state._fieldTs || {},
    projectCount: projects.length,
    projectsUpdatedAt: projects.length > 0 ? state.updatedAt : null,
  });
});

// ── Merge-safe fields list ──
const STATE_FIELDS = ['capacity', 'tracks', 'trackCapacity', 'splits', 'splitStatuses', 'timelineConfig', 'milestones', 'timelineOverrides', 'sizeMap', 'trackSubLaneCounts', 'timelineLaneAssignments', 'trackBlockOrder', 'buffer', 'trackConfig', 'quarterlyCapacity', 'quarterlyTrackCapacity', 'deliveryBlockOrder'];

// ── Get state for a vertical ──
app.get('/api/verticals/:key/state', (req, res) => {
  if (!isValidVertical(req.params.key)) return res.status(400).json({ error: 'Invalid vertical' });
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const state = loadJSON(getStateFile(req.params.key), {
    capacity: { ...DEFAULT_CAPACITY },
    tracks: { ...DEFAULT_TRACKS },
  });
  // Include server timestamp so clients can do conflict-free merges
  state._loadedAt = Date.now();
  res.json(state);
});

// ── Save state for a vertical (POST + PUT) ──
function saveStateHandler(req, res) {
  const { _loadedAt } = req.body;
  // No longer require all fields — clients now send only changed fields
  const hasAnyField = STATE_FIELDS.some(f => req.body[f] !== undefined);
  if (!hasAnyField) {
    return res.status(400).json({ error: 'No state fields provided' });
  }

  // Sanitize milestone content if present
  if (req.body.milestones) {
    req.body.milestones = sanitizeMilestones(req.body.milestones);
  }

  const existing = loadJSON(getStateFile(req.params.key), {});
  const fieldTs = existing._fieldTs || {};
  const now = Date.now();
  const clientLoadedAt = _loadedAt || 0;

  // Build merged state: for each field, only accept client's version
  // if the field wasn't updated by someone else after this client loaded
  const state = { ...existing, updatedAt: new Date().toISOString() };
  const accepted = [];
  const rejected = [];

  for (const field of STATE_FIELDS) {
    const clientValue = req.body[field];
    if (clientValue === undefined) continue;

    const fieldLastModified = fieldTs[field] || 0;

    if (clientLoadedAt === 0 || fieldLastModified <= clientLoadedAt) {
      // No conflict — accept client's value
      // But only bump the field timestamp if the value actually changed
      // (prevents no-op saves from creating false conflicts for other clients)
      const valueChanged = JSON.stringify(clientValue) !== JSON.stringify(existing[field]);
      state[field] = clientValue;
      if (valueChanged) {
        fieldTs[field] = now;
        accepted.push(field);
      }
    } else if (
      // Conflict on an object field — do sub-key merge instead of rejecting.
      clientValue && typeof clientValue === 'object' && !Array.isArray(clientValue) &&
      existing[field] && typeof existing[field] === 'object' && !Array.isArray(existing[field])
    ) {
      try {
        // Start from the CLIENT's version (respects deletions), then overlay
        // any server-side keys that the client didn't change.
        const merged = { ...clientValue };
        const changedSubKeys = [];
        // Detect keys the client added or modified
        for (const subKey of Object.keys(clientValue)) {
          if (JSON.stringify(clientValue[subKey]) !== JSON.stringify((existing[field] || {})[subKey])) {
            changedSubKeys.push(subKey);
          }
        }
        // Detect keys the client deleted (present on server, absent in client)
        const deletedKeys = [];
        for (const subKey of Object.keys(existing[field])) {
          if (!(subKey in clientValue)) {
            deletedKeys.push(subKey);
            // Don't add this key to merged — respect the deletion
          }
        }
        // Re-add server keys the client didn't touch (present in both, unchanged)
        // These are already in merged via { ...clientValue }
        if (changedSubKeys.length > 0 || deletedKeys.length > 0) {
          state[field] = merged;
          fieldTs[field] = now;
          const desc = [];
          if (changedSubKeys.length) desc.push('changed:' + changedSubKeys.join(','));
          if (deletedKeys.length) desc.push('deleted:' + deletedKeys.join(','));
          accepted.push(field + '(merged:' + desc.join(';') + ')');
        }
      } catch (mergeErr) {
        console.error('[merge] Sub-key merge failed for field ' + field + ':', mergeErr.message);
        rejected.push(field);
      }
    } else {
      // Conflict on a non-object field — keep server's version
      rejected.push(field);
    }
  }

  state._fieldTs = fieldTs;
  saveJSON(getStateFile(req.params.key), state);

  if (rejected.length > 0) {
    console.log(`[merge] Vertical ${req.params.key}: accepted=[${accepted}] rejected=[${rejected}] (stale by ${now - clientLoadedAt}ms)`);
  }

  logAudit(req, 'Updated state', describeStateChanges(req.body, existing, req.params.key));

  // Return merged state so client can sync up
  const responseState = { ...state };
  responseState._loadedAt = now;
  delete responseState._fieldTs;
  res.json({ success: true, mergedState: responseState, conflicts: rejected });

  // Broadcast to WebSocket clients so other tabs refresh instantly
  const senderId = req.headers['x-ws-id'] || '';
  broadcastUpdate(req.params.key, state.updatedAt, senderId);
}
app.post('/api/verticals/:key/state', saveStateHandler);
app.put('/api/verticals/:key/state', saveStateHandler);

// ── Save projects for a vertical (POST + PUT for compatibility) ──
app.post('/api/verticals/:key/projects', saveProjectsHandler);
app.put('/api/verticals/:key/projects', saveProjectsHandler);

function saveProjectsHandler(req, res) {
  const { projects } = req.body;
  if (!Array.isArray(projects)) {
    return res.status(400).json({ error: 'Projects must be an array' });
  }

  const VALID_SIZES = new Set(['', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']);

  // Sanitize all project string fields
  for (let i = 0; i < projects.length; i++) {
    projects[i] = sanitizeProject(projects[i]);
  }

  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    if (p.id == null) {
      return res.status(400).json({ error: `Project at index ${i} missing required field (id)` });
    }
    if (p.impact && !VALID_SIZES.has(p.impact)) {
      return res.status(400).json({ error: `Project ${p.id}: invalid impact "${p.impact}"` });
    }
    for (const f of ['backend', 'frontend', 'natives']) {
      if (p[f] && !VALID_SIZES.has(p[f])) {
        return res.status(400).json({ error: `Project ${p.id}: invalid ${f} size "${p[f]}"` });
      }
    }
    // Validate status field if present
    const VALID_STATUSES = new Set(['not_started', 'in_progress', 'paused']);
    if (p.status && !VALID_STATUSES.has(p.status)) {
      return res.status(400).json({ error: `Project ${p.id}: invalid status "${p.status}"` });
    }
    // Validate percentComplete if present
    if (p.percentComplete != null) {
      const pct = Number(p.percentComplete);
      if (isNaN(pct) || pct < 0 || pct > 100) {
        return res.status(400).json({ error: `Project ${p.id}: percentComplete must be 0-100` });
      }
      p.percentComplete = pct;
    }
    // Validate sprintOverrides if present
    if (p.sprintOverrides != null) {
      if (typeof p.sprintOverrides !== 'object' || Array.isArray(p.sprintOverrides)) {
        return res.status(400).json({ error: `Project ${p.id}: sprintOverrides must be an object` });
      }
      const validDisciplines = new Set(['backend', 'frontend', 'natives']);
      for (const [key, val] of Object.entries(p.sprintOverrides)) {
        if (!validDisciplines.has(key)) {
          return res.status(400).json({ error: `Project ${p.id}: invalid sprintOverrides key "${key}"` });
        }
        if (typeof val !== 'number' || isNaN(val) || val < 0) {
          return res.status(400).json({ error: `Project ${p.id}: sprintOverrides.${key} must be a non-negative number` });
        }
      }
    }
  }

  try {
    saveJSON(getProjectsFile(req.params.key), projects);

    // Clean up tracks: remove IDs that no longer exist
    const validIds = new Set(projects.map(p => p.id));
    const existingState = loadJSON(getStateFile(req.params.key), {
      capacity: { ...DEFAULT_CAPACITY },
      tracks: { ...DEFAULT_TRACKS },
    });
    const cleanedTracks = {};
    for (const [tk, ids] of Object.entries(existingState.tracks || {})) {
      cleanedTracks[tk] = (ids || []).filter(id => validIds.has(id));
    }
    saveJSON(getStateFile(req.params.key), {
      ...existingState,
      tracks: cleanedTracks,
      updatedAt: new Date().toISOString(),
    });

    logAudit(req, 'Updated projects', `Saved ${projects.length} projects`);
    res.json({ success: true, projectCount: projects.length });

    // Broadcast to WebSocket clients
    const senderId = req.headers['x-ws-id'] || '';
    broadcastUpdate(req.params.key, new Date().toISOString(), senderId);
  } catch (err) {
    console.error('Save projects error:', err);
    res.status(500).json({ error: 'Failed to save projects' });
  }
}

// ── Snapshot endpoints ──
function getSnapshotsFile(key) { return `snapshots_${key}.json`; }

// List snapshots for a vertical
app.get('/api/verticals/:key/snapshots', (req, res) => {
  if (!isValidVertical(req.params.key)) return res.status(400).json({ error: 'Invalid vertical' });
  const snapshots = loadJSON(getSnapshotsFile(req.params.key), []);
  // Return metadata only (no full state/projects to keep response light)
  const meta = snapshots.map(s => ({
    id: s.id, name: s.name, description: s.description || '',
    createdAt: s.createdAt, createdBy: s.createdBy,
    projectCount: (s.projects || []).length,
  }));
  res.json({ snapshots: meta });
});

// Save a new snapshot
app.post('/api/verticals/:key/snapshots', (req, res) => {
  try {
    const sanitizedName = sanitizeString(req.body.name, 100);
    const sanitizedDesc = sanitizeString(req.body.description || '', 500);
    if (!sanitizedName || typeof sanitizedName !== 'string' || !sanitizedName.trim()) {
      return res.status(400).json({ error: 'Snapshot name is required' });
    }
    const key = req.params.key;
    const snapshots = loadJSON(getSnapshotsFile(key), []);

    // Source: another snapshot or current Masterplan
    let sourceState, sourceProjects;
    if (req.body.sourceSnapshotId) {
      const src = snapshots.find(s => s.id === req.body.sourceSnapshotId);
      if (!src) return res.status(404).json({ error: 'Source snapshot not found' });
      sourceState = src.state;
      sourceProjects = src.projects;
    } else {
      sourceState = loadJSON(getStateFile(key), {});
      sourceProjects = loadJSON(getProjectsFile(key), []);
    }

    const snapshot = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: sanitizedName.trim(),
      description: sanitizedDesc.trim(),
      createdAt: new Date().toISOString(),
      createdBy: req.auth.email || 'unknown',
      state: JSON.parse(JSON.stringify(sourceState)),
      projects: JSON.parse(JSON.stringify(sourceProjects)),
    };

    snapshots.unshift(snapshot); // newest first
    saveJSON(getSnapshotsFile(key), snapshots);
    logAudit(req, 'Saved snapshot', `Snapshot "${snapshot.name}" saved (${sourceProjects.length} projects)`);

    res.json({ success: true, snapshot: { id: snapshot.id, name: snapshot.name, createdAt: snapshot.createdAt } });
  } catch (err) {
    console.error('Save snapshot error:', err);
    res.status(500).json({ error: 'Failed to save snapshot' });
  }
});

// Restore a snapshot
app.post('/api/verticals/:key/snapshots/:id/restore', (req, res) => {
  try {
    const key = req.params.key;
    const snapshots = loadJSON(getSnapshotsFile(key), []);
    const snapshot = snapshots.find(s => s.id === req.params.id);
    if (!snapshot) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }

    // Overwrite current state and projects
    saveJSON(getStateFile(key), JSON.parse(JSON.stringify(snapshot.state)));
    saveJSON(getProjectsFile(key), JSON.parse(JSON.stringify(snapshot.projects)));

    logAudit(req, 'Restored snapshot', `Restored snapshot "${snapshot.name}" (${(snapshot.projects || []).length} projects)`);

    // Broadcast update to WebSocket clients
    const senderId = req.headers['x-ws-id'] || '';
    broadcastUpdate(key, new Date().toISOString(), senderId);

    res.json({ success: true, state: snapshot.state, projects: snapshot.projects });
  } catch (err) {
    console.error('Restore snapshot error:', err);
    res.status(500).json({ error: 'Failed to restore snapshot' });
  }
});

// Delete a snapshot
app.delete('/api/verticals/:key/snapshots/:id', (req, res) => {
  try {
    const key = req.params.key;
    const snapshots = loadJSON(getSnapshotsFile(key), []);
    const idx = snapshots.findIndex(s => s.id === req.params.id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }
    const removed = snapshots.splice(idx, 1)[0];
    saveJSON(getSnapshotsFile(key), snapshots);
    logAudit(req, 'Deleted snapshot', `Deleted snapshot "${removed.name}"`);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete snapshot error:', err);
    res.status(500).json({ error: 'Failed to delete snapshot' });
  }
});

// ── Snapshot workspace endpoints ──

// Get full snapshot (state + projects) for workspace loading
app.get('/api/verticals/:key/snapshots/:id', (req, res) => {
  if (!isValidVertical(req.params.key)) return res.status(400).json({ error: 'Invalid vertical' });
  const snapshots = loadJSON(getSnapshotsFile(req.params.key), []);
  const snapshot = snapshots.find(s => s.id === req.params.id);
  if (!snapshot) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }
  res.json({ id: snapshot.id, name: snapshot.name, state: snapshot.state, projects: snapshot.projects });
});

// Update snapshot state+projects (full overwrite — per-user workspace, no conflict resolution)
app.put('/api/verticals/:key/snapshots/:id', (req, res) => {
  try {
    const key = req.params.key;
    const snapshots = loadJSON(getSnapshotsFile(key), []);
    const idx = snapshots.findIndex(s => s.id === req.params.id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }
    if (req.body.state) snapshots[idx].state = req.body.state;
    if (req.body.projects) snapshots[idx].projects = req.body.projects;
    snapshots[idx].updatedAt = new Date().toISOString();
    saveJSON(getSnapshotsFile(key), snapshots);
    res.json({ success: true });
  } catch (err) {
    console.error('Update snapshot error:', err);
    res.status(500).json({ error: 'Failed to update snapshot' });
  }
});

// Promote snapshot → overwrite Masterplan
app.post('/api/verticals/:key/snapshots/:id/promote', (req, res) => {
  try {
    const key = req.params.key;
    const snapshots = loadJSON(getSnapshotsFile(key), []);
    const snapshot = snapshots.find(s => s.id === req.params.id);
    if (!snapshot) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }
    const state = { ...JSON.parse(JSON.stringify(snapshot.state)), updatedAt: new Date().toISOString() };
    const projects = JSON.parse(JSON.stringify(snapshot.projects));
    saveJSON(getStateFile(key), state);
    saveJSON(getProjectsFile(key), projects);
    logAudit(req, 'Promoted snapshot', `Promoted snapshot "${snapshot.name}" to Masterplan (${projects.length} projects)`);

    // Broadcast to WS clients so Masterplan users see the update
    const senderId = req.headers['x-ws-id'] || '';
    broadcastUpdate(key, state.updatedAt, senderId);

    state._loadedAt = Date.now();
    res.json({ success: true, state, projects });
  } catch (err) {
    console.error('Promote snapshot error:', err);
    res.status(500).json({ error: 'Failed to promote snapshot' });
  }
});

// ── Audit log endpoint ──
app.get('/api/audit-log', (req, res) => {
  let log = loadJSON(AUDIT_FILE, []);
  const { user, vertical, days } = req.query;
  if (user) log = log.filter(e => e.userEmail.toLowerCase().includes(user.toLowerCase()) || e.userName.toLowerCase().includes(user.toLowerCase()));
  if (vertical) log = log.filter(e => e.vertical === vertical);
  if (days) {
    const cutoff = Date.now() - parseInt(days) * 24 * 60 * 60 * 1000;
    log = log.filter(e => new Date(e.timestamp).getTime() > cutoff);
  }
  res.json({ entries: log.slice(0, 500), total: log.length });
});

// ── Editors management ──
app.get('/api/editors', (req, res) => {
  const editors = loadEditors();
  const requests = loadJSON(ACCESS_REQUESTS_FILE, []);
  res.json({ editors, admin: ADMIN_EMAIL, requests });
});

app.post('/api/editors', (req, res) => {
  const email = req.auth.email;
  if (email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Only admin can manage editors' });
  }
  const { editors } = req.body;
  if (!Array.isArray(editors)) {
    return res.status(400).json({ error: 'Editors must be an array' });
  }
  // Deduplicate by email, validate
  const seen = new Set();
  const cleaned = [];
  for (const entry of editors) {
    const norm = normalizeEditor(entry);
    if (!norm.email || !norm.email.endsWith('@novibet.com') || norm.email === ADMIN_EMAIL) continue;
    if (seen.has(norm.email)) continue;
    seen.add(norm.email);
    const verticals = (norm.verticals || []).filter(v => v === 'all' || isValidVertical(v));
    cleaned.push({ email: norm.email, verticals: verticals.length ? verticals : ['all'] });
  }
  saveJSON(EDITORS_FILE, cleaned);
  logAudit(req, 'Updated editors', `Editor list updated: ${cleaned.length} editors`);
  res.json({ success: true, editors: cleaned });
});

// Request editor access (exempt from auth middleware — viewers need this)
app.post('/api/editors/request', (req, res) => {
  const email = req.auth.email;
  const name = req.auth.name || '';
  if (!email || !email.endsWith('@novibet.com')) {
    return res.status(400).json({ error: 'Valid @novibet.com email required' });
  }
  if (isEditorUser(email)) {
    return res.status(400).json({ error: 'Already an editor' });
  }
  const requests = loadJSON(ACCESS_REQUESTS_FILE, []);
  if (requests.some(r => r.email.toLowerCase() === email)) {
    return res.status(400).json({ error: 'Request already pending' });
  }
  requests.push({ email, name, requestedAt: new Date().toISOString() });
  saveJSON(ACCESS_REQUESTS_FILE, requests);
  logAudit(req, 'Requested editor access', `${email} requested editor access`);
  res.json({ success: true });
});

// Dismiss a pending access request (admin-only, passes through auth middleware)
app.delete('/api/editors/request', (req, res) => {
  const adminEmail = req.auth.email;
  if (adminEmail !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Only admin can manage requests' });
  }
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }
  const requests = loadJSON(ACCESS_REQUESTS_FILE, []);
  const filtered = requests.filter(r => r.email.toLowerCase() !== email.toLowerCase());
  saveJSON(ACCESS_REQUESTS_FILE, filtered);
  res.json({ success: true, requests: filtered });
});

// ── Custom Verticals Management ──

app.post('/api/custom-verticals', (req, res) => {
  const email = req.auth.email;
  if (email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Only admin can create custom verticals' });
  }

  const { key, label, color, icon, adminOnly } = req.body;
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: 'Key is required' });
  }
  const normalizedKey = key.toLowerCase().trim();
  if (!/^[a-z][a-z0-9-]{1,29}$/.test(normalizedKey)) {
    return res.status(400).json({ error: 'Key must be 2-30 chars, lowercase alphanumeric + hyphens, start with a letter' });
  }
  if (BUILTIN_VERTICALS.some(v => v.key === normalizedKey)) {
    return res.status(400).json({ error: 'Key conflicts with a built-in vertical' });
  }
  const customs = loadCustomVerticals();
  if (customs.some(v => v.key === normalizedKey)) {
    return res.status(400).json({ error: 'A custom vertical with this key already exists' });
  }
  if (!label || typeof label !== 'string' || !label.trim()) {
    return res.status(400).json({ error: 'Label is required' });
  }
  const sanitizedColor = sanitizeString(color || '#636e72', 7);
  if (!/^#[0-9a-fA-F]{6}$/.test(sanitizedColor)) {
    return res.status(400).json({ error: 'Color must be a valid hex color (e.g., #6c5ce7)' });
  }

  const newVertical = {
    key: normalizedKey,
    label: sanitizeString(label.trim(), 50),
    color: sanitizedColor,
    icon: sanitizeString(icon || '', 4) || '\u{1F4CB}',
    builtIn: false,
    adminOnly: !!adminOnly,
    createdAt: new Date().toISOString(),
    createdBy: email,
  };
  customs.push(newVertical);
  saveJSON(CUSTOM_VERTICALS_FILE, customs);
  logAudit(req, 'Created custom vertical', `Created vertical "${newVertical.label}" (key: ${newVertical.key}, adminOnly: ${newVertical.adminOnly})`);
  res.json({ success: true, vertical: newVertical });
});

app.delete('/api/custom-verticals/:key', (req, res) => {
  const email = req.auth.email;
  if (email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Only admin can delete custom verticals' });
  }
  const key = req.params.key;
  if (BUILTIN_VERTICALS.some(v => v.key === key)) {
    return res.status(400).json({ error: 'Cannot delete built-in verticals' });
  }
  const customs = loadCustomVerticals();
  const idx = customs.findIndex(v => v.key === key);
  if (idx === -1) {
    return res.status(404).json({ error: 'Custom vertical not found' });
  }
  const removed = customs.splice(idx, 1)[0];
  saveJSON(CUSTOM_VERTICALS_FILE, customs);
  const filesToClean = [
    getProjectsFile(key), getStateFile(key),
    getSnapshotsFile(key), getCommentsFile(key)
  ];
  for (const f of filesToClean) {
    try {
      const fp = path.join(DATA_DIR, f);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (e) { console.error(`Error cleaning up ${f}:`, e.message); }
  }
  logAudit(req, 'Deleted custom vertical', `Deleted vertical "${removed.label}" (key: ${key})`);
  res.json({ success: true });
});

// ── Personal Notes (admin-only) ──

function getNotesFile(email) {
  const safe = email.replace(/[^a-zA-Z0-9]/g, '_');
  return `notes_${safe}.json`;
}

app.get('/api/notes', (req, res) => {
  if (req.auth.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Admin only' });
  let notes = loadJSON(getNotesFile(req.auth.email), []);
  // Optional filters
  if (req.query.projectId) notes = notes.filter(n => String(n.projectId) === String(req.query.projectId));
  if (req.query.vertical) notes = notes.filter(n => n.vertical === req.query.vertical);
  notes.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  res.json({ notes });
});

app.post('/api/notes', (req, res) => {
  if (req.auth.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Admin only' });
  const title = sanitizeString(req.body.title || '', 200);
  const content = sanitizeNoteHtml(req.body.content || '', 10000);
  if (!title && (!content || content === '<p><br></p>')) {
    return res.status(400).json({ error: 'Note must have a title or content' });
  }
  const notes = loadJSON(getNotesFile(req.auth.email), []);
  const note = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title, content,
    vertical: req.body.vertical ? sanitizeString(req.body.vertical, 50) : undefined,
    projectId: req.body.projectId != null ? Number(req.body.projectId) : undefined,
    projectName: req.body.projectName ? sanitizeString(req.body.projectName, 300) : undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // Clean undefined fields
  Object.keys(note).forEach(k => note[k] === undefined && delete note[k]);
  notes.push(note);
  saveJSON(getNotesFile(req.auth.email), notes);
  res.json({ note });
});

app.put('/api/notes/:id', (req, res) => {
  if (req.auth.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Admin only' });
  const notes = loadJSON(getNotesFile(req.auth.email), []);
  const note = notes.find(n => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  if (req.body.title !== undefined) note.title = sanitizeString(req.body.title || '', 200);
  if (req.body.content !== undefined) note.content = sanitizeNoteHtml(req.body.content || '', 10000);
  if (req.body.vertical !== undefined) note.vertical = req.body.vertical ? sanitizeString(req.body.vertical, 50) : undefined;
  if (req.body.projectId !== undefined) note.projectId = req.body.projectId != null ? Number(req.body.projectId) : undefined;
  if (req.body.projectName !== undefined) note.projectName = req.body.projectName ? sanitizeString(req.body.projectName, 300) : undefined;
  Object.keys(note).forEach(k => note[k] === undefined && delete note[k]);
  note.updatedAt = new Date().toISOString();
  saveJSON(getNotesFile(req.auth.email), notes);
  res.json({ note });
});

app.delete('/api/notes/:id', (req, res) => {
  if (req.auth.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Admin only' });
  const notes = loadJSON(getNotesFile(req.auth.email), []);
  const idx = notes.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Note not found' });
  notes.splice(idx, 1);
  saveJSON(getNotesFile(req.auth.email), notes);
  res.json({ ok: true });
});

// ── Comments ──

// Get all comments for a project
app.get('/api/verticals/:key/projects/:projectId/comments', (req, res) => {
  const { key, projectId } = req.params;
  if (!isValidVertical(key)) return res.status(400).json({ error: 'Invalid vertical' });
  const data = loadJSON(getCommentsFile(key), { projectComments: {} });
  const comments = (data.projectComments[projectId] && data.projectComments[projectId].comments) || [];
  res.json({ comments });
});

// Add a new top-level comment
app.post('/api/verticals/:key/projects/:projectId/comments', (req, res) => {
  const { key, projectId } = req.params;
  if (!isValidVertical(key)) return res.status(400).json({ error: 'Invalid vertical' });
  const text = sanitizeString(req.body.text || '', 2000);
  if (!text || !text.trim()) return res.status(400).json({ error: 'Comment text is required' });

  const data = loadJSON(getCommentsFile(key), { projectComments: {} });
  if (!data.projectComments[projectId]) {
    data.projectComments[projectId] = { comments: [] };
  }

  const comment = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: text.trim(),
    authorEmail: req.auth.email || 'unknown',
    authorName: req.auth.name || 'Unknown',
    authorPicture: req.auth.picture || '',
    createdAt: new Date().toISOString(),
    editedAt: null,
    replies: [],
  };

  data.projectComments[projectId].comments.push(comment);
  saveJSON(getCommentsFile(key), data);
  logAudit(req, 'Added comment', `Comment on project #${projectId}`);
  res.json({ success: true, comment });
});

// Add a reply to an existing comment
app.post('/api/verticals/:key/projects/:projectId/comments/:commentId/replies', (req, res) => {
  const { key, projectId, commentId } = req.params;
  if (!isValidVertical(key)) return res.status(400).json({ error: 'Invalid vertical' });
  const text = sanitizeString(req.body.text || '', 2000);
  if (!text || !text.trim()) return res.status(400).json({ error: 'Reply text is required' });

  const data = loadJSON(getCommentsFile(key), { projectComments: {} });
  const projectData = data.projectComments[projectId];
  if (!projectData) return res.status(404).json({ error: 'No comments for this project' });

  const comment = projectData.comments.find(c => c.id === commentId);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });

  const reply = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: text.trim(),
    authorEmail: req.auth.email || 'unknown',
    authorName: req.auth.name || 'Unknown',
    authorPicture: req.auth.picture || '',
    createdAt: new Date().toISOString(),
    editedAt: null,
  };

  comment.replies.push(reply);
  saveJSON(getCommentsFile(key), data);
  logAudit(req, 'Added reply', `Reply on project #${projectId}, comment ${commentId}`);
  res.json({ success: true, reply });
});

// Delete a comment (author or admin only)
app.delete('/api/verticals/:key/projects/:projectId/comments/:commentId', (req, res) => {
  const { key, projectId, commentId } = req.params;
  if (!isValidVertical(key)) return res.status(400).json({ error: 'Invalid vertical' });

  const data = loadJSON(getCommentsFile(key), { projectComments: {} });
  const projectData = data.projectComments[projectId];
  if (!projectData) return res.status(404).json({ error: 'No comments for this project' });

  const idx = projectData.comments.findIndex(c => c.id === commentId);
  if (idx === -1) return res.status(404).json({ error: 'Comment not found' });

  const comment = projectData.comments[idx];
  const userEmail = req.auth.email;
  if (userEmail !== comment.authorEmail.toLowerCase() && userEmail !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Only the author or admin can delete this comment' });
  }

  projectData.comments.splice(idx, 1);
  // Clean up empty project entries
  if (projectData.comments.length === 0) {
    delete data.projectComments[projectId];
  }
  saveJSON(getCommentsFile(key), data);
  logAudit(req, 'Deleted comment', `Deleted comment on project #${projectId}`);
  res.json({ success: true });
});

// Get comment counts for all projects in a vertical (for badges)
app.get('/api/verticals/:key/comments/counts', (req, res) => {
  const { key } = req.params;
  if (!isValidVertical(key)) return res.status(400).json({ error: 'Invalid vertical' });
  const data = loadJSON(getCommentsFile(key), { projectComments: {} });
  const counts = {};
  for (const [pid, pData] of Object.entries(data.projectComments)) {
    const total = (pData.comments || []).reduce((sum, c) => sum + 1 + (c.replies || []).length, 0);
    if (total > 0) counts[pid] = total;
  }
  res.json({ counts });
});

// ── Alerts ──

// Get alert counts for a vertical (for badges) — must be before /:alertId routes
app.get('/api/verticals/:key/alerts/counts', (req, res) => {
  const { key } = req.params;
  if (!isValidVertical(key)) return res.status(400).json({ error: 'Invalid vertical' });
  const data = loadJSON(getAlertsFile(key), { alerts: [] });
  const counts = { total: 0, critical: 0, warning: 0, info: 0, promoted: 0, byProject: {} };
  (data.alerts || []).forEach(a => {
    counts.total++;
    counts[a.level]++;
    if (a.promoted) counts.promoted++;
    if (a.projectId != null) {
      const pid = String(a.projectId);
      counts.byProject[pid] = (counts.byProject[pid] || 0) + 1;
    }
  });
  res.json({ counts });
});

// Get all alerts for a vertical (optional ?projectId=X filter)
app.get('/api/verticals/:key/alerts', (req, res) => {
  const { key } = req.params;
  if (!isValidVertical(key)) return res.status(400).json({ error: 'Invalid vertical' });
  const data = loadJSON(getAlertsFile(key), { alerts: [] });
  let alerts = data.alerts || [];
  if (req.query.projectId !== undefined) {
    const pid = String(req.query.projectId);
    alerts = alerts.filter(a => String(a.projectId) === pid);
  }
  if (req.query.level) {
    const levels = req.query.level.split(',');
    alerts = alerts.filter(a => levels.includes(a.level));
  }
  res.json({ alerts });
});

// Create a new alert
app.post('/api/verticals/:key/alerts', (req, res) => {
  const { key } = req.params;
  if (!isValidVertical(key)) return res.status(400).json({ error: 'Invalid vertical' });
  const text = sanitizeString(req.body.text || '', 500);
  if (!text || !text.trim()) return res.status(400).json({ error: 'Alert text is required' });
  const level = req.body.level;
  if (!['critical', 'warning', 'info'].includes(level)) {
    return res.status(400).json({ error: 'Level must be critical, warning, or info' });
  }
  const data = loadJSON(getAlertsFile(key), { alerts: [] });
  if (!Array.isArray(data.alerts)) data.alerts = [];
  const alert = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: text.trim(),
    level,
    projectId: req.body.projectId != null ? req.body.projectId : null,
    promoted: !!req.body.promoted,
    authorEmail: req.auth.email || 'unknown',
    authorName: req.auth.name || 'Unknown',
    authorPicture: req.auth.picture || '',
    createdAt: new Date().toISOString(),
  };
  data.alerts.push(alert);
  saveJSON(getAlertsFile(key), data);
  logAudit(req, 'Created alert', `[${level}] ${text.slice(0, 80)}${req.body.projectId != null ? ` on project #${req.body.projectId}` : ''}`);
  res.json({ success: true, alert });
});

// Edit an alert (any editor for this vertical)
app.put('/api/verticals/:key/alerts/:alertId', (req, res) => {
  const { key, alertId } = req.params;
  if (!isValidVertical(key)) return res.status(400).json({ error: 'Invalid vertical' });
  const data = loadJSON(getAlertsFile(key), { alerts: [] });
  if (!Array.isArray(data.alerts)) data.alerts = [];
  const alert = data.alerts.find(a => a.id === alertId);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  const userEmail = req.auth.email;
  if (!isEditorForVertical(userEmail, key)) {
    return res.status(403).json({ error: 'Editor access required to edit alerts' });
  }
  if (req.body.text !== undefined) {
    const text = sanitizeString(req.body.text || '', 500);
    if (!text || !text.trim()) return res.status(400).json({ error: 'Alert text is required' });
    alert.text = text.trim();
  }
  if (req.body.level !== undefined) {
    if (!['critical', 'warning', 'info'].includes(req.body.level)) {
      return res.status(400).json({ error: 'Level must be critical, warning, or info' });
    }
    alert.level = req.body.level;
  }
  if (req.body.promoted !== undefined) {
    alert.promoted = !!req.body.promoted;
  }
  alert.editedAt = new Date().toISOString();
  saveJSON(getAlertsFile(key), data);
  logAudit(req, 'Edited alert', `Edited [${alert.level}] alert in ${key}`);
  res.json({ success: true, alert });
});

// Delete an alert (any editor for this vertical)
app.delete('/api/verticals/:key/alerts/:alertId', (req, res) => {
  const { key, alertId } = req.params;
  if (!isValidVertical(key)) return res.status(400).json({ error: 'Invalid vertical' });
  const data = loadJSON(getAlertsFile(key), { alerts: [] });
  if (!Array.isArray(data.alerts)) data.alerts = [];
  const idx = data.alerts.findIndex(a => a.id === alertId);
  if (idx === -1) return res.status(404).json({ error: 'Alert not found' });
  const alert = data.alerts[idx];
  const userEmail = req.auth.email;
  if (!isEditorForVertical(userEmail, key)) {
    return res.status(403).json({ error: 'Editor access required to delete alerts' });
  }
  data.alerts.splice(idx, 1);
  saveJSON(getAlertsFile(key), data);
  logAudit(req, 'Deleted alert', `Deleted [${alert.level}] alert in ${key}`);
  res.json({ success: true });
});

// ── Catch-all 404 (debug) ──
app.use((req, res) => {
  console.log(`!! 404: ${req.method} ${req.url}`);
  res.status(404).json({ error: 'Route not found', method: req.method, url: req.url });
});

// ── HTTP + WebSocket Server ──
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Track connected clients by vertical
// Map<string, Set<WebSocket>>
const verticalClients = new Map();

wss.on('connection', (ws) => {
  let subscribedVertical = null;
  ws.authEmail = null;

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'subscribe' && msg.vertical) {
        // Validate vertical key before allowing subscription
        if (!isValidVertical(msg.vertical)) return;

        // Verify JWT if provided
        if (msg.token) {
          const payload = await verifyGoogleToken(msg.token);
          if (payload) {
            ws.authEmail = payload.email.toLowerCase();
          }
        }

        // Log if subscription lacks auth (for monitoring, not blocking)
        if (!ws.authEmail) {
          console.warn('[ws] Unauthenticated subscription to', msg.vertical);
        }

        // Unsubscribe from previous
        if (subscribedVertical && verticalClients.has(subscribedVertical)) {
          verticalClients.get(subscribedVertical).delete(ws);
        }
        subscribedVertical = msg.vertical;
        if (!verticalClients.has(subscribedVertical)) {
          verticalClients.set(subscribedVertical, new Set());
        }
        verticalClients.get(subscribedVertical).add(ws);
        console.log(`[ws] Client subscribed to ${subscribedVertical} (${verticalClients.get(subscribedVertical).size} clients)${ws.authEmail ? ` [${ws.authEmail}]` : ''}`);
      }
    } catch (e) {
      // ignore invalid messages
    }
  });

  ws.on('close', () => {
    if (subscribedVertical && verticalClients.has(subscribedVertical)) {
      verticalClients.get(subscribedVertical).delete(ws);
    }
  });

  // Send a welcome ping so client knows connection is alive
  ws.send(JSON.stringify({ type: 'connected' }));
});

// Broadcast FULL state + projects to all clients watching a vertical.
// Sending data inline eliminates the need for clients to HTTP-fetch after
// receiving a WS notification — this fixes background-tab sync where
// Chrome may throttle/delay follow-up HTTP requests.
function broadcastUpdate(vertical, updatedAt, senderId) {
  const clients = verticalClients.get(vertical);
  if (!clients || clients.size === 0) return;

  // Load the actual data to include in the broadcast
  const state = loadJSON(getStateFile(vertical), {});
  state._loadedAt = Date.now();
  delete state._fieldTs; // internal — don't leak to clients

  const projects = loadJSON(getProjectsFile(vertical), []);

  const msg = JSON.stringify({
    type: 'update',
    vertical,
    updatedAt,
    senderId,
    state,
    projects,
  });
  let sent = 0;
  for (const ws of clients) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(msg);
      sent++;
    }
  }
  if (sent > 0) console.log(`[ws] Broadcast full state for ${vertical} to ${sent} clients (${(msg.length/1024).toFixed(1)}KB)`);
}

// ── Keepalive ping — prevents Railway/proxy from closing idle WS connections ──
const keepaliveInterval = setInterval(() => {
  const now = Date.now();
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'ping', t: now }));
    }
  });
}, 25000);

// ── Start (only when run directly, not when imported for tests) ──
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Blueprint API running on 0.0.0.0:${PORT}`);
    console.log(`CORS origin: ${CORS_ORIGIN}`);
    console.log(`Data dir: ${DATA_DIR}`);
    try {
      const testFile = path.join(DATA_DIR, '.write-test');
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
      console.log(`Data dir is writable ✓`);
      const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
      console.log(`Existing data files: ${files.length > 0 ? files.join(', ') : '(none)'}`);
    } catch (e) {
      console.error(`WARNING: Data dir is NOT writable: ${e.message}`);
    }
  });
}

// ── Exports for testing ──
module.exports = {
  app,
  server,
  wss,
  loadJSON,
  saveJSON,
  logAudit,
  describeStateChanges,
  buildNarratives,
  findMovedItem,
  summarizeValue,
  broadcastUpdate,
  getProjectsFile,
  getStateFile,
  DATA_DIR,
  STATE_FIELDS,
  DEFAULT_CAPACITY,
  DEFAULT_TRACKS,
  AUDIT_FILE,
  AUDIT_MAX_DAYS,
  verticalClients,
  keepaliveInterval,
  rateLimitCleanup,
  getSnapshotsFile,
  getCommentsFile,
  getAlertsFile,
  stripHtmlTags,
  sanitizeString,
  sanitizeProject,
  sanitizeMilestones,
  EDITORS_FILE,
  ACCESS_REQUESTS_FILE,
  ADMIN_EMAIL,
  isEditorUser,
  isEditorForVertical,
  normalizeEditor,
  loadEditors,
  BUILTIN_VERTICALS,
  CUSTOM_VERTICALS_FILE,
  loadCustomVerticals,
  getAllVerticals,
  isValidVertical,
  verifyGoogleToken,
  tokenCache,
  tokenCacheCleanup,
  GOOGLE_CLIENT_ID,
};
