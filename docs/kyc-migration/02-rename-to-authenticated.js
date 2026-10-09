#!/usr/bin/env node
// NOT EXECUTED. Renames legacy public assets to type=authenticated. DRY RUN unless --execute AND CONFIRM=yes.
// usage: node 02-rename-to-authenticated.js inventory.csv [--execute]    (reads CLOUDINARY_* from the environment; never prints them)
const fs = require('fs');
const { readCsv, parseLegacyUrl, privateRef } = require('./lib');
const [file] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const execute = process.argv.includes('--execute') && process.env.CONFIRM === 'yes';
const verbose = process.argv.includes('--verbose');
if (!file) { console.error('inventory csv required'); process.exit(1); }
(async () => {
  // The cloudinary SDK is only needed (and loaded) for the real run; the dry run makes no network call at all.
  let cloudinary;
  if (execute) {
    cloudinary = require('cloudinary').v2;
    cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });
  }
  const counts = {};
  const bump = (r, status) => { const k = `${r.table}.${r.column} ${status}`; counts[k] = (counts[k] || 0) + 1; };
  const rows = readCsv(file);
  const out = ['table,column,id,old_value,new_value,status'];
  for (const r of rows) {
    const p = parseLegacyUrl(r.value);
    if (!p || p.cloud !== process.env.CLOUDINARY_CLOUD_NAME) { bump(r, 'SKIPPED'); out.push(`${r.table},${r.column},${r.id},${r.value},,SKIPPED_NOT_OUR_CLOUD_OR_UNPARSEABLE`); continue; }
    const ref = privateRef(p);
    if (!execute) { bump(r, 'WOULD_MOVE'); out.push(`${r.table},${r.column},${r.id},${r.value},${ref},DRY_RUN`); if (verbose) console.log(`[dry-run] ${r.table}.${r.column} ${r.id}: ${p.resourceType}/${p.publicId} -> authenticated`); continue; }
    try {
      await cloudinary.uploader.rename(p.publicId, p.publicId, { resource_type: p.resourceType, type: 'upload', to_type: 'authenticated', overwrite: false, invalidate: true });
      out.push(`${r.table},${r.column},${r.id},${r.value},${ref},RENAMED`); console.log(`renamed ${r.table}.${r.column} ${r.id}`);
    } catch (e) { out.push(`${r.table},${r.column},${r.id},${r.value},${ref},FAILED:${(e && e.message || 'error').replace(/[,\n]/g, ' ')}`); console.error(`FAILED ${r.table}.${r.column} ${r.id}`); }
  }
  fs.writeFileSync(execute ? 'mapping.csv' : 'mapping.dry.csv', out.join('\n') + '\n', { mode: 0o600 });
  for (const [k, n] of Object.entries(counts).sort()) console.log(`${k}: ${n}`);
  console.log(`total rows: ${rows.length}`);
  console.log(execute ? 'wrote mapping.csv' : 'DRY RUN only — wrote mapping.dry.csv, nothing was changed');
})();
