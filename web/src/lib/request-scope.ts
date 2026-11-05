/** One active request per operation. A late response has no authority after cancellation. */
export function createRequestScope() {
  let controller: AbortController | null = null;
  return {
    begin() {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      return { signal: request.signal, isCurrent: () => controller === request && !request.signal.aborted };
    },
    cancel() { controller?.abort(); controller = null; },
  };
}
