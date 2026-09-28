/**
 * Password hashing adapter (auth/01).
 *
 * bcryptjs (pure JS) — NOT argon2. The API ships as esbuild-bundled
 * self-contained Function bundles, and native modules (argon2's .node
 * binary) do not survive that bundling. bcryptjs bundles cleanly and at
 * 10 rounds costs ~250ms per hash+verify, which is fine for the
 * invite-accept and sign-in paths (never in a hot loop).
 *
 * Rounds come from config (PASSWORD_BCRYPT_ROUNDS, default 10 — the OWASP
 * minimum). The dummy hash below is a real bcrypt hash of a random value;
 * it is NOT a secret — it exists so unknown-email verifications cost the
 * same as real ones (no timing oracle).
 */
import bcrypt from 'bcryptjs';

/** bcrypt hash of a random filler — timing equalizer, not a credential. */
export const DUMMY_PASSWORD_HASH =
  '$2b$10$umhpE3CCcVDmbk4r8smRk.GjSZMcRLgLianmVo/8rTDGrM7br1C5O';

export async function hashPassword(
  password: string,
  rounds: number,
): Promise<string> {
  return bcrypt.hash(password, rounds);
}

/** Constant-time-ish compare (bcrypt's own compare). */
export async function verifyPasswordHash(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
