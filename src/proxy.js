'use strict';

/**
 * Local HTTP/HTTPS proxy server using SNI tunneling.
 *
 * Start this proxy, then export:
 *   HTTP_PROXY=http://127.0.0.1:<port>
 *   HTTPS_PROXY=http://127.0.0.1:<port>
 *   NODE_TLS_REJECT_UNAUTHORIZED=0
 *
 * All tools (npm, curl, fetch, axios…) will route through this proxy,
 * which uses the SNI bug to reach blocked hosts.
 *
 * If the container itself requires an upstream HTTP proxy, set:
 *   SNI_UPSTREAM_PROXY=http://21.0.0.x:15004
 * or pass upstreamProxy in options. The proxy will CONNECT through it
 * before doing the TLS/SNI upgrade.
 */

const net = require('net');
const http = require('http');
const { URL } = require('url');
const { resolveBugHostIp, connectViaSni, DEFAULT_BUG_HOSTS } = require('./request');

function log(verbose, ...args) {
  if (verbose) console.error('[sni-proxy]', ...args);
}

async function handleConnect(clientSocket, host, port, options) {
  const bugHost = options.bugHost || DEFAULT_BUG_HOSTS[0];
  const bugPort = options.bugPort || 443;
  const verbose = options.verbose || false;

  log(verbose, `CONNECT ${host}:${port} → SNI bug host ${bugHost}`);

  let bugIp;
  try {
    bugIp = options.bugIp || (await resolveBugHostIp(bugHost));
    log(verbose, `Resolved ${bugHost} → ${bugIp}`);
  } catch (err) {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.destroy();
    log(verbose, `IP resolve failed: ${err.message}`);
    return;
  }

  let remoteSocket;
  try {
    // connectViaSni handles both direct and upstream-proxy modes
    remoteSocket = await connectViaSni(bugIp, bugPort, bugHost, host, options);
    log(verbose, `Tunnel open: ${host}:${port} (via ${bugIp})`);
  } catch (err) {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.destroy();
    log(verbose, `SNI connect failed for ${host}: ${err.message}`);
    return;
  }

  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

  clientSocket.pipe(remoteSocket);
  remoteSocket.pipe(clientSocket);

  const cleanup = () => {
    clientSocket.destroy();
    remoteSocket.destroy();
  };

  clientSocket.on('error', cleanup);
  remoteSocket.on('error', cleanup);
  clientSocket.on('close', cleanup);
  remoteSocket.on('close', cleanup);
}

async function handleHttpRequest(req, res, options) {
  const targetUrl = req.url;
  const bugHost = options.bugHost || DEFAULT_BUG_HOSTS[0];
  const verbose = options.verbose || false;

  log(verbose, `HTTP ${req.method} ${targetUrl}`);

  try {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const host = parsed.hostname;
    const path = (parsed.pathname || '/') + (parsed.search || '');

    const bugIp = options.bugIp || (await resolveBugHostIp(bugHost));

    const reqBodyChunks = [];
    req.on('data', (c) => reqBodyChunks.push(c));
    await new Promise((resolve) => req.on('end', resolve));
    const reqBody = Buffer.concat(reqBodyChunks);

    const doRequest = (socket) =>
      new Promise((resolve, reject) => {
        const headers = { ...req.headers, host };
        delete headers['proxy-connection'];
        delete headers['proxy-authorization'];

        let rawReq = `${req.method} ${path} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(headers)) {
          rawReq += `${k}: ${v}\r\n`;
        }
        rawReq += '\r\n';

        const parts = [Buffer.from(rawReq, 'ascii')];
        if (reqBody.length) parts.push(reqBody);
        socket.write(Buffer.concat(parts));

        const chunks = [];
        socket.on('data', (c) => chunks.push(c));
        socket.on('end', () => resolve(Buffer.concat(chunks)));
        socket.on('error', reject);
      });

    let rawResponse;
    if (isHttps) {
      // Use connectViaSni which handles upstream proxy automatically
      const sock = await connectViaSni(bugIp, options.bugPort || 443, bugHost, host, options);
      rawResponse = await doRequest(sock);
      sock.destroy();
    } else {
      // Plain HTTP: connect directly (or via upstream proxy if set)
      const { getUpstreamProxy } = require('./request');
      const upstream = getUpstreamProxy(options);

      const sock = await new Promise((resolve, reject) => {
        const target = upstream || { host: bugIp, port: 80 };
        const s = net.connect(target);
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      });
      rawResponse = await doRequest(sock);
      sock.destroy();
    }

    res.socket.write(rawResponse);
    res.socket.end();
  } catch (err) {
    log(verbose, `HTTP proxy error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end(`SNI proxy error: ${err.message}`);
    }
  }
}

function createProxy(options = {}) {
  const server = http.createServer();

  server.on('connect', (req, clientSocket, head) => {
    const [host, portStr] = req.url.split(':');
    const port = parseInt(portStr, 10) || 443;

    if (head && head.length > 0) clientSocket.unshift(head);

    handleConnect(clientSocket, host, port, options).catch((err) => {
      console.error('[sni-proxy] Unhandled connect error:', err.message);
    });
  });

  server.on('request', (req, res) => {
    if (req.url && req.url.startsWith('http')) {
      handleHttpRequest(req, res, options).catch((err) => {
        console.error('[sni-proxy] Unhandled request error:', err.message);
      });
    } else {
      res.writeHead(400);
      res.end('Only proxy requests supported');
    }
  });

  return server;
}

function startProxy(port = 8118, options = {}) {
  const server = createProxy(options);

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (options.verbose !== false) {
        console.log(`[sni-proxy] Listening on http://127.0.0.1:${addr.port}`);
        console.log(`[sni-proxy] Bug host  : ${options.bugHost || DEFAULT_BUG_HOSTS[0]}`);
        if (options.upstreamProxy) {
          console.log(`[sni-proxy] Upstream  : ${options.upstreamProxy}`);
        } else if (process.env.SNI_UPSTREAM_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
          console.log(`[sni-proxy] Upstream  : ${process.env.SNI_UPSTREAM_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY} (from env)`);
        }
        console.log(`\nSet these env vars to route all traffic through this proxy:`);
        console.log(`  export HTTP_PROXY=http://127.0.0.1:${addr.port}`);
        console.log(`  export HTTPS_PROXY=http://127.0.0.1:${addr.port}`);
        console.log(`  export NODE_TLS_REJECT_UNAUTHORIZED=0`);
      }
      resolve({ server, port: addr.port });
    });
    server.on('error', reject);
  });
}

module.exports = { createProxy, startProxy };
