import { randomBytes } from "node:crypto";

// 32 symbols, so `byte & 31` maps bytes uniformly (no modulo bias).
// Lowercase only: the id becomes part of a namespace name (DNS label).
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** 16 chars = 80 bits of randomness; URL-safe and namespace-safe. */
export function newLabId(): string {
  return Array.from(randomBytes(16), (b) => ALPHABET.charAt(b & 31)).join("");
}

/** Accepts generated ids and hand-written ones (e.g. the Phase 1 demo lab). */
export const LAB_ID_RE = /^[a-z0-9]{12,32}$/;

export const labNamespace = (labId: string): string => `lab-${labId}`;
