const UPSTREAM_TIMEOUT_MS = 15000;
const UPSTREAM_MAX_BYTES = 2 * 1024 * 1024;

// 仅用于小型上游 JSON / 文本响应；音频仍走流式媒体代理。
async function upstreamRequest(url, options = {}, {
  timeoutMs = UPSTREAM_TIMEOUT_MS, maxBytes = UPSTREAM_MAX_BYTES, headersOnly = false,
} = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  let reader;
  const cancelReader = () => { reader?.cancel().catch(() => {}); };
  controller.signal.addEventListener('abort', cancelReader, { once: true });
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    controller.signal.throwIfAborted();
    if (!response.body) return response;
    if (headersOnly) {
      await response.body.cancel();
      return new Response(null, { status: response.status, headers: response.headers });
    }
    reader = response.body.getReader();
    const tooLarge = () => Object.assign(new Error('音乐平台返回的数据过大，请稍后重试'), { status: 502 });
    if (Number(response.headers.get('content-length')) > maxBytes) throw tooLarge();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(bytes, { status: response.status, headers: response.headers });
  } catch (error) {
    await reader?.cancel().catch(() => {});
    if (controller.signal.aborted) {
      throw Object.assign(new Error('音乐平台响应超时，请稍后重试'), { status: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', cancelReader);
    reader?.releaseLock();
  }
}

export { UPSTREAM_MAX_BYTES, UPSTREAM_TIMEOUT_MS, upstreamRequest };
