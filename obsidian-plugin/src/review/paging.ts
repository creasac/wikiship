export const SNAPSHOT_PAGE_SIZE = 50_000;

/** Keep every byte's decoded text inspectable without adding megabytes to the DOM. */
export function snapshotPage(text: string, requestedPage = 0, pageSize = SNAPSHOT_PAGE_SIZE) {
  if (!Number.isInteger(pageSize) || pageSize < 2) throw new Error('Snapshot page size must be an integer of at least 2.');
  const pageCount = Math.max(1, Math.ceil(text.length / pageSize));
  const page = Math.max(0, Math.min(pageCount - 1, Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0));
  const boundary = (offset: number) => {
    const bounded = Math.min(offset, text.length);
    if (bounded > 0 && bounded < text.length && (
      (/[\uD800-\uDBFF]/.test(text[bounded - 1]!) && /[\uDC00-\uDFFF]/.test(text[bounded]!)) ||
      (text[bounded - 1] === '\r' && text[bounded] === '\n')
    )) return bounded - 1;
    return bounded;
  };
  const from = boundary(page * pageSize), to = boundary((page + 1) * pageSize);
  return { page, pageCount, from, to, text: text.slice(from, to) };
}
