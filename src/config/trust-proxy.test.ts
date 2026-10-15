import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DEFAULT_TRUST_PROXY, resolveTrustProxy } from './trust-proxy';

test('TRUST_PROXY: unset / blank falls back to the safe default; a blanket "true" is never honoured', () => {
  assert.equal(resolveTrustProxy(undefined), DEFAULT_TRUST_PROXY);
  assert.equal(resolveTrustProxy('  '), DEFAULT_TRUST_PROXY);
  assert.equal(resolveTrustProxy('true'), DEFAULT_TRUST_PROXY);
});

test('TRUST_PROXY: false/off, hop counts and CIDR lists are parsed', () => {
  assert.equal(resolveTrustProxy('false'), false);
  assert.equal(resolveTrustProxy('0'), false);
  assert.equal(resolveTrustProxy('1'), 1);
  assert.equal(resolveTrustProxy('loopback'), 'loopback');
  assert.deepEqual(resolveTrustProxy('loopback, 172.23.0.1/32 ,10.0.0.0/8'), ['loopback', '172.23.0.1/32', '10.0.0.0/8']);
});

function ipOf(setting: any, remote: string, xff: string): string {
  const app = express();
  app.set('trust proxy', setting);
  const req: any = Object.create((app as any).request);
  req.app = app;
  req.headers = { 'x-forwarded-for': xff };
  req.socket = { remoteAddress: remote };
  req.connection = req.socket;
  return req.ip;
}

test('req.ip behind the trusted proxy is the real client; a forged leading X-Forwarded-For entry is ignored', () => {
  assert.equal(ipOf(resolveTrustProxy(undefined), '172.23.0.1', '9.9.9.9, 203.0.113.7'), '203.0.113.7');
});

test('a caller that reaches the app WITHOUT the proxy cannot choose its address with X-Forwarded-For', () => {
  assert.equal(ipOf(resolveTrustProxy(undefined), '198.51.100.20', '1.1.1.1'), '198.51.100.20');
  assert.equal(ipOf(resolveTrustProxy('false'), '172.23.0.1', '1.1.1.1'), '172.23.0.1');
});

test('explicit CIDR list trusts only the listed proxy', () => {
  const s = resolveTrustProxy('172.23.0.1/32');
  assert.equal(ipOf(s, '172.23.0.1', '5.5.5.5, 203.0.113.9'), '203.0.113.9');
  assert.equal(ipOf(s, '172.23.0.2', '203.0.113.9'), '172.23.0.2');
});
