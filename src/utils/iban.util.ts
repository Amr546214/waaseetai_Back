// Standard ISO 13616 IBAN structure + mod-97 checksum. Same algorithm as
// provider-profile.service.ts's own private isValidIban() (kept there
// untouched) — extracted as a shared util so the affiliate/marketer path
// (which had no IBAN validation anywhere, frontend or backend) can enforce
// the same real check instead of accepting any string.
export function isValidIban(value: string): boolean {
  const iban = String(value || '').replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  const numeric = rearranged.replace(/[A-Z]/g, char => String(char.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}
