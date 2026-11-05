// Only terminal transfer state is reported; upstream URLs and exception messages stay out of telemetry.
function trackMediaTransfer(response, onComplete = () => {}, onFailure = () => {}) {
  if (!response.ok || !response.body) return response;
  const reader = response.body.getReader();
  const rawLength = response.headers.get('content-length');
  const expected = /^\d+$/.test(rawLength || '') && Number.isSafeInteger(Number(rawLength))
    ? Number(rawLength) : null;
  const fixed = expected !== null && typeof globalThis.FixedLengthStream === 'function'
    ? new globalThis.FixedLengthStream(expected) : null;
  let received = 0;
  let finished = false;
  function notify(failure) {
    if (finished) return;
    finished = true;
    try {
      if (failure) onFailure(failure);
      else onComplete();
    } catch (_) {
      // A statistics/telemetry callback must not break an otherwise valid media response.
      console.warn('[Media transfer] callback failed');
    }
  }
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (finished) return;
        if (chunk.done) {
          if (expected !== null && received !== expected) throw new Error('Media length mismatch');
          reader.releaseLock();
          controller.close();
          if (!fixed) notify();
          return;
        }
        received += chunk.value.byteLength;
        if (expected !== null && received > expected) throw new Error('Media length mismatch');
        controller.enqueue(chunk.value);
      } catch (error) {
        if (finished) return;
        notify('stream_read');
        controller.error(error);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      notify('cancelled');
      await reader.cancel(reason).catch(() => {});
      reader.releaseLock();
    },
  }, { highWaterMark: 0 });
  // Workers uses FixedLengthStream to retain Content-Length. Completion follows the full pipe,
  // so a rejected final write never counts as a successful playback request.
  if (fixed) stream.pipeTo(fixed.writable).then(() => notify(), () => notify('stream_read'));
  return new Response(fixed?.readable || stream, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}

export { trackMediaTransfer };
