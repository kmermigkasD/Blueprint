// ══════════════════════════════════════════════════════════
// Blueprint — Shared Pure Computation Functions
// Used by both frontend (index.html via <script>) and tests (require)
// ══════════════════════════════════════════════════════════

var CP = (function() {

const DEFAULT_SIZE_MAP = { XS: 0.5, S: 1, M: 2, L: 3, XL: 5, XXL: 8, XXXL: 13 };
const TRACK_KEYS = ['core-bonus', 'gateway', 'seo-aff'];
const DEFAULT_TRACK_CONFIG = [
  { key: 'core-bonus', label: 'Core Bonus', color: '#636e72' },
  { key: 'gateway', label: 'Gateway', color: '#636e72' },
  { key: 'seo-aff', label: 'SEO & AFF', color: '#636e72' },
];
const DISCIPLINES = ['backend', 'frontend', 'natives'];
const ZERO_DISC = () => ({ backend: 0, frontend: 0, natives: 0 });
const IMPACT_ORDER = { XXXL: 7, XXL: 6, XL: 5, L: 4, M: 3, S: 2, XS: 1 };
const PILLAR_PALETTE = [
  '#0984e3', '#6c5ce7', '#e67e22', '#e74c3c',
  '#1abc9c', '#9b59b6', '#2ecc71', '#f39c12', '#3498db',
  '#d35400', '#8e44ad', '#16a085', '#c0392b',
];

function buildPillarColorMap(projects) {
  const names = [...new Set(projects.map(function(p) { return p.pillar; }).filter(Boolean))].sort();
  var map = {};
  for (var i = 0; i < names.length; i++) {
    map[names[i]] = PILLAR_PALETTE[i % PILLAR_PALETTE.length];
  }
  return map;
}

function generateTrackKey(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ── Size & Sprint Conversions ──

function sizeToSprints(size, sizeMap) {
  if (!size || size === 'nan' || size === '' || size === 'NaN') return 0;
  const map = sizeMap || DEFAULT_SIZE_MAP;
  return map[size] || 0;
}

function computeProjectSprints(project, sizeMap) {
  const ov = project.sprintOverrides || {};
  const b = ov.backend != null ? ov.backend : sizeToSprints(project.backend, sizeMap);
  const f = ov.frontend != null ? ov.frontend : sizeToSprints(project.frontend, sizeMap);
  const n = ov.natives != null ? ov.natives : sizeToSprints(project.natives, sizeMap);
  return { backend: b, frontend: f, natives: n, total: b + f + n };
}

// ── Effective Sprints (after splits) ──

function computeEffectiveSprints(project, splits, sizeMap) {
  const full = computeProjectSprints(project, sizeMap);
  const projectSplits = splits && splits[project.id];
  if (!projectSplits || typeof projectSplits !== 'object') return full;
  const sub = ZERO_DISC();
  for (const sizing of Object.values(projectSplits)) {
    if (sizing && typeof sizing === 'object') {
      for (const d of DISCIPLINES) sub[d] += (sizing[d] || 0);
    }
  }
  return {
    backend: Math.max(0, full.backend - sub.backend),
    frontend: Math.max(0, full.frontend - sub.frontend),
    natives: Math.max(0, full.natives - sub.natives),
    total: Math.max(0, full.total - sub.backend - sub.frontend - sub.natives),
  };
}

// ── Migration ──

function migrateTracks(tracks, trackConfig) {
  const result = { ...tracks };
  // Legacy gamification -> gateway rename
  if ('gamification' in result && !('gateway' in result)) {
    result['gateway'] = result['gamification'];
    delete result['gamification'];
  }
  // Ensure all configured track keys exist
  const keys = trackConfig ? trackConfig.map(function(t) { return t.key; }) : TRACK_KEYS;
  for (var i = 0; i < keys.length; i++) {
    if (!result[keys[i]]) result[keys[i]] = [];
  }
  return result;
}

function migrateTrackCapacity(tc, trackConfig) {
  const result = tc ? JSON.parse(JSON.stringify(tc)) : {};
  const ZERO = ZERO_DISC();
  const keys = trackConfig ? trackConfig.map(function(t) { return t.key; }) : TRACK_KEYS;
  for (var i = 0; i < keys.length; i++) {
    if (!result[keys[i]]) result[keys[i]] = { ...ZERO };
  }
  return result;
}

var OLD_TRACK_COLORS = { '#fdcb6e': '#636e72', '#e84393': '#636e72', '#00b894': '#636e72' };
function migrateTrackConfigColors(trackConfig) {
  if (!trackConfig) return trackConfig;
  return trackConfig.map(function(t) {
    return OLD_TRACK_COLORS[t.color] ? { key: t.key, label: t.label, color: OLD_TRACK_COLORS[t.color] } : t;
  });
}

// ── Track Helpers ──

function removeFromTracks(tracks, id) {
  const n = {};
  for (const k of Object.keys(tracks)) n[k] = tracks[k].filter(x => x !== id);
  return n;
}

// ── Deep Merge (client-side conflict resolution) ──

function deepMergeObject(localValue, latestServer, capturedServer) {
  // Only deep-merge plain objects (not arrays, not primitives)
  if (typeof localValue !== 'object' || localValue === null || Array.isArray(localValue)) return localValue;
  if (!latestServer) return localValue;
  const captured = capturedServer || latestServer;
  // Start from USER's version (respects deletions), then incorporate
  // server-side changes the user didn't touch.
  const merged = { ...localValue };
  const overlaid = [];
  const deleted = [];
  for (const subKey of Object.keys(latestServer)) {
    if (!(subKey in captured)) {
      // Key is NEW on the server (added after client loaded) — include it
      merged[subKey] = latestServer[subKey];
      overlaid.push('+' + subKey);
    } else if (subKey in localValue) {
      // Key exists in both — if user didn't change it, use server's latest
      if (JSON.stringify(localValue[subKey]) === JSON.stringify(captured[subKey])) {
        merged[subKey] = latestServer[subKey];
      }
      // else: user changed it — keep their version (already in merged)
    }
    // If key is in latestServer + captured but NOT in localValue:
    // user DELETED it — don't add it back (respects deletion)
  }
  for (const subKey of Object.keys(captured)) {
    if (!(subKey in localValue)) deleted.push(subKey);
  }
  return { merged, overlaid, deleted };
}

// ── Capacity Computations ──

function computeBuffered(values, buffer) {
  const result = {};
  for (const d of DISCIPLINES) {
    result[d] = Math.round((values[d] || 0) * (1 + (buffer[d] || 0) / 100) * 10) / 10;
  }
  return result;
}

function computeUsedCapacity(projects, roadmapIds, sizeMap) {
  const acc = ZERO_DISC();
  for (const p of projects) {
    if (roadmapIds.has(p.id)) {
      const s = computeProjectSprints(p, sizeMap);
      for (const d of DISCIPLINES) acc[d] += s[d];
    }
  }
  return acc;
}

function computeTotalDemand(projects, sizeMap) {
  const acc = ZERO_DISC();
  for (const p of projects) {
    const s = computeProjectSprints(p, sizeMap);
    for (const d of DISCIPLINES) acc[d] += s[d];
  }
  return acc;
}

function computeUnallocated(capacity, trackCapacity) {
  const result = {};
  for (const d of DISCIPLINES) {
    const allocated = Object.values(trackCapacity).reduce((s, tc) => s + (tc[d] || 0), 0);
    result[d] = (capacity[d] || 0) - allocated;
  }
  return result;
}

// ── Ghost Blocks ──

function computeGhostsByTrack(splits, projectById, tracks, trackKeys) {
  const keys = trackKeys || TRACK_KEYS;
  const result = {};
  for (const k of keys) result[k] = [];
  if (!splits || typeof splits !== 'object' || Array.isArray(splits)) return result;

  for (const [pidStr, trackSplits] of Object.entries(splits)) {
    if (!trackSplits || typeof trackSplits !== 'object') continue;
    const pid = parseInt(pidStr);
    if (isNaN(pid)) continue;
    const p = projectById[pid];
    if (!p) continue;
    // Find home track
    let homeTrack = '';
    if (tracks) {
      for (const tk of keys) {
        if ((tracks[tk] || []).includes(pid)) { homeTrack = tk; break; }
      }
    }
    for (const [targetTrack, sizing] of Object.entries(trackSplits)) {
      if (result[targetTrack] && sizing && typeof sizing === 'object') {
        result[targetTrack].push({ project: p, sizing, homeTrack });
      }
    }
  }
  return result;
}

// ── Track Used Capacity ──

function computeTrackUsed(trackProjectsMap, ghostsByTrackMap, splits, sizeMap, trackKeys) {
  const keys = trackKeys || TRACK_KEYS;
  const result = {};
  for (const tk of keys) {
    const fromProjects = (trackProjectsMap[tk] || []).reduce((acc, p) => {
      const s = computeEffectiveSprints(p, splits, sizeMap);
      for (const d of DISCIPLINES) acc[d] += s[d];
      return acc;
    }, ZERO_DISC());
    const fromGhosts = (ghostsByTrackMap[tk] || []).reduce((acc, g) => {
      if (!g || !g.sizing) return acc;
      for (const d of DISCIPLINES) acc[d] += (g.sizing[d] || 0);
      return acc;
    }, ZERO_DISC());
    result[tk] = {};
    for (const d of DISCIPLINES) result[tk][d] = fromProjects[d] + fromGhosts[d];
  }
  return result;
}

// ── Track Overflow Detection ──

function computeTrackOverflow(trackProjectsMap, trackCapacity, ghostsByTrackMap, trackBlockOrder, splits, sizeMap, trackKeys) {
  const keys = trackKeys || TRACK_KEYS;
  const result = {};
  for (const tk of keys) {
    const tc = trackCapacity[tk] || ZERO_DISC();
    const hasAllocation = Object.values(tc).some(v => v > 0);
    if (!hasAllocation) { result[tk] = {}; continue; }

    const running = ZERO_DISC();
    const overflows = {};

    // Build combined list in display order
    const realItems = (trackProjectsMap[tk] || []).map(p => ({ type: 'real', project: p }));
    const ghostItems = (ghostsByTrackMap[tk] || []).filter(g => g && g.sizing).map(g => ({ type: 'ghost', project: g.project, sizing: g.sizing }));
    const combined = [...realItems, ...ghostItems];
    const order = trackBlockOrder && trackBlockOrder[tk];
    if (order && order.length > 0) {
      combined.sort((a, b) => {
        const aKey = a.type === 'ghost' ? `ghost:${a.project.id}` : String(a.project.id);
        const bKey = b.type === 'ghost' ? `ghost:${b.project.id}` : String(b.project.id);
        const aIdx = order.indexOf(aKey);
        const bIdx = order.indexOf(bKey);
        if (aIdx === -1 && bIdx === -1) return 0;
        if (aIdx === -1) return 1;
        if (bIdx === -1) return 1;
        return aIdx - bIdx;
      });
    }

    for (const item of combined) {
      if (item.type === 'real') {
        const s = computeEffectiveSprints(item.project, splits, sizeMap);
        for (const d of DISCIPLINES) running[d] += s[d];
        const exceeded = [];
        for (const d of DISCIPLINES) {
          if (tc[d] > 0 && running[d] > tc[d]) exceeded.push(d);
        }
        if (exceeded.length > 0) overflows[item.project.id] = exceeded;
      } else {
        for (const d of DISCIPLINES) running[d] += (item.sizing[d] || 0);
        const exceeded = [];
        for (const d of DISCIPLINES) {
          if (tc[d] > 0 && running[d] > tc[d]) exceeded.push(d);
        }
        if (exceeded.length > 0) overflows[`ghost-${item.project.id}`] = exceeded;
      }
    }
    result[tk] = overflows;
  }
  return result;
}

// ── Filter & Sort ──

function filterProjects(projects, search, filters, filterModes) {
  const modes = filterModes || {};
  return projects.filter(p => {
    if (search) {
      const q = search.toLowerCase();
      if (!(p.subTask || '').toLowerCase().includes(q) &&
          !(p.nvrd || '').toLowerCase().includes(q) &&
          !(p.masterEpic || '').toLowerCase().includes(q)) return false;
    }
    if (filters.pillar && filters.pillar.length) {
      const match = filters.pillar.includes(p.pillar);
      if (modes.pillar === 'exclude' ? match : !match) return false;
    }
    if (filters.market && filters.market.length) {
      const match = filters.market.includes(p.targetMarket);
      if (modes.market === 'exclude' ? match : !match) return false;
    }
    if (filters.epic && filters.epic.length) {
      const match = filters.epic.includes(p.masterEpic);
      if (modes.epic === 'exclude' ? match : !match) return false;
    }
    if (filters.kpi && filters.kpi.length) {
      const match = filters.kpi.includes(p.targetKPI);
      if (modes.kpi === 'exclude' ? match : !match) return false;
    }
    if (filters.impact && filters.impact.length) {
      const match = filters.impact.includes(p.impact);
      if (modes.impact === 'exclude' ? match : !match) return false;
    }
    return true;
  });
}

function sortProjects(projects, sortBy, sizeMap) {
  return [...projects].sort((a, b) => {
    if (sortBy === 'impact') return (IMPACT_ORDER[b.impact] || 0) - (IMPACT_ORDER[a.impact] || 0);
    if (sortBy === 'effort') return computeProjectSprints(b, sizeMap).total - computeProjectSprints(a, sizeMap).total;
    if (sortBy === 'name') return (a.subTask || '').localeCompare(b.subTask || '');
    if (sortBy === 'epic') return (a.masterEpic || '').localeCompare(b.masterEpic || '');
    if (sortBy === 'pillar') return (a.pillar || '').localeCompare(b.pillar || '');
    return 0;
  });
}

// ── Project Status Helpers ──

function getProjectStatus(p) {
  if (p && p.status) return p.status;
  return (p && p.inProgress) ? 'in_progress' : 'not_started';
}

function getPercentComplete(p) {
  return (p && typeof p.percentComplete === 'number') ? p.percentComplete : 0;
}

// ── Split Status Helpers ──

function getSplitStatus(splitStatuses, projectId, targetTrack) {
  if (!splitStatuses || !splitStatuses[projectId] || !splitStatuses[projectId][targetTrack])
    return 'not_started';
  return splitStatuses[projectId][targetTrack].status || 'not_started';
}

function getSplitPercentComplete(splitStatuses, projectId, targetTrack) {
  if (!splitStatuses || !splitStatuses[projectId] || !splitStatuses[projectId][targetTrack])
    return 0;
  var pct = splitStatuses[projectId][targetTrack].percentComplete;
  return (typeof pct === 'number') ? pct : 0;
}

// ── Timeline Computation ──

function sprintsToDate(sprintStartDate, sprintWeeks, sprints) {
  if (!sprintStartDate) return null;
  var ms = new Date(sprintStartDate).getTime() + sprints * sprintWeeks * 7 * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function computeTrackTimeline(trackKey, orderedIds, projects, splits, sizeMap,
                               timelineOverrides, timelineConfig, timelineLaneAssignments, splitStatuses) {
  var projectById = {};
  for (var i = 0; i < projects.length; i++) projectById[projects[i].id] = projects[i];

  var sprintStartDate = (timelineConfig && timelineConfig.sprintStartDate) || null;
  var sprintWeeks = (timelineConfig && timelineConfig.sprintDurationWeeks) || 2;
  var overrides = timelineOverrides || {};
  var lanes = timelineLaneAssignments || {};
  var splitSt = splitStatuses || {};
  var result = [];
  var cumSprints = 0;

  for (var j = 0; j < orderedIds.length; j++) {
    var idStr = String(orderedIds[j]);
    var isGhost = idStr.startsWith('ghost:');
    var pid = isGhost ? Number(idStr.replace('ghost:', '')) : Number(idStr);
    if (isNaN(pid)) continue;

    var p = projectById[pid];
    if (!p) continue;

    var ovKey = trackKey + ':' + pid;
    var ov = overrides[ovKey] || null;
    var autoSprints, name, status, percentComplete;

    if (isGhost) {
      // Ghost: compute sprints from split sizing
      var splitSizing = (splits && splits[String(pid)] && splits[String(pid)][trackKey]) || {};
      autoSprints = 0;
      for (var di = 0; di < DISCIPLINES.length; di++) {
        autoSprints += sizeToSprints(splitSizing[DISCIPLINES[di]], sizeMap);
      }
      name = (p.subTask || p.masterEpic || '#' + pid) + ' (split)';
      status = getSplitStatus(splitSt, pid, trackKey);
      percentComplete = getSplitPercentComplete(splitSt, pid, trackKey);
    } else {
      // Regular project
      autoSprints = computeProjectSprints(p, sizeMap).total;
      name = p.subTask || p.masterEpic || '#' + pid;
      status = getProjectStatus(p);
      percentComplete = getPercentComplete(p);
    }

    var startSp = (ov && ov.startSprints != null) ? ov.startSprints : cumSprints;
    var durSp = (ov && ov.durationSprints != null) ? ov.durationSprints : autoSprints;
    var hasOverride = !!(ov && (ov.startSprints != null || ov.durationSprints != null));

    var laneKey = isGhost ? (trackKey + ':ghost:' + pid) : (trackKey + ':' + pid);
    var laneIndex = lanes[laneKey] || lanes[trackKey + ':' + pid] || 0;

    result.push({
      projectId: pid,
      name: name,
      isGhost: isGhost,
      startSprints: startSp,
      durationSprints: durSp,
      startDate: sprintsToDate(sprintStartDate, sprintWeeks, startSp),
      endDate: sprintsToDate(sprintStartDate, sprintWeeks, startSp + durSp),
      hasOverride: hasOverride,
      laneIndex: laneIndex,
      status: status,
      percentComplete: percentComplete,
    });

    // Update cumulative
    if (hasOverride) {
      cumSprints = Math.max(cumSprints, startSp + durSp);
    } else {
      cumSprints = startSp + autoSprints;
    }
  }

  return result;
}

function computeAllTracksTimeline(tracks, projects, splits, sizeMap,
                                   timelineOverrides, timelineConfig, timelineLaneAssignments,
                                   trackConfig, trackBlockOrder, splitStatuses) {
  var keys = Array.isArray(trackConfig) ? trackConfig.map(function(t) { return t.key; }) : TRACK_KEYS;
  var result = {};
  for (var i = 0; i < keys.length; i++) {
    var tk = keys[i];
    var orderedIds = (trackBlockOrder && trackBlockOrder[tk]) || (tracks[tk] || []).map(String);
    result[tk] = computeTrackTimeline(tk, orderedIds, projects, splits, sizeMap,
      timelineOverrides, timelineConfig, timelineLaneAssignments, splitStatuses);
  }
  return result;
}

// ── UI Helpers ──

function getCapColor(pct) {
  if (pct <= 70) return 'var(--green)';
  if (pct <= 90) return 'var(--yellow)';
  return 'var(--red)';
}

function getBlockBg(pillar, pillarColorMap) {
  const c = (pillarColorMap && pillarColorMap[pillar]) || PILLAR_PALETTE[0] || '#6c5ce7';
  return `linear-gradient(135deg, ${c}cc, ${c}88)`;
}

// ── Return public API ──

return {
  DEFAULT_SIZE_MAP, TRACK_KEYS, DEFAULT_TRACK_CONFIG, DISCIPLINES, ZERO_DISC, IMPACT_ORDER,
  PILLAR_PALETTE, buildPillarColorMap, generateTrackKey,
  sizeToSprints, computeProjectSprints, computeEffectiveSprints,
  migrateTracks, migrateTrackCapacity, migrateTrackConfigColors,
  removeFromTracks, deepMergeObject,
  computeBuffered, computeUsedCapacity, computeTotalDemand, computeUnallocated,
  computeGhostsByTrack, computeTrackUsed, computeTrackOverflow,
  filterProjects, sortProjects,
  getCapColor, getBlockBg,
  getProjectStatus, getPercentComplete,
  getSplitStatus, getSplitPercentComplete,
  sprintsToDate, computeTrackTimeline, computeAllTracksTimeline,
};

})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CP;
}
