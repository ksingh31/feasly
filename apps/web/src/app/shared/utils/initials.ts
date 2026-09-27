/**
 * Avatar-initials utility (shared).
 *
 * First letters of the first and last whitespace-separated words,
 * uppercased. Used for lead avatars in the admin leads explorer.
 */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return '•';
  }
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
  return (first + last).toUpperCase();
}
