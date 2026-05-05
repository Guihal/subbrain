/**
 * Paginated API envelope.
 *
 * Any list endpoint that supports pagination should shape its response as
 * `PaginatedResponse<T>` and build it via `paginate()`. Standardizes
 * `{items, total, page, page_size}` across memory / chats / logs, so the
 * frontend can rely on a single shape.
 */

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface PaginateOpts {
  page?: number | string;
  page_size?: number | string;
  limit?: number | string;
  offset?: number | string;
  q?: string;
  [key: string]: unknown;
}

export type PaginateLoader<T> = (
  limit: number,
  offset: number,
  q?: string,
) => { items: T[]; total: number } | Promise<{ items: T[]; total: number }>;

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 20;

export async function paginate<T>(
  loader: PaginateLoader<T>,
  opts: PaginateOpts,
): Promise<PaginatedResponse<T>> {
  // Q-12: cap query length at 500 chars — sanitizeFtsQuery already limits
  // term count but the raw string is still allocated downstream.
  const MAX_Q_LEN = 500;
  const rawQ = typeof opts.q === "string" ? opts.q.trim().slice(0, MAX_Q_LEN) : "";
  const q = rawQ.length > 0 ? rawQ : undefined;

  // Prefer explicit page/page_size; fall back to limit/offset if given.
  let page: number;
  let pageSize: number;

  const limitNum = toInt(opts.limit);
  const offsetNum = toInt(opts.offset);
  if (limitNum === undefined) {
    pageSize = clamp(toInt(opts.page_size) ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    page = Math.max(1, toInt(opts.page) ?? 1);
  } else {
    pageSize = clamp(limitNum, 1, MAX_PAGE_SIZE);
    const off = offsetNum ?? 0;
    page = Math.floor(off / pageSize) + 1;
  }

  const offset = (page - 1) * pageSize;
  const { items, total } = await loader(pageSize, offset, q);
  return { items, total, page, page_size: pageSize };
}

function toInt(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
