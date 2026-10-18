// Creates ignored local connection files. Never prints credentials, enables billing,
// or assumes that multiple API keys belong to different Google projects.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dotenv = require('dotenv');
const backend = path.resolve(__dirname, '..');
const service = process.argv[2] && path.resolve(process.argv[2]);
if (!service || !fs.existsSync(path.join(service, 'src', 'server.ts'))) throw new Error('Pass the local Waseet AI service directory.');
const read = file => fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {};
const base = read(path.join(backend, '.env'));
const old = read(path.join(backend, '.env.ai-local'));
const previous = read(path.join(service, '.env.local'));
const secret = old.WASEET_AI_CLIENT_SECRET?.length >= 32 ? old.WASEET_AI_CLIENT_SECRET : crypto.randomBytes(48).toString('base64url');
const signing = previous.WASEET_AI_TOKEN_SIGNING_SECRET?.length >= 32 ? previous.WASEET_AI_TOKEN_SIGNING_SECRET : crypto.randomBytes(48).toString('base64url');
const encode = values => Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n';
const keys = [...new Set((base.LLM_API_KEYS || base.LLM_API_KEY || base.GEMINI_API_KEY || '').split(/[\s,;]+/).filter(Boolean))];
const backendValues = { NODE_ENV: 'development', PORT: '5009', WASEET_AI_AUTH_MODE: 'signed', WASEET_AI_CLIENT_ID: 'waseet_core_backend',
  WASEET_AI_CLIENT_SECRET: secret, WASEET_AI_ENVIRONMENT: 'dev', WASEET_AI_BASE_URL: 'http://127.0.0.1:5010', WASEET_AI_GATEWAY_ENABLED: 'true',
  WASEET_AI_DURABLE_GUARDS: 'sqlite', WASEET_AI_STATE_DIR: path.join(backend, 'work', 'ai-state'), WASEET_AI_STREAM_TIMEOUT_MS: '90000' };
const serviceValues = { NODE_ENV: 'development', PORT: '5010', HOST: '127.0.0.1', WASEET_AI_CLIENT_ID: 'waseet_core_backend',
  WASEET_AI_CLIENT_SECRET: secret, WASEET_AI_TOKEN_SIGNING_SECRET: signing, WASEET_AI_ENVIRONMENT: 'dev',
  WASEET_AI_ALLOWED_ORIGINS: 'http://localhost:4200,http://127.0.0.1:4200,http://127.0.0.1:5010',
  WASEET_AI_STATE_DIR: path.join(service, 'work', 'ai-state'), LLM_API_KEYS: keys.join(','),
  WASEET_AI_FETCH_ALLOWED_HOSTS: 'res.cloudinary.com',
  WASEET_AI_ALLOW_PAID: 'false', WASEET_AI_ENABLE_LIVE: 'false',
  WASEET_AI_FREE_CONFIRMED: previous.WASEET_AI_FREE_CONFIRMED === 'true' ? 'true' : 'false' };
fs.writeFileSync(path.join(backend, '.env.ai-local'), encode(backendValues));
fs.writeFileSync(path.join(service, '.env.local'), encode(serviceValues));
for (const root of [backend, service]) {
  const file = path.join(root, '.gitignore');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const entries = ['.env.local', '.env.ai-local', 'work/ai-state/'];
  fs.writeFileSync(file, text + entries.filter(entry => !text.split(/\r?\n/).includes(entry)).map(entry => `\n${entry}`).join('') + '\n');
}
console.log(JSON.stringify({ configured: true, backendPort: 5009, aiServicePort: 5010, credentialsCopied: keys.length,
  billingEnabled: false, remoteInferenceVerified: false, credentialsRequireProjectAndTierVerification: true }));
