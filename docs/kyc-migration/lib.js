// Shared helpers for the KYC migration scripts. NOT EXECUTED.
const fs = require('fs');
exports.readCsv = (file) => fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean).slice(1).map(l => {
  const [table, column, id, ...rest] = l.split(','); return { table, column, id, value: rest.join(',') };
});
// https://res.cloudinary.com/<cloud>/<resource_type>/upload/[s--sig--/][v123/]<public_id>[.<format>]
exports.parseLegacyUrl = (value) => {
  const m = /^https:\/\/res\.cloudinary\.com\/([^/]+)\/(image|video|raw)\/upload\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+)$/.exec(value);
  if (!m) return null;
  const [, cloud, resourceType, rest] = m;
  if (resourceType === 'raw') return { cloud, resourceType, format: null, publicId: rest };
  const dot = rest.lastIndexOf('.');
  return dot > 0 ? { cloud, resourceType, format: rest.slice(dot + 1), publicId: rest.slice(0, dot) } : { cloud, resourceType, format: null, publicId: rest };
};
exports.privateRef = ({ resourceType, format, publicId }) => `private:${resourceType}:${format || '-'}:${publicId}`;
exports.sqlQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
