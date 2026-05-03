// cf_worker.js

const CONFIG = {
    ALLOWED_ORIGINS: ['https://anizen.site'], // Edit this
    DEFAULT_REFERER: 'https://animekai.la',
    ANIMEKAI_BASE: 'https://animekai.la',
    DEFAULT_USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    FORWARD_HEADERS: ['range', 'if-match', 'if-none-match', 'if-modified-since', 'authorization'],
    UPSTREAM_HEADERS: ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'],
    CORS: {
        ALLOW_METHODS: 'GET, POST, OPTIONS, HEAD',
        ALLOW_HEADERS: 'Content-Type, X-Requested-With, Range, Authorization',
        EXPOSE_HEADERS: 'Content-Range, Content-Length, Accept-Ranges, Content-Type',
        ALLOW_CREDENTIALS: 'true'
    },
    CACHE_CONTROL: 'no-store, no-cache, must-revalidate, proxy-revalidate'
};

function isOriginAllowed(origin) {
    if (CONFIG.ALLOWED_ORIGINS.includes('*')) return true;
    if (!origin) return true;
    return CONFIG.ALLOWED_ORIGINS.includes(origin);
}

function setCorsHeaders(origin, headers) {
    headers.set('Access-Control-Allow-Origin', origin || '*');
    headers.set('Access-Control-Allow-Methods', CONFIG.CORS.ALLOW_METHODS);
    headers.set('Access-Control-Allow-Headers', CONFIG.CORS.ALLOW_HEADERS);
    headers.set('Access-Control-Expose-Headers', CONFIG.CORS.EXPOSE_HEADERS);
    headers.set('Access-Control-Allow-Credentials', CONFIG.CORS.ALLOW_CREDENTIALS);
    headers.set('Cache-Control', CONFIG.CACHE_CONTROL);
    headers.set('X-Proxy-By', 'm3u8-proxy');
}

function buildUpstreamHeaders(reqHeaders, url, headersParam) {
    const headers = {
        'User-Agent': CONFIG.DEFAULT_USER_AGENT,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
    };

    CONFIG.FORWARD_HEADERS.forEach(h => {
        const val = reqHeaders.get(h);
        if (val) headers[h] = val;
    });

    let referer = CONFIG.DEFAULT_REFERER;

    if (headersParam) {
        try {
            const extra = JSON.parse(headersParam);
            Object.entries(extra).forEach(([k, v]) => {
                const lk = k.toLowerCase();
                headers[lk] = v;
                if (lk === 'referer' || lk === 'referrer') referer = v;
            });
        } catch (e) {}
    }

    if (url.hostname.includes('megaup') || url.hostname.includes('shop21pro')) {
        referer = CONFIG.ANIMEKAI_BASE + '/';
        headers['Sec-Fetch-Dest'] = 'iframe';
        headers['Sec-Fetch-Mode'] = 'navigate';
        headers['Sec-Fetch-Site'] = 'cross-site';
    } else {
        headers['Sec-Fetch-Dest'] = 'empty';
        headers['Sec-Fetch-Mode'] = 'cors';
        headers['Sec-Fetch-Site'] = 'cross-site';
    }

    headers['referer'] = referer;
    try {
        headers['origin'] = new URL(referer).origin;
    } catch (e) {
        headers['origin'] = referer;
    }

    return headers;
}

function generateProxyUrl(baseUrl, targetUrl, headersParam) {
    let proxyUrl = `${baseUrl}/m3u8-proxy?url=${encodeURIComponent(targetUrl)}`;
    if (headersParam) proxyUrl += `&headers=${encodeURIComponent(headersParam)}`;
    return proxyUrl;
}

function proxyPlaylistContent(content, url, baseUrl, headersParam) {
    return content.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#EXTM3U') || trimmed.startsWith('#EXT-X-VERSION')) return line;

        if (trimmed.startsWith('#')) {
            return line.replace(/(URI\s*=\s*")([^"]+)(")/gi, (match, prefix, uri, suffix) => {
                try {
                    const abs = new URL(uri, url.href).href;
                    return `${prefix}${generateProxyUrl(baseUrl, abs, headersParam)}${suffix}`;
                } catch (e) { return match; }
            });
        }

        try {
            const abs = new URL(trimmed, url.href).href;
            return generateProxyUrl(baseUrl, abs, headersParam);
        } catch (e) { return line; }
    }).join('\n');
}

export default {
    async fetch(request) {
        const reqUrl = new URL(request.url);
        const origin = request.headers.get('Origin') || '';
        const baseUrl = reqUrl.origin;

        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            const headers = new Headers();
            setCorsHeaders(origin, headers);
            return new Response(null, { status: 204, headers });
        }

        if (!isOriginAllowed(origin)) {
            return new Response(`Origin "${origin}" is not allowed.`, { status: 403 });
        }

        // Proxy endpoint
        if (reqUrl.pathname === '/m3u8-proxy') {
            const urlStr = reqUrl.searchParams.get('url');
            if (!urlStr) return new Response('URL is required', { status: 400 });

            let url;
            try { url = new URL(urlStr); } catch (e) {
                return new Response('Invalid URL', { status: 400 });
            }

            const headersParam = reqUrl.searchParams.get('headers') || '';
            const upstreamHeaders = buildUpstreamHeaders(request.headers, url, headersParam);

            try {
                const upstreamRes = await fetch(url.href, {
                    method: 'GET',
                    headers: upstreamHeaders,
                });

                const resHeaders = new Headers();
                setCorsHeaders(origin, resHeaders);

                const contentType = upstreamRes.headers.get('content-type') || '';
                const isPlaylist = url.pathname.toLowerCase().endsWith('.m3u8') ||
                    contentType.includes('mpegURL') ||
                    contentType.includes('application/x-mpegurl');

                if (isPlaylist) {
                    const text = await upstreamRes.text();
                    const proxied = proxyPlaylistContent(text, url, baseUrl, headersParam);
                    resHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
                    return new Response(proxied, { status: 200, headers: resHeaders });
                } else {
                    CONFIG.UPSTREAM_HEADERS.forEach(h => {
                        const val = upstreamRes.headers.get(h);
                        if (val) resHeaders.set(h, val);
                    });
                    return new Response(upstreamRes.body, {
                        status: upstreamRes.status,
                        headers: resHeaders,
                    });
                }
            } catch (err) {
                return new Response(JSON.stringify({ error: err.message }), {
                    status: 502,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        return new Response('AnimeKai M3U8 Proxy (CF Worker) is running.', { status: 200 });
    }
};