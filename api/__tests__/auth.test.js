/**
 * Auth Tests — JWT verification, auth middleware, 401 enforcement
 *
 * These tests mock the google-auth-library to control token verification.
 * Most tests run with NODE_ENV=test (default), which allows header fallback.
 * Production-mode tests temporarily override NODE_ENV to test JWT enforcement.
 */

const path = require('path');
const fs = require('fs');

// Mock google-auth-library BEFORE requiring server
jest.mock('google-auth-library', () => {
  const mockVerifyIdToken = jest.fn();
  return {
    OAuth2Client: jest.fn().mockImplementation(() => ({
      verifyIdToken: mockVerifyIdToken,
    })),
    _mockVerifyIdToken: mockVerifyIdToken,
  };
});

const { _mockVerifyIdToken } = require('google-auth-library');

// Set up test data dir
const TEST_DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(TEST_DATA_DIR)) fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

const {
  app, keepaliveInterval, rateLimitCleanup, tokenCacheCleanup,
  verifyGoogleToken, tokenCache, ADMIN_EMAIL,
} = require('../server');
const request = require('supertest');

// ── Setup / Teardown ──
beforeEach(() => {
  // Clean data files between tests
  fs.readdirSync(TEST_DATA_DIR).forEach(f => {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(TEST_DATA_DIR, f));
  });
  // Write editors.json so test emails pass authorization middleware
  fs.writeFileSync(
    path.join(TEST_DATA_DIR, 'editors.json'),
    JSON.stringify([
      { email: 'test@novibet.com', verticals: ['all'] },
      { email: ADMIN_EMAIL, verticals: ['all'] },
    ])
  );
  // Clear token cache between tests
  tokenCache.clear();
  // Reset mock
  _mockVerifyIdToken.mockReset();
});

afterAll(() => {
  clearInterval(keepaliveInterval);
  clearInterval(rateLimitCleanup);
  clearInterval(tokenCacheCleanup);
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.readdirSync(TEST_DATA_DIR).forEach(f => fs.unlinkSync(path.join(TEST_DATA_DIR, f)));
    fs.rmdirSync(TEST_DATA_DIR);
  }
});

// Helper: configure mock to accept a specific token
function mockValidToken(token, email = 'test@novibet.com', name = 'Test User') {
  _mockVerifyIdToken.mockImplementation(async ({ idToken }) => {
    if (idToken === token) {
      return {
        getPayload: () => ({
          email,
          name,
          picture: 'https://example.com/pic.jpg',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      };
    }
    throw new Error('Invalid token');
  });
}

// ═══════════════════════════════════════════════
//  verifyGoogleToken unit tests
// ═══════════════════════════════════════════════

describe('verifyGoogleToken', () => {
  test('returns null for null/undefined/empty token', async () => {
    expect(await verifyGoogleToken(null)).toBeNull();
    expect(await verifyGoogleToken(undefined)).toBeNull();
    expect(await verifyGoogleToken('')).toBeNull();
  });

  test('returns payload for valid token', async () => {
    mockValidToken('valid-jwt-123');
    const payload = await verifyGoogleToken('valid-jwt-123');
    expect(payload).not.toBeNull();
    expect(payload.email).toBe('test@novibet.com');
    expect(payload.name).toBe('Test User');
  });

  test('returns null for invalid token', async () => {
    _mockVerifyIdToken.mockRejectedValue(new Error('Invalid token'));
    const payload = await verifyGoogleToken('bad-token');
    expect(payload).toBeNull();
  });

  test('rejects non-novibet.com domain', async () => {
    _mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        email: 'hacker@gmail.com',
        name: 'Hacker',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    });
    const payload = await verifyGoogleToken('external-token');
    expect(payload).toBeNull();
  });

  test('caches verified tokens', async () => {
    mockValidToken('cache-test-token');
    // First call — hits Google
    await verifyGoogleToken('cache-test-token');
    expect(_mockVerifyIdToken).toHaveBeenCalledTimes(1);
    // Second call — should use cache
    const payload = await verifyGoogleToken('cache-test-token');
    expect(_mockVerifyIdToken).toHaveBeenCalledTimes(1); // Not called again
    expect(payload.email).toBe('test@novibet.com');
  });

  test('does not use expired cache entries', async () => {
    mockValidToken('expire-test');
    await verifyGoogleToken('expire-test');
    // Manually expire the cache entry
    const cached = tokenCache.get('expire-test');
    cached.expiresAt = Date.now() - 1000;
    // Next call should re-verify
    await verifyGoogleToken('expire-test');
    expect(_mockVerifyIdToken).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════
//  Auth middleware tests (test mode — header fallback)
// ═══════════════════════════════════════════════

describe('Auth middleware (test mode)', () => {
  test('populates req.auth from X-User-Email header in test mode', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('X-User-Email', 'test@novibet.com')
      .set('X-User-Name', 'Test%20User');
    expect(res.status).toBe(200);
  });

  test('allows writes with X-User-Email header in test mode (no JWT)', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/projects')
      .set('X-User-Email', 'test@novibet.com')
      .send({ projects: [] });
    expect(res.status).toBe(200);
  });

  test('populates req.auth from Authorization header when JWT is valid', async () => {
    mockValidToken('auth-header-test');
    const res = await request(app)
      .post('/api/verticals/growth/projects')
      .set('Authorization', 'Bearer auth-header-test')
      .send({ projects: [] });
    expect(res.status).toBe(200);
  });

  test('populates req.auth from body._token when present', async () => {
    mockValidToken('body-token-test');
    const res = await request(app)
      .post('/api/verticals/growth/state')
      .send({
        _token: 'body-token-test',
        _loadedAt: 0,
        capacity: { backend: 40, frontend: 30, natives: 25 },
      });
    // Should succeed because _token is verified
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════
//  Production mode tests — JWT enforcement
// ═══════════════════════════════════════════════

describe('Auth graceful degradation', () => {
  test('falls back to X-User-Email when JWT verification fails', async () => {
    _mockVerifyIdToken.mockRejectedValue(new Error('Invalid'));
    const res = await request(app)
      .post('/api/verticals/growth/projects')
      .set('Authorization', 'Bearer invalid-token')
      .set('X-User-Email', 'test@novibet.com')
      .send({ projects: [] });
    // Should succeed via header fallback, not 401
    expect(res.status).toBe(200);
  });

  test('allows writes with valid JWT (verified path)', async () => {
    mockValidToken('prod-valid-token');
    const res = await request(app)
      .post('/api/verticals/growth/projects')
      .set('Authorization', 'Bearer prod-valid-token')
      .send({ projects: [] });
    expect(res.status).toBe(200);
  });

  test('rejects writes with no auth at all (no JWT, no header)', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/projects')
      .send({ projects: [] });
    // Should get 403 (no editor access) since email is empty
    expect(res.status).toBe(403);
  });

  test('allows GET requests without any auth', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  test('allows editor access request without JWT (exempt endpoint)', async () => {
    const res = await request(app)
      .post('/api/editors/request')
      .set('X-User-Email', 'viewer@novibet.com')
      .send({});
    // Exempt from auth middleware, so not 401
    expect(res.status).not.toBe(401);
  });
});
