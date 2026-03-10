# sni-fetch

[![GitHub](https://img.shields.io/badge/GitHub-AfsalMadathingal%2Fsni--fetch-181717?style=flat&logo=github)](https://github.com/AfsalMadathingal/sni-fetch)
[![npm](https://img.shields.io/npm/v/sni-fetch?style=flat&logo=npm&color=CB3837)](https://www.npmjs.com/package/sni-fetch)

SNI bug-host tunneler for restricted container environments.

When your container blocks all internet access but allows traffic to specific domains (like `github.com` or `npmjs.com`), `sni-fetch` exploits the SNI (Server Name Indication) field in TLS to route requests to any HTTPS destination through those allowed hosts.

Works as both a **drop-in fetch-like API** and a **local HTTP/HTTPS proxy** that any tool (`npm`, `curl`, `axios`, etc.) can use.

## How It Works

TLS connections start with a `ClientHello` that contains the SNI field — the hostname the client wants to reach. Many CDNs (Cloudflare, Fastly, Akamai) host thousands of domains on the same IP. The firewall sees the TCP connection going to an allowed IP and passes it. The CDN reads the SNI and routes to the real target.

```
Container → TCP connect to github.com IP (allowed ✓)
          → TLS ClientHello SNI = "example.com"
          → CDN routes to example.com backend
          → Full HTTPS response ✓
```

> **Note:** This works when the bug host and target share a CDN. `github.com` (Fastly) and `npmjs.com` (Cloudflare) cover a large portion of the internet.

## Installation

```bash
# Local install (inside container)
npm install sni-fetch

# Global CLI install
npm install -g sni-fetch
```

If even `npm install` is blocked, copy the package in manually — it has **zero dependencies** and uses only Node.js built-ins (`tls`, `net`, `dns`, `http`).

## Programmatic API

```js
const sni = require('sni-fetch');

// GET
const res = await sni.get('https://api.example.com/users');
console.log(await res.text());

// GET with options
const res = await sni.get('https://api.example.com/data', {
  bugHost: 'github.com',     // which allowed host to tunnel through
  timeout: 10000,
});
console.log(res.json());

// POST JSON
const res = await sni.post('https://api.example.com/items', { name: 'foo' });
console.log(res.status); // 201

// PUT / PATCH / DELETE
await sni.put('https://api.example.com/items/1', { name: 'bar' });
await sni.patch('https://api.example.com/items/1', { name: 'baz' });
await sni.delete('https://api.example.com/items/1');

// Full control
const res = await sni.request('https://example.com/upload', {
  method: 'POST',
  body: Buffer.from('binary data'),
  headers: {
    'content-type': 'application/octet-stream',
    'x-api-key': 'secret',
  },
  bugHost: 'npmjs.com',
  bugPort: 443,
  timeout: 60000,
  maxRedirects: 3,
});
```

### Response Object

```js
res.status       // number — HTTP status code
res.statusText   // string — e.g. "OK"
res.headers      // object — lowercase header names
res.ok           // boolean — true if status 200–299
res.url          // string — final URL after redirects
res.text()       // string — response body as UTF-8
res.json()       // any    — parsed JSON body
res.buffer()     // Buffer — raw response body
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `bugHost` | string | `"github.com"` | Allowed host to connect to via TCP |
| `bugPort` | number | `443` | Port to connect to on bug host |
| `bugIp` | string | *(DNS resolved)* | Skip DNS, use a specific IP |
| `method` | string | `"GET"` | HTTP method |
| `headers` | object | `{}` | Additional request headers |
| `body` | string \| object \| Buffer | — | Request body (objects are JSON-serialized) |
| `timeout` | number | `30000` | Connection timeout in milliseconds |
| `maxRedirects` | number | `5` | Max redirects to follow (`0` to disable) |
| `userAgent` | string | `"sni-fetch/1.0"` | Custom User-Agent header |

## Proxy Mode (Recommended for Containers)

Start a local HTTP/HTTPS proxy server, then point all tools at it. This is the most powerful mode — you don't need to change any code.

### Start the proxy

```js
const sni = require('sni-fetch');

const { port } = await sni.startProxy(8118, {
  bugHost: 'github.com',
  verbose: true,
});
// Prints: Listening on http://127.0.0.1:8118
```

Or via CLI:

```bash
sni-fetch proxy --port 8118 --bug-host github.com
```

### Use the proxy

```bash
export HTTP_PROXY=http://127.0.0.1:8118
export HTTPS_PROXY=http://127.0.0.1:8118
export NODE_TLS_REJECT_UNAUTHORIZED=0   # needed because cert is re-wrapped

# Now everything works:
npm install express
curl https://example.com
wget https://files.example.com/archive.tar.gz
```

### Proxy in Node.js apps

With a global agent (e.g. using `https-proxy-agent`):

```js
process.env.HTTPS_PROXY = 'http://127.0.0.1:8118';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
// axios, node-fetch, got — all pick this up automatically
```

### Dockerfile example

```dockerfile
FROM node:20-alpine

# Copy sni-fetch in (or install from npm if npm is allowed to npmjs.com)
COPY sni-fetch /app/sni-fetch
RUN cd /app/sni-fetch && npm link

# Start proxy and your app
CMD sni-fetch proxy --port 8118 --bug-host github.com & \
    sleep 1 && \
    HTTP_PROXY=http://127.0.0.1:8118 \
    HTTPS_PROXY=http://127.0.0.1:8118 \
    NODE_TLS_REJECT_UNAUTHORIZED=0 \
    node /app/server.js
```

## CLI Reference

```bash
sni-fetch <url> [options]
sni-fetch proxy [options]
```

### Request

```bash
# Basic GET
sni-fetch https://example.com

# Use a different bug host
sni-fetch https://example.com --bug-host npmjs.com

# POST with JSON body
sni-fetch https://httpbin.org/post \
  -X POST \
  -d '{"hello":"world"}' \
  -H 'content-type:application/json' \
  --json

# Custom headers
sni-fetch https://api.example.com/data \
  -H 'authorization:Bearer token123' \
  -H 'accept:application/json' \
  --json

# Show response headers
sni-fetch https://example.com --include

# Save to file
sni-fetch https://example.com/archive.zip -o archive.zip

# Silent mode (body only, no status output)
sni-fetch https://example.com -s

# Use specific IP (bypass DNS entirely)
sni-fetch https://example.com --bug-host github.com --bug-ip 140.82.121.4
```

### Proxy

```bash
# Start proxy on default port 8118
sni-fetch proxy

# Custom port and bug host
sni-fetch proxy --port 9000 --bug-host npmjs.com --verbose
```

### All CLI flags

```
--method, -X <method>       HTTP method (default: GET)
--data, -d <body>           Request body
--header, -H <key:value>    Add header (repeatable)
--bug-host <host>           Bug host (default: github.com)
--bug-port <port>           Bug host port (default: 443)
--bug-ip <ip>               Skip DNS, use specific IP
--no-verify                 Disable TLS cert verification
--max-redirects <n>         Max redirects (default: 5)
--timeout <ms>              Timeout ms (default: 30000)
--output, -o <file>         Write body to file
--include, -i               Print response headers
--silent, -s                Body only, no status output
--json                      Pretty-print JSON response
--port, -p <port>           Proxy port (proxy mode, default: 8118)
--verbose, -v               Verbose proxy logging
```

## Bug Host Selection Guide

Different bug hosts cover different CDNs. If one doesn't work for your target, try another.

| Bug Host | CDN | Good for |
|---|---|---|
| `github.com` | Fastly | Most developer APIs, JS/CSS CDNs |
| `npmjs.com` | Cloudflare | Cloudflare-hosted sites (huge portion of the web) |
| `cdn.jsdelivr.net` | Cloudflare + Fastly | Static assets |

To find what CDN a target uses:

```bash
curl -sI https://target.com | grep -i server
# or check: https://www.whatcdn.com/
```

## Troubleshooting

**Connection times out**
- The bug host and target are on different CDNs/IPs. Try a different `--bug-host`.
- The firewall blocks outbound 443 entirely. Try `--bug-port 80` if HTTP is open.

**SSL certificate errors**
- Expected — the CDN presents the correct cert for the target domain, but Node may still complain. Use `NODE_TLS_REJECT_UNAUTHORIZED=0` or `--no-verify`.

**Empty response**
- The target returned a non-standard response. Try `--include` to see headers.

**Only works for HTTPS**
- SNI is a TLS feature, so only HTTPS targets are supported. HTTP targets work in proxy mode via plain forwarding.

## License

MIT
