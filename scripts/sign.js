#!/usr/bin/env node
'use strict';

// Signs index.json for publishing: stamps updatedAt, rewrites the file in the
// canonical format, validates it, writes index.json.sig and verifies it.
//
//   node scripts/sign.js              stamp updatedAt with the current time
//   node scripts/sign.js --keep-date  sign as is
//
// The private key never lives in this repository. It is read from the macOS
// login keychain item "multicc-plugin-catalog-signing" (base64 PKCS#8 DER),
// or from the MULTICC_CATALOG_SIGNING_KEY environment variable in the same
// format. MultiCC refuses a list older than the one it has cached, so
// updatedAt must move forward with every publish.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { validate, verifySignature } = require('./validate');

const ROOT = path.join(__dirname, '..');
const KEY_ID = 'catalog-2026-10';
const KEYCHAIN_SERVICE = 'multicc-plugin-catalog-signing';

function privateKey() {
  let encoded = process.env.MULTICC_CATALOG_SIGNING_KEY || '';
  if (!encoded && process.platform === 'darwin') {
    encoded = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8' }).trim();
  }
  if (!encoded) throw new Error(`no signing key: set MULTICC_CATALOG_SIGNING_KEY or add the keychain item ${KEYCHAIN_SERVICE}`);
  return crypto.createPrivateKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'pkcs8' });
}

function main(argv) {
  const file = path.join(ROOT, 'index.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!argv.includes('--keep-date')) {
    const previous = Date.parse(data.updatedAt) || 0;
    data.updatedAt = new Date(Math.max(Date.now(), previous + 1000)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const problems = validate(text);
  if (problems.length) throw new Error(`index.json has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  const signature = crypto.sign(null, Buffer.from(text), privateKey()).toString('base64');
  const sigText = `${JSON.stringify({ schema: 1, keyId: KEY_ID, signature }, null, 2)}\n`;
  verifySignature(text, sigText, JSON.parse(fs.readFileSync(path.join(ROOT, 'keys.json'), 'utf8')));
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(ROOT, 'index.json.sig'), sigText);
  console.log(`signed index.json (${data.plugins.length} plugins, updatedAt ${data.updatedAt}, key ${KEY_ID})`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
