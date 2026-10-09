#!/usr/bin/env node
// NOT EXECUTED. Generates the guarded UPDATE (and the rollback UPDATE) from mapping.csv. Prints SQL; applies nothing.
// usage: node 03-generate-db-update.js mapping.csv > 03-db-update.NOT-EXECUTED.sql   (rollback SQL is written to 04-rollback-db.NOT-EXECUTED.sql)
const fs = require('fs');
const { sqlQuote } = require('./lib');
const rows = fs.readFileSync(process.argv[2], 'utf8').split('\n').slice(1).filter(Boolean).map(l => l.split(',')).filter(c => c[5] === 'RENAMED');
const stmt = (r, from, to) => {
  const [table, column, id, , ] = r;
  if (table === 'provider_profiles' && column === 'certUrls') { const [pid] = id.split('#'); return `UPDATE provider_profiles SET "certUrls" = array_replace("certUrls", ${sqlQuote(from)}, ${sqlQuote(to)}) WHERE id = ${sqlQuote(pid)};`; }
  return `UPDATE ${table} SET "${column}" = ${sqlQuote(to)} WHERE id = ${sqlQuote(id)} AND "${column}" = ${sqlQuote(from)};`;
};
console.log('-- NOT EXECUTED. Review, then run inside one transaction after the Cloudinary rename succeeded.\nBEGIN;');
for (const r of rows) console.log(stmt(r, r[3], r[4]));
console.log('-- Expect the affected-row count of each statement to be 1; otherwise ROLLBACK.\nCOMMIT;');
const rb = ['-- NOT EXECUTED. Restores the old public URLs (use together with 04-rollback.js).', 'BEGIN;', ...rows.map(r => stmt(r, r[4], r[3])), 'COMMIT;'];
fs.writeFileSync('04-rollback-db.NOT-EXECUTED.sql', rb.join('\n') + '\n');
