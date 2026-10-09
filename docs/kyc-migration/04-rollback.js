#!/usr/bin/env node
// NOT EXECUTED. Renames assets back to type=upload (public). DRY RUN unless --execute AND CONFIRM=yes.
// usage: node 04-rollback.js mapping.csv [--execute]
const fs = require('fs');
const { parseLegacyUrl } = require('./lib');
const execute = process.argv.includes('--execute') && process.env.CONFIRM === 'yes';
const file = process.argv.slice(2).find(a => !a.startsWith('--'));
(async () => {
  const cloudinary = require('cloudinary').v2;
  cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });
  const rows = fs.readFileSync(file, 'utf8').split('\n').slice(1).filter(Boolean).map(l => l.split(',')).filter(c => c[5] === 'RENAMED');
  for (const c of rows) {
    const p = parseLegacyUrl(c[3]); if (!p) continue;
    if (!execute) { console.log(`[dry-run] ${c[0]}.${c[1]} ${c[2]}: ${p.publicId} -> upload`); continue; }
    try { await cloudinary.uploader.rename(p.publicId, p.publicId, { resource_type: p.resourceType, type: 'authenticated', to_type: 'upload', overwrite: false, invalidate: true }); console.log(`restored ${c[0]}.${c[1]} ${c[2]}`); }
    catch (e) { console.error(`FAILED ${c[0]}.${c[1]} ${c[2]}: ${e && e.message}`); }
  }
  console.log(execute ? 'done' : 'DRY RUN only — nothing was changed');
})();
