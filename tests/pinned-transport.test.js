'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { createPinnedTransport } = require('../src/gateway/pinned-transport');

function request(overrides = {}) {
  return {
    requestId: 'er_transport_1',
    correlationId: 'corr_transport_1',
    destination: {
      scheme: 'http',
      host: 'logical.example',
      port: 80,
    },
    http: {
      method: 'POST',
      path: '/mission',
      query: { z: '2', a: '1', tag: ['red', 'blue'] },
      headers: {
        authorization: 'Bearer injected-secret',
        'content-type': 'application/json',
        'x-client': 'transport-test',
      },
      body: '{"run":true}',
    },
    ...overrides,
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

function fakeHttpModule(remoteAddress) {
  const state = { calls: 0, options: null, body: '' };
  const module = {
    request(options, callback) {
      state.calls += 1;
      state.options = options;
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = (err) => {
        if (err) process.nextTick(() => req.emit('error', err));
      };
      req.end = (body) => {
        state.body = body ? body.toString() : '';
        process.nextTick(() => {
          const response = new EventEmitter();
          response.statusCode = 200;
          response.headers = {};
          response.socket = { remoteAddress };
          callback(response);
          response.emit('data', Buffer.from('ok'));
          response.emit('end');
        });
      };
      return req;
    },
  };
  return { module, state };
}

test('requires commit permit, pinning context and admitted literal addresses before opening a request', async () => {
  let calls = 0;
  const transport = createPinnedTransport({
    httpModule: {
      request() {
        calls += 1;
      },
    },
  });

  await assert.rejects(
    () => transport(request(), {
      resolvedAddresses: ['203.0.113.9'],
      requireAddressPinning: true,
    }),
    { code: 'commit_permit_required' },
  );
  await assert.rejects(
    () => transport(request(), {
      resolvedAddresses: ['203.0.113.9'],
      permitId: 'permit/1',
      requireAddressPinning: false,
    }),
    { code: 'address_pinning_required' },
  );
  await assert.rejects(
    () => transport(request(), {
      resolvedAddresses: ['logical.example'],
      permitId: 'permit/1',
      requireAddressPinning: true,
    }),
    { code: 'address_pin_invalid' },
  );
  assert.equal(calls, 0);
});

test('uses an admitted address for the socket while retaining the logical host and bounds the response', async () => {
  const observed = {};
  const server = http.createServer((req, res) => {
    observed.method = req.method;
    observed.url = req.url;
    observed.host = req.headers.host;
    observed.authorization = req.headers.authorization;
    observed.connection = req.headers.connection;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      observed.body = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const port = await listen(server);

  try {
    const transport = createPinnedTransport({ maxResponseBytes: 1024 });
    const result = await transport(request({
      destination: { scheme: 'http', host: 'logical.example', port },
    }), {
      resolvedAddresses: ['127.0.0.1'],
      permitId: 'permit/transport-1',
      requireAddressPinning: true,
    });

    assert.equal(result.status, 200);
    assert.equal(result.body, '{"ok":true}');
    assert.equal(result.connectedAddress, '127.0.0.1');
    assert.equal(observed.method, 'POST');
    assert.equal(observed.url, '/mission?a=1&tag=red&tag=blue&z=2');
    assert.equal(observed.host, 'logical.example:' + port);
    assert.equal(observed.authorization, 'Bearer injected-secret');
    assert.equal(observed.connection, 'close');
    assert.equal(observed.body, '{"run":true}');
  } finally {
    await close(server);
  }
});

test('pins lookup and refuses a response from an address outside admission', async () => {
  const fake = fakeHttpModule('203.0.113.8');
  const transport = createPinnedTransport({ httpModule: fake.module });
  const pending = transport(request(), {
    resolvedAddresses: ['203.0.113.9'],
    permitId: 'permit/transport-2',
    requireAddressPinning: true,
  });

  await assert.rejects(pending, { code: 'transport_address_not_pinned' });
  assert.equal(fake.state.calls, 1);
  assert.equal(fake.state.options.hostname, 'logical.example');
  assert.equal(fake.state.options.agent, false);
  assert.equal(fake.state.body, '{"run":true}');

  let lookupResult;
  fake.state.options.lookup('logical.example', {}, (...args) => {
    lookupResult = args;
  });
  assert.deepEqual(lookupResult, [null, '203.0.113.9', 4]);
});

test('does not follow redirects and refuses reserved caller-controlled transport headers', async () => {
  const fake = fakeHttpModule('203.0.113.9');
  const transport = createPinnedTransport({ httpModule: fake.module });
  const result = await transport(request(), {
    resolvedAddresses: ['203.0.113.9'],
    permitId: 'permit/transport-3',
    requireAddressPinning: true,
  });
  assert.equal(result.status, 200);

  for (const header of ['host', 'connection', 'content-length', 'transfer-encoding']) {
    await assert.rejects(
      () => transport(request({ http: { ...request().http, headers: { [header]: 'caller-controlled' } } }), {
        resolvedAddresses: ['203.0.113.9'],
        permitId: 'permit/transport-3',
        requireAddressPinning: true,
      }),
      { code: 'reserved_transport_header' },
    );
  }
});
