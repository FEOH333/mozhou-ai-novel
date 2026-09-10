// web/js/sse-registry.js —— 跟踪页面内并行 SSE 请求，路由切换时统一取消
'use strict';

export function registerAbortController(registry, controller) {
  if (!(registry instanceof Set)) throw new TypeError('registry must be a Set');
  if (!controller || typeof controller.abort !== 'function') throw new TypeError('controller must support abort()');
  registry.add(controller);
  return controller;
}

export function unregisterAbortController(registry, controller) {
  if (!(registry instanceof Set)) return false;
  return registry.delete(controller);
}

export function abortAllControllers(registry) {
  if (!(registry instanceof Set)) return 0;
  const controllers = [...registry];
  registry.clear();
  for (const controller of controllers) {
    try { controller.abort(); } catch { /* 已关闭的流不阻塞其他流取消 */ }
  }
  return controllers.length;
}
