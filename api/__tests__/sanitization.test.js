const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, '..', 'data_test_sanitization');
process.env.DATA_DIR = TEST_DATA_DIR;

if (!fs.existsSync(TEST_DATA_DIR)) fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

const {
  stripHtmlTags,
  sanitizeString,
  sanitizeProject,
  sanitizeMilestones,
  app,
  wss,
  keepaliveInterval,
  rateLimitCleanup,
  tokenCacheCleanup,
} = require('../server');
const request = require('supertest');

beforeEach(() => {
  fs.readdirSync(TEST_DATA_DIR).forEach(f => {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(TEST_DATA_DIR, f));
  });
  // Write editors.json so test emails pass authorization middleware
  fs.writeFileSync(
    path.join(TEST_DATA_DIR, 'editors.json'),
    JSON.stringify([{email:'kmermigkas@novibet.com',verticals:['all']}])
  );
});

afterAll(() => {
  clearInterval(keepaliveInterval);
  clearInterval(rateLimitCleanup);
  clearInterval(tokenCacheCleanup);
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.readdirSync(TEST_DATA_DIR).forEach(f => fs.unlinkSync(path.join(TEST_DATA_DIR, f)));
    fs.rmdirSync(TEST_DATA_DIR);
  }
  wss.close();
});

// ── Unit: stripHtmlTags ──

describe('stripHtmlTags', () => {
  test('strips basic HTML tags', () => {
    expect(stripHtmlTags('<b>bold</b>')).toBe('bold');
  });

  test('strips script tags', () => {
    expect(stripHtmlTags('<script>alert("x")</script>')).toBe('alert("x")');
  });

  test('strips nested tags', () => {
    expect(stripHtmlTags('<div><span>text</span></div>')).toBe('text');
  });

  test('strips self-closing tags', () => {
    expect(stripHtmlTags('hello<br/>world')).toBe('helloworld');
  });

  test('returns non-string values unchanged', () => {
    expect(stripHtmlTags(null)).toBe(null);
    expect(stripHtmlTags(undefined)).toBe(undefined);
    expect(stripHtmlTags(42)).toBe(42);
  });

  test('handles empty string', () => {
    expect(stripHtmlTags('')).toBe('');
  });

  test('preserves plain text', () => {
    expect(stripHtmlTags('hello world')).toBe('hello world');
  });
});

// ── Unit: sanitizeString ──

describe('sanitizeString', () => {
  test('trims whitespace', () => {
    expect(sanitizeString('  hello  ', 100)).toBe('hello');
  });

  test('strips HTML and trims', () => {
    expect(sanitizeString('  <b>hello</b>  ', 100)).toBe('hello');
  });

  test('truncates to maxLength', () => {
    const long = 'a'.repeat(500);
    expect(sanitizeString(long, 200)).toBe('a'.repeat(200));
  });

  test('handles non-string input', () => {
    expect(sanitizeString(null, 100)).toBe(null);
    expect(sanitizeString(undefined, 100)).toBe(undefined);
    expect(sanitizeString(42, 100)).toBe(42);
  });

  test('strips HTML before truncating', () => {
    const html = '<b>' + 'x'.repeat(100) + '</b>';
    expect(sanitizeString(html, 50)).toBe('x'.repeat(50));
  });
});

// ── Unit: sanitizeProject ──

