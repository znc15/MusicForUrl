import worker from '../cloudflare/src/index.js';

export function onRequest(context) {
  return worker.fetch(context.request, {
    ...context.env, ASSETS: { fetch: request => context.next(request) },
  }, { waitUntil: promise => context.waitUntil(promise) });
}
