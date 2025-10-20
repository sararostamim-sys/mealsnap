// Single source of truth for "current user" during dev.
// Reads NEXT_PUBLIC_DEV_USER_ID so it works on client + server.
export function getDevUserId(): string {
  const id = process.env.NEXT_PUBLIC_DEV_USER_ID;
  if (!id) {
    throw new Error('Missing NEXT_PUBLIC_DEV_USER_ID in .env.local');
  }
  return id;
}