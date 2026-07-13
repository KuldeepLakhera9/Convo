/**
 * api.ts — Central API base URL helper
 *
 * In development: VITE_API_URL is empty, so fetch goes to '' (same origin)
 * and Vite's dev proxy forwards /api/* to localhost:3002.
 *
 * In production (Vercel): VITE_API_URL is set to the Railway API URL,
 * so all fetch calls go directly to the correct backend.
 */

const API_BASE = import.meta.env.VITE_API_URL ?? '';

/**
 * Makes an authenticated or unauthenticated fetch to the API.
 * Automatically prefixes with VITE_API_URL in production.
 *
 * Usage:
 *   apiFetch('/api/auth/login', { method: 'POST', body: ... })
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}${path}`, init);
}
