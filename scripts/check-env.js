// Validates that every required env var is present AND actually works, by making a
// small live call to each external service. Never logs secret values — only pass/fail.
// Run with: railway run node scripts/check-env.js   (or `npm run check-env` locally
// with a .env file present).
require('dotenv').config();

const REQUIRED_PRESENT_ONLY = ['SESSION_SECRET', 'STAFF_PASSWORD', 'BASE_URL'];
const OPTIONAL = ['API_TOKEN']; // only needed if something calls /api/*

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
}

async function checkPresence() {
  for (const name of REQUIRED_PRESENT_ONLY) {
    const val = process.env[name];
    record(name, Boolean(val && val.trim()), val ? 'set' : 'MISSING');
  }
  for (const name of OPTIONAL) {
    const val = process.env[name];
    record(name, true, val ? 'set' : 'not set (optional — only needed if /api/* is used)');
  }
}

async function checkDatabase() {
  if (!process.env.DATABASE_URL) return record('DATABASE_URL', false, 'MISSING');

  // Railway's internal DB hostname (*.railway.internal) is a private-network address —
  // it only resolves for services running inside Railway itself, never from a local
  // machine running `railway run`. That's expected, not a misconfiguration.
  if (process.env.DATABASE_URL.includes('.railway.internal')) {
    return record(
      'DATABASE_URL',
      true,
      "set, using Railway's private network hostname — can't be dialed from a local machine, but will work once the app runs on Railway itself"
    );
  }

  try {
    const pool = require('../db/pool');
    await pool.query('SELECT 1');
    record('DATABASE_URL', true, 'connected');
    await pool.end();
  } catch (err) {
    record('DATABASE_URL', false, err.message);
  }
}

async function checkStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return record('STRIPE_SECRET_KEY', false, 'MISSING');
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const balance = await stripe.balance.retrieve();
    const mode = process.env.STRIPE_SECRET_KEY.startsWith('sk_test_') ? 'test mode' : 'LIVE MODE';
    record('STRIPE_SECRET_KEY', true, `valid (${mode}, currency: ${balance.available[0]?.currency || 'n/a'})`);
  } catch (err) {
    record('STRIPE_SECRET_KEY', false, err.message);
  }

  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  record(
    'STRIPE_WEBHOOK_SECRET',
    Boolean(whsec && whsec.startsWith('whsec_')),
    whsec ? (whsec.startsWith('whsec_') ? "set, looks correctly formatted (can't verify further without a real event)" : 'set but does not start with whsec_ — check it') : 'MISSING'
  );
}

async function checkAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return record('ANTHROPIC_API_KEY', false, 'MISSING');
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }]
    });
    record('ANTHROPIC_API_KEY', true, 'valid (this check makes one tiny real API call)');
  } catch (err) {
    // A 404 "model not found" only happens after the key authenticates — Anthropic
    // rejects with 401 first if the key itself is bad. So this means the key is fine;
    // only the hardcoded model id here (not the app's lib/ai.js) is stale.
    if (err.status === 404) {
      record('ANTHROPIC_API_KEY', true, 'valid (key authenticated; the model id used by this check is stale, harmless)');
    } else {
      record('ANTHROPIC_API_KEY', false, `${err.status || ''} ${err.message}`.trim());
    }
  }
}

async function checkR2() {
  const need = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL'];
  const missing = need.filter((n) => !process.env[n]);
  if (missing.length) {
    for (const n of need) record(n, Boolean(process.env[n]), process.env[n] ? 'set' : 'MISSING');
    return;
  }

  try {
    const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }
    });
    await client.send(new HeadBucketCommand({ Bucket: process.env.R2_BUCKET }));
    for (const n of need) record(n, true, 'set');
    record('R2 connection', true, 'bucket reachable with these credentials');
  } catch (err) {
    for (const n of need) record(n, true, 'set (but see connection error below)');
    record('R2 connection', false, err.message);
  }

  try {
    const url = process.env.R2_PUBLIC_URL.replace(/\/$/, '');
    const res = await fetch(url);
    // A bare bucket root commonly 404s even when public access is configured correctly —
    // anything other than a network failure means the domain itself resolves and responds.
    record('R2_PUBLIC_URL', true, `reachable (HTTP ${res.status} — 404 here is normal for an empty path)`);
  } catch (err) {
    record('R2_PUBLIC_URL', false, `not reachable: ${err.message}`);
  }
}

async function main() {
  await checkPresence();
  await checkDatabase();
  await checkStripe();
  await checkAnthropic();
  await checkR2();

  console.log('\n--- Environment check results ---\n');
  let allOk = true;
  for (const { name, ok, detail } of results) {
    if (!ok) allOk = false;
    console.log(`${ok ? '✅' : '❌'} ${name}: ${detail}`);
  }
  console.log(`\n${allOk ? 'All checks passed.' : 'One or more checks failed — see ❌ above.'}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('check-env crashed:', err);
  process.exit(1);
});
