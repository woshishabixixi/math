/* 文言文生词 · Service Worker（契约：SPEC.md §5）
 *
 * 规则：
 *  - 只处理同源请求；跨域请求一律不拦截、不缓存（应用本身不发请求）。
 *  - 导航请求 → cache-first 命中 index.html，未命中走网络。
 *  - 静态资源 → cache-first，未命中 fetch，仅 GET 且响应 ok 才写入缓存。
 *  - 预缓存逐条 try/catch：某个文件暂缺（例如还没生成）不能拖垮整个安装。
 */

const CACHE_VERSION = 'bio-v9';
const CACHE_PREFIX = 'math-';

const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './srs.js',
  './db.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

const NAVIGATION_FALLBACK = './index.html';

async function openCache() {
  try {
    return await caches.open(CACHE_VERSION);
  } catch (err) {
    return null;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await openCache();
      if (cache) {
        // 逐个添加：任何一个资源缺失只跳过它自己，整体安装仍然成功。
        await Promise.all(
          CORE_ASSETS.map(async (url) => {
            try {
              await cache.add(new Request(url, { cache: 'reload' }));
            } catch (err) {
              /* 该资源暂不可用，跳过 */
            }
          })
        );
      }
      try {
        await self.skipWaiting();
      } catch (err) {
        /* ignore */
      }
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
            .map((key) => caches.delete(key))
        );
      } catch (err) {
        /* ignore */
      }
      try {
        await self.clients.claim();
      } catch (err) {
        /* ignore */
      }
    })()
  );
});

function offlineText(message) {
  return new Response(message, {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const NETWORK_TIMEOUT_MS = 3000;

/** 联网时优先拿新的；超时或断网返回 null，交给缓存兜底 */
async function fetchWithTimeout(request) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
    const res = await fetch(request, { signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    return null;
  }
}

async function putCache(cache, key, response) {
  if (!cache || !response || !response.ok) return;
  try {
    await cache.put(key, response.clone());
  } catch (err) {
    /* 写缓存失败不影响响应 */
  }
}

async function handleNavigation(request) {
  const cache = await openCache();
  const res = await fetchWithTimeout(request);
  if (res && res.ok) {
    await putCache(cache, NAVIGATION_FALLBACK, res);
    await putCache(cache, request, res);
    return res;
  }
  if (cache) {
    try {
      const cached = (await cache.match(NAVIGATION_FALLBACK)) || (await cache.match('./'));
      if (cached) return cached;
    } catch (err) {
      /* ignore */
    }
  }
  return offlineText('当前离线，本地还没有缓存页面。请联网后再打开一次。');
}

async function handleAsset(request) {
  const cache = await openCache();
  const res = await fetchWithTimeout(request);
  if (res && res.ok) {
    await putCache(cache, request, res);
    return res;
  }
  if (cache) {
    try {
      const cached = await cache.match(request);
      if (cached) return cached;
    } catch (err) {
      /* ignore */
    }
  }
  if (res) return res;
  return offlineText('离线且该文件未缓存：' + new URL(request.url).pathname);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return; // 跨域：直接放行，不拦截
  if (request.method !== 'GET') return; // 非 GET：直接放行

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }
  event.respondWith(handleAsset(request));
});
