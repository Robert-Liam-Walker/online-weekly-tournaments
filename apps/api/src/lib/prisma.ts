/**
 * prisma.ts — Prisma client singleton.
 *
 * Purpose: Export a single shared PrismaClient instance for all API routes and
 * lib modules. Multiple PrismaClient instances in one process open separate
 * connection pools, so a singleton is critical for connection hygiene.
 *
 * Hot-reload safety (development): In development (tsx --watch), each file-
 * level module re-execution would create a new PrismaClient. The globalThis
 * guard persists the instance across hot-reloads by stashing it on the global
 * object. In production the guard is skipped — module caching is stable under
 * Node.js and there is no hot-reload, so a new instance is never created.
 *
 * Key exports:
 *   prisma — the shared PrismaClient; import this everywhere.
 *
 * Invariants:
 *   - Never instantiate PrismaClient directly in application code; always
 *     import `prisma` from this module.
 *   - `$transaction` is the correct way to batch mutations atomically; callers
 *     that need serialized read-modify-write must also hold the per-tournament
 *     Redis lock (see lib/tournamentLock.ts).
 */
import { PrismaClient } from "@prisma/client";

declare global {
  var __prisma: PrismaClient | undefined;
}

export const prisma = globalThis.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}
