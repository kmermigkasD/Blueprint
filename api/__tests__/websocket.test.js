/**
 * WebSocket tests for real-time sync.
 *
 * Tests cover:
 * - Connection and welcome message
 * - Subscribe to vertical
 * - Broadcast on state save
 * - Broadcast on project save
 * - Sender exclusion via X-WS-ID
 * - Multiple clients on same vertical
 * - Client disconnection cleanup
 * - Invalid messages
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const request = require('supertest');

// Set DATA_DIR before importing server
const TEST_DATA_DIR = path.join(__dirname, '..', 'data_test_ws');
process.env.DATA_DIR = TEST_DATA_DIR;

if (!fs.existsSync(TEST_DATA_DIR)) fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

const { app, server, wss, verticalClients, keepaliveInterval, rateLimitCleanup, tokenCacheCleanup } = require('../server');

let TEST_PORT;
let serverInstance;

function connectWS() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws`);
    // Buffer messages received before waitForMessage is called
    ws._msgBuffer = [];
    ws._msgListeners = [];
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Check if any listener is waiting for this message
        for (let i = 0; i < ws._msgListeners.length; i++) {
          const { filter, resolve: res, timer } = ws._msgListeners[i];
          if (!filter || filter(msg)) {
            clearTimeout(timer);
            ws._msgListeners.splice(i, 1);
            res(msg);
            return;
          }
        }
        // No listener matched — buffer it
        ws._msgBuffer.push(msg);
      } catch (e) {
        // ignore non-JSON
      }
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(new Error(`WS connect failed: ${err.message}`)));
  });
}

function waitForMessage(ws, filter, timeoutMs = 5000) {
  // Check buffered messages first
  for (let i = 0; i < ws._msgBuffer.length; i++) {
    const msg = ws._msgBuffer[i];
    if (!filter || filter(msg)) {
      ws._msgBuffer.splice(i, 1);
      return Promise.resolve(msg);
    }
  }
  // Not found in buffer — register listener
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Remove this listener on timeout
      ws._msgListeners = ws._msgListeners.filter(l => l.resolve !== resolve);
      reject(new Error('Timeout waiting for WS message'));
    }, timeoutMs);
    ws._msgListeners.push({ filter, resolve, timer });
  });
}

// Make HTTP requests to the actual server (not supertest's separate instance)
function httpRequest(method, urlPath) {
  return request(`http://localhost:${TEST_PORT}`)[method](urlPath);
}

// ── Setup / Teardown ──
beforeAll(async () => {
  await new Promise((resolve) => {
    // Use port 0 to get a random available port
    serverInstance = server.listen(0, () => {
      TEST_PORT = serverInstance.address().port;
      resolve();
    });
  });
});

afterAll(async () => {
  clearInterval(keepaliveInterval);
  clearInterval(rateLimitCleanup);
  clearInterval(tokenCacheCleanup);
  wss.clients.forEach(ws => ws.close());
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.readdirSync(TEST_DATA_DIR).forEach(f => fs.unlinkSync(path.join(TEST_DATA_DIR, f)));
    fs.rmdirSync(TEST_DATA_DIR);
  }
  await new Promise((resolve) => {
    wss.close();
    serverInstance.close(resolve);
  });
});

beforeEach(() => {
  fs.readdirSync(TEST_DATA_DIR).forEach(f => {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(TEST_DATA_DIR, f));
  });
  // Write editors.json so test emails pass authorization middleware
  fs.writeFileSync(
    path.join(TEST_DATA_DIR, 'editors.json'),
    JSON.stringify([{email:'test@novibet.com',verticals:['all']}])
  );
});

// ═══════════════════════════════════════════════
// Connection
// ═══════════════════════════════════════════════

describe('WebSocket connection', () => {
  test('receives welcome message on connect', async () => {
    const ws = await connectWS();
    const msg = await waitForMessage(ws, m => m.type === 'connected');
    expect(msg.type).toBe('connected');
    ws.close();
  });
});

// ═══════════════════════════════════════════════
// Subscribe
// ═══════════════════════════════════════════════

describe('WebSocket subscribe', () => {
  test('subscribes to a vertical', async () => {
    const ws = await connectWS();
    await waitForMessage(ws, m => m.type === 'connected');

    ws.send(JSON.stringify({ type: 'subscribe', vertical: 'payments' }));
    await new Promise(r => setTimeout(r, 200));

    const clients = verticalClients.get('payments');
    expect(clients).toBeDefined();
    expect(clients.size).toBe(1);
    ws.close();
  });

  test('unsubscribes from previous vertical on re-subscribe', async () => {
    const ws = await connectWS();
    await waitForMessage(ws, m => m.type === 'connected');

    // Use valid vertical names
    ws.send(JSON.stringify({ type: 'subscribe', vertical: 'sportsbook' }));
    await new Promise(r => setTimeout(r, 200));

    const clientsBefore = verticalClients.get('sportsbook');
    expect(clientsBefore).toBeDefined();
    expect(clientsBefore.size).toBe(1);

    // Re-subscribe to a different vertical
    ws.send(JSON.stringify({ type: 'subscribe', vertical: 'account' }));
    await new Promise(r => setTimeout(r, 200));

    // Old vertical should have 0 clients
    const clientsAfterA = verticalClients.get('sportsbook');
    expect(clientsAfterA.size).toBe(0);
    // New vertical should have 1 client
    const clientsAfterB = verticalClients.get('account');
    expect(clientsAfterB).toBeDefined();
    expect(clientsAfterB.size).toBe(1);
    ws.close();
  });
});

// ═══════════════════════════════════════════════
// Broadcast on state save
// ═══════════════════════════════════════════════

describe('WebSocket broadcast on state save', () => {
  test('broadcasts update to subscribed clients on state save', async () => {
    const ws = await connectWS();
    await waitForMessage(ws, m => m.type === 'connected');

    ws.send(JSON.stringify({ type: 'subscribe', vertical: 'growth' }));
    await new Promise(r => setTimeout(r, 200));

    // Set up listener BEFORE making the HTTP request
    const updatePromise = waitForMessage(ws, m => m.type === 'update');

    // Save state via HTTP to the ACTUAL server (not supertest)
    await httpRequest('post', '/api/verticals/growth/state')
      .set('X-User-Email', 'test@novibet.com')
      .send({ capacity: { backend: 55 }, _loadedAt: 0 });

    const msg = await updatePromise;
    expect(msg.type).toBe('update');
    expect(msg.vertical).toBe('growth');
    expect(msg.state).toBeDefined();
    expect(msg.state.capacity.backend).toBe(55);
    expect(msg.projects).toBeDefined();
    ws.close();
  });

  test('does not broadcast to clients on different vertical', async () => {
    const wsGrowth = await connectWS();
    const wsCasino = await connectWS();
    await waitForMessage(wsGrowth, m => m.type === 'connected');
    await waitForMessage(wsCasino, m => m.type === 'connected');

    wsGrowth.send(JSON.stringify({ type: 'subscribe', vertical: 'growth' }));
    wsCasino.send(JSON.stringify({ type: 'subscribe', vertical: 'casino' }));
    await new Promise(r => setTimeout(r, 200));

    let casinoGotUpdate = false;
    wsCasino.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'update' && msg.vertical === 'growth') {
        casinoGotUpdate = true;
      }
    });

    await httpRequest('post', '/api/verticals/growth/state')
      .set('X-User-Email', 'kmermigkas@novibet.com')
      .send({ capacity: { backend: 60 }, _loadedAt: 0 });

    await new Promise(r => setTimeout(r, 500));
    expect(casinoGotUpdate).toBe(false);

    wsGrowth.close();
    wsCasino.close();
  });
});

// ═══════════════════════════════════════════════
// Broadcast on project save
// ═══════════════════════════════════════════════

describe('WebSocket broadcast on project save', () => {
  test('broadcasts update when projects are saved', async () => {
    const ws = await connectWS();
    await waitForMessage(ws, m => m.type === 'connected');

    ws.send(JSON.stringify({ type: 'subscribe', vertical: 'growth' }));
    await new Promise(r => setTimeout(r, 200));

    const updatePromise = waitForMessage(ws, m => m.type === 'update');

    await httpRequest('post', '/api/verticals/growth/projects')
      .set('X-User-Email', 'kmermigkas@novibet.com')
      .send({ projects: [{ id: 1, subTask: 'Test' }] });

    const msg = await updatePromise;
    expect(msg.type).toBe('update');
    expect(msg.projects).toHaveLength(1);
    ws.close();
  });
});

// ═══════════════════════════════════════════════
// Sender exclusion (X-WS-ID)
// ═══════════════════════════════════════════════

describe('Sender exclusion via X-WS-ID', () => {
  test('broadcast includes senderId for client-side filtering', async () => {
    const ws = await connectWS();
    await waitForMessage(ws, m => m.type === 'connected');

    ws.send(JSON.stringify({ type: 'subscribe', vertical: 'growth' }));
    await new Promise(r => setTimeout(r, 200));

    const updatePromise = waitForMessage(ws, m => m.type === 'update');

    await httpRequest('post', '/api/verticals/growth/state')
      .set('X-WS-ID', 'my-tab-123')
      .set('X-User-Email', 'kmermigkas@novibet.com')
      .send({ capacity: { backend: 70 }, _loadedAt: 0 });

    const msg = await updatePromise;
    expect(msg.senderId).toBe('my-tab-123');
    ws.close();
  });
});

// ═══════════════════════════════════════════════
// Multiple clients on same vertical
// ═══════════════════════════════════════════════

describe('Multiple clients on same vertical', () => {
  test('all subscribed clients receive broadcast', async () => {
    const ws1 = await connectWS();
    const ws2 = await connectWS();
    await waitForMessage(ws1, m => m.type === 'connected');
    await waitForMessage(ws2, m => m.type === 'connected');

    ws1.send(JSON.stringify({ type: 'subscribe', vertical: 'growth' }));
    ws2.send(JSON.stringify({ type: 'subscribe', vertical: 'growth' }));
    await new Promise(r => setTimeout(r, 200));

    const p1 = waitForMessage(ws1, m => m.type === 'update');
    const p2 = waitForMessage(ws2, m => m.type === 'update');

    await httpRequest('post', '/api/verticals/growth/state')
      .set('X-User-Email', 'kmermigkas@novibet.com')
      .send({ capacity: { backend: 80 }, _loadedAt: 0 });

    const [msg1, msg2] = await Promise.all([p1, p2]);
    expect(msg1.state.capacity.backend).toBe(80);
    expect(msg2.state.capacity.backend).toBe(80);

    ws1.close();
    ws2.close();
  });
});

// ═══════════════════════════════════════════════
// Client disconnection cleanup
// ═══════════════════════════════════════════════

describe('Client disconnection', () => {
  test('removes client from vertical set on disconnect', async () => {
    const ws = await connectWS();
    await waitForMessage(ws, m => m.type === 'connected');

    ws.send(JSON.stringify({ type: 'subscribe', vertical: 'casino' }));
    await new Promise(r => setTimeout(r, 200));

    const clientsBefore = verticalClients.get('casino');
    expect(clientsBefore).toBeDefined();
    expect(clientsBefore.size).toBe(1);

    ws.close();
    await new Promise(r => setTimeout(r, 300));

    const clientsAfter = verticalClients.get('casino');
    expect(clientsAfter.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════
// Invalid messages
// ═══════════════════════════════════════════════

describe('Invalid WebSocket messages', () => {
  test('handles non-JSON messages gracefully', async () => {
    const ws = await connectWS();
    await waitForMessage(ws, m => m.type === 'connected');

    // Should not crash the server
    ws.send('this is not json');
    await new Promise(r => setTimeout(r, 200));

    // Connection should still be alive
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test('handles subscribe without vertical gracefully', async () => {
    const ws = await connectWS();
    await waitForMessage(ws, m => m.type === 'connected');

    ws.send(JSON.stringify({ type: 'subscribe' }));
    await new Promise(r => setTimeout(r, 200));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});
