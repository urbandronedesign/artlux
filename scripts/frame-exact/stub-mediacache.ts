// Stub for @/services/mediaCache in the standalone harness: the page registers blob URLs up front.
export function resolveMediaUrl(p: string): string | null {
  const m = (globalThis as unknown as { __mediaUrls?: Record<string, string> }).__mediaUrls;
  return (m && m[p]) || null;
}
