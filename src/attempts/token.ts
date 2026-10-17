import { createHash, randomBytes } from 'node:crypto';

/** 256-bit random attempt secret. Only its SHA-256 hash is stored. */
export function generateAttemptToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashAttemptToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 144-bit unguessable token for public test links. */
export function generateShareToken(): string {
  return randomBytes(18).toString('base64url');
}

export const ATTEMPT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