describe('sanitizeProject', () => {
  test('trims string fields', () => {
    const p = sanitizeProject({ id: 1, subTask: '  My Task  ', nvrd: ' PGR-1 ' });
    expect(p.subTask).toBe('My Task');
    expect(p.nvrd).toBe('PGR-1');
  });

  test('strips HTML from string fields', () => {
    const p = sanitizeProject({ id: 1, subTask: '<script>alert(1)</script>Task', masterEpic: '<b>Epic</b>' });
    expect(p.subTask).toBe('alert(1)Task');
    expect(p.masterEpic).toBe('Epic');
  });

  test('truncates overly long strings', () => {
    const p = sanitizeProject({ id: 1, nvrd: 'x'.repeat(200) });
    expect(p.nvrd.length).toBe(50);
  });

  test('preserves non-string fields unchanged', () => {
    const p = sanitizeProject({ id: 42, inProgress: true, backend: 'S', natives: 'XL' });
    expect(p.id).toBe(42);
    expect(p.inProgress).toBe(true);
    expect(p.backend).toBe('S');
    expect(p.natives).toBe('XL');
  });

  test('handles project with missing optional fields', () => {
    const p = sanitizeProject({ id: 1 });
    expect(p.id).toBe(1);
    expect(p.subTask).toBeUndefined();
  });

  test('accepts any pillar value (free-form per vertical)', () => {
    const p = sanitizeProject({ id: 1, pillar: 'Custom Pillar Name' });
    expect(p.pillar).toBe('Custom Pillar Name');
  });

  test('warns on unknown targetKPI (does not throw)', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    sanitizeProject({ id: 1, targetKPI: 'InvalidKPI' });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Unknown targetKPI'));
    spy.mockRestore();
  });

  test('does not warn on valid KPI', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    sanitizeProject({ id: 1, pillar: 'Any Pillar', targetKPI: 'Revenue' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── Unit: sanitizeMilestones ──

describe('sanitizeMilestones', () => {
  test('sanitizes milestone name and description', () => {
    const result = sanitizeMilestones([
      { id: 1, name: '  <b>Q1 Release</b>  ', description: '<script>x</script>Desc' },
    ]);
    expect(result[0].name).toBe('Q1 Release');
    expect(result[0].description).toBe('xDesc');
  });

  test('truncates long names and descriptions', () => {
    const result = sanitizeMilestones([
      { id: 1, name: 'x'.repeat(200), description: 'y'.repeat(1000) },
    ]);
    expect(result[0].name.length).toBe(100);
    expect(result[0].description.length).toBe(500);
  });

  test('returns non-array input unchanged', () => {
    expect(sanitizeMilestones(null)).toBe(null);
    expect(sanitizeMilestones('not an array')).toBe('not an array');
  });

  test('handles empty array', () => {
    expect(sanitizeMilestones([])).toEqual([]);
  });

  test('preserves non-string milestone fields', () => {
    const result = sanitizeMilestones([{ id: 1, name: 'Test', date: '2026-03-31', color: '#e84393' }]);
    expect(result[0].id).toBe(1);
    expect(result[0].date).toBe('2026-03-31');
    expect(result[0].color).toBe('#e84393');
  });
});

// ── Integration: POST /api/verticals/:key/projects ──

describe('POST /api/verticals/:key/projects — sanitization', () => {
  test('strips HTML tags from project string fields', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/projects')
      .set('X-User-Email', 'kmermigkas@novibet.com')
      .send({
        projects: [
          { id: 1, subTask: '<script>alert(1)</script>My Task', nvrd: '<b>PGR-1</b>', backend: 'S' },
        ],
      });
    expect(res.status).toBe(200);

    const getRes = await request(app).get('/api/verticals/growth/projects');
    expect(getRes.body.projects[0].subTask).toBe('alert(1)My Task');
    expect(getRes.body.projects[0].nvrd).toBe('PGR-1');
  });

  test('trims whitespace from project fields', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/projects')
      .set('X-User-Email', 'kmermigkas@novibet.com')
      .send({
        projects: [
          { id: 1, subTask: '  Trimmed Task  ', masterEpic: '  Epic  ' },
        ],
      });
    expect(res.status).toBe(200);

    const getRes = await request(app).get('/api/verticals/growth/projects');
    expect(getRes.body.projects[0].subTask).toBe('Trimmed Task');
    expect(getRes.body.projects[0].masterEpic).toBe('Epic');
  });

  test('truncates overly long strings', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/projects')
      .set('X-User-Email', 'kmermigkas@novibet.com')
      .send({
        projects: [
          { id: 1, nvrd: 'x'.repeat(200) },
        ],
      });
    expect(res.status).toBe(200);

    const getRes = await request(app).get('/api/verticals/growth/projects');
    expect(getRes.body.projects[0].nvrd.length).toBe(50);
  });
});

// ── Integration: POST /api/verticals/:key/state — milestone sanitization ──

describe('POST /api/verticals/:key/state — milestone sanitization', () => {
  test('sanitizes milestone names when saved via state', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/state')
      .set('X-User-Email', 'kmermigkas@novibet.com')
      .send({
        _loadedAt: 0,
        milestones: [
          { id: 1, name: '  <b>Q1</b>  ', date: '2026-03-31', color: '#e84393' },
        ],
      });
    expect(res.status).toBe(200);

    const getRes = await request(app).get('/api/verticals/growth/state');
    expect(getRes.body.milestones[0].name).toBe('Q1');
  });
});

// ── Integration: POST /api/verticals/:key/snapshots — name sanitization ──

describe('POST /api/verticals/:key/snapshots — sanitization', () => {
  test('sanitizes snapshot name', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/snapshots')
      .set('X-User-Email', 'kmermigkas@novibet.com')
      .send({ name: '  <b>My Snapshot</b>  ' });
    expect(res.status).toBe(200);

    const listRes = await request(app).get('/api/verticals/growth/snapshots');
    expect(listRes.body.snapshots[0].name).toBe('My Snapshot');
  });
});
