'use strict';

const tls = require('tls');
const net = require('net');
const { URL } = require('url');
const { spawn } = require('child_process');

const DEFAULT_BUG_HOSTS = ['github.com', 'npmjs.com'];

/**
 * Resolve a hostname to an IPv4 address using curl -sv, which works even
 * when the container's DNS is blocked. Parses the "* Trying x.x.x.x" line
 * from curl's verbose stderr output.
 */
async function resolveBugHostIp(bugHost) {
  return new Promise((resolve, reject) => {
    const proc = spawn('curl', [
      '-sv',
      '--connect-timeout', '5',
      '--max-time', '6',
      `https://${bugHost}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    let resolved = false;

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      // curl prints "* Trying 1.2.3.4:443..." on stderr
      const match = stderr.match(/\*\s+Trying\s+([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/);
      if (match && !resolved) {
        resolved = true;
        proc.kill('SIGTERM');
        resolve(match[1]);
      }
    });

    proc.on('close', () => {
      if (!resolved) {
        reject(new Error(
          `Could not resolve IP for "${bugHost}" via curl.\n` +
          `stderr: ${stderr.slice(0, 300)}`
        ));
      }
    });

    proc.on('error', (err) => {
      if (!resolved) {
        reject(new Error(`curl not available: ${err.message}. Install curl or pass bugIp directly.`));
      }
    });
  });
}

/**
 * Parse upstream proxy from options or environment variables.
 * Returns { host, port } or null if no upstream proxy is configured.
 */
function getUpstreamProxy(options) {
  if (options.upstreamProxy) {
    const u = new URL(options.upstreamProxy);
    return { host: u.hostname, port: parseInt(u.port, 10) || 8080, auth: u.username && u.password ? `${u.username}:${u.password}` : null };
  }

  const proxyEnv =
    process.env.SNI_UPSTREAM_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;

  if (proxyEnv) {
    try {
      const u = new URL(proxyEnv);
      return { host: u.hostname, port: parseInt(u.port, 10) || 8080, auth: u.username && u.password ? `${u.username}:${u.password}` : null };
    } catch { /* ignore malformed */ }
  }

  return null;
}

/**
 * Open a TLS socket to targetHostname using the SNI trick.
 *
 * Two modes:
 *  1. Direct (no upstream proxy): tls.connect to bugIp:bugPort with servername=targetHostname
 *  2. Via upstream HTTP proxy: net.connect to proxy → CONNECT bugIp:bugPort → tls upgrade
 *
 * The upstream proxy (mode 2) is what container environments need when only
 * plain-HTTP traffic on a specific port is allowed out.
 */
async function connectViaSni(bugIp, bugPort, bugHost, targetHostname, options = {}) {
  const timeout = options.timeout || 30000;
  const upstream = getUpstreamProxy(options);

  let rawSocket;

  if (upstream) {
    // Step 1: plain TCP to the upstream HTTP proxy
    rawSocket = await new Promise((resolve, reject) => {
      const sock = net.connect({ host: upstream.host, port: upstream.port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`Upstream proxy connect timeout (${upstream.host}:${upstream.port})`));
      }, timeout);
      sock.once('connect', () => { clearTimeout(timer); resolve(sock); });
      sock.once('error', (err) => { clearTimeout(timer); reject(err); });
    });

    // Step 2: send HTTP CONNECT to ask the proxy to tunnel to bugIp:bugPort
    await new Promise((resolve, reject) => {
      rawSocket.write(
        `CONNECT ${bugHost}:${bugPort} HTTP/1.1\r\n` +
        `Host: ${bugHost}:${bugPort}\r\n` +
        (upstream.auth ? `Proxy-Authorization: Basic ${Buffer.from(upstream.auth).toString('base64')}\r\n` : '') +
        `\r\n`
      );

      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString('ascii');
        if (buf.includes('\r\n\r\n')) {
          rawSocket.removeListener('data', onData);
          const statusMatch = buf.match(/HTTP\/\d\.?\d?\s+(\d+)/);
          if (statusMatch && statusMatch[1] === '200') {
            resolve();
          } else {
            reject(new Error(`Upstream proxy CONNECT failed: ${buf.split('\r\n')[0]}`));
          }
        }
      };
      rawSocket.on('data', onData);
      rawSocket.once('error', reject);
    });
  } else {
    // No upstream proxy — raw TCP directly to bug host IP
    rawSocket = await new Promise((resolve, reject) => {
      const sock = net.connect({ host: bugIp, port: bugPort });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`Direct TCP connect timeout (${bugIp}:${bugPort})`));
      }, timeout);
      sock.once('connect', () => { clearTimeout(timer); resolve(sock); });
      sock.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }

  // Final step: TLS upgrade on the raw socket with SNI = targetHostname
  return new Promise((resolve, reject) => {
    const tlsSock = tls.connect({
      socket: rawSocket,
      servername: targetHostname,   // <-- the SNI trick
      rejectUnauthorized: false,
    });

    const timer = setTimeout(() => {
      tlsSock.destroy();
      reject(new Error(`TLS handshake timeout for ${targetHostname}`));
    }, timeout);

    tlsSock.once('secureConnect', () => { clearTimeout(timer); resolve(tlsSock); });
    tlsSock.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function decodeChunked(buf) {
  const chunks = [];
  let offset = 0;

  while (offset < buf.length) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd === -1) break;

    const sizeLine = buf.slice(offset, lineEnd).toString('ascii').trim();
    const chunkSize = parseInt(sizeLine, 16);

    if (isNaN(chunkSize) || chunkSize === 0) break;

    offset = lineEnd + 2;
    if (offset + chunkSize > buf.length) break;

    chunks.push(buf.slice(offset, offset + chunkSize));
    offset += chunkSize + 2;
  }

  return Buffer.concat(chunks);
}

function parseHttpResponse(rawBuffer, originalUrl) {
  const sep = rawBuffer.indexOf(Buffer.from('\r\n\r\n'));
  if (sep === -1) throw new Error('Malformed HTTP response: missing header/body separator');

  const headerSection = rawBuffer.slice(0, sep).toString('ascii');
  let bodyBuffer = rawBuffer.slice(sep + 4);

  const [statusLine, ...headerLines] = headerSection.split('\r\n');
  const statusMatch = statusLine.match(/HTTP\/\d+\.?\d*\s+(\d+)\s*(.*)/);
  if (!statusMatch) throw new Error(`Malformed HTTP status line: ${statusLine}`);

  const status = parseInt(statusMatch[1], 10);
  const statusText = statusMatch[2] || '';

  const headers = {};
  for (const line of headerLines) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      headers[key] = val;
    }
  }

  if (headers['transfer-encoding'] && headers['transfer-encoding'].includes('chunked')) {
    bodyBuffer = decodeChunked(bodyBuffer);
  }

  if (headers['content-length']) {
    const len = parseInt(headers['content-length'], 10);
    if (!isNaN(len) && len < bodyBuffer.length) {
      bodyBuffer = bodyBuffer.slice(0, len);
    }
  }

  return { status, statusText, headers, bodyBuffer, url: originalUrl };
}

async function sniRequest(targetUrl, options = {}) {
  const parsed = new URL(targetUrl);
  const isHttps = parsed.protocol === 'https:';

  if (!isHttps) {
    throw new Error('Only HTTPS targets are supported for SNI tunneling (SNI is TLS-specific)');
  }

  const targetHostname = parsed.hostname;
  const path = (parsed.pathname || '/') + (parsed.search || '');

  const bugHost = options.bugHost || DEFAULT_BUG_HOSTS[0];
  const bugPort = options.bugPort || 443;
  const bugIp = options.bugIp || (await resolveBugHostIp(bugHost));

  const method = (options.method || 'GET').toUpperCase();
  const extraHeaders = options.headers || {};

  let bodyBuffer = null;
  if (options.body !== undefined && options.body !== null) {
    if (Buffer.isBuffer(options.body)) {
      bodyBuffer = options.body;
    } else if (typeof options.body === 'string') {
      bodyBuffer = Buffer.from(options.body, 'utf8');
    } else {
      bodyBuffer = Buffer.from(JSON.stringify(options.body), 'utf8');
      extraHeaders['content-type'] = extraHeaders['content-type'] || 'application/json';
    }
  }

  const reqHeaders = {
    host: targetHostname,
    connection: 'close',
    'user-agent': options.userAgent || 'sni-fetch/1.1',
    ...extraHeaders,
  };

  if (bodyBuffer) {
    reqHeaders['content-length'] = bodyBuffer.length;
  }

  let reqStr = `${method} ${path} HTTP/1.1\r\n`;
  for (const [k, v] of Object.entries(reqHeaders)) {
    reqStr += `${k}: ${v}\r\n`;
  }
  reqStr += '\r\n';

  const reqParts = [Buffer.from(reqStr, 'ascii')];
  if (bodyBuffer) reqParts.push(bodyBuffer);
  const reqBuffer = Buffer.concat(reqParts);

  const socket = await connectViaSni(bugIp, bugPort, bugHost, targetHostname, options);

  socket.write(reqBuffer);

  const rawResponse = await new Promise((resolve, reject) => {
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks)));
    socket.on('error', reject);
  });

  socket.destroy();

  const parsed_resp = parseHttpResponse(rawResponse, targetUrl);

  const maxRedirects = options.maxRedirects !== undefined ? options.maxRedirects : 5;
  if ([301, 302, 303, 307, 308].includes(parsed_resp.status) && maxRedirects > 0) {
    const location = parsed_resp.headers['location'];
    if (location) {
      const redirectUrl = new URL(location, targetUrl).toString();
      const redirectMethod = parsed_resp.status === 303 ? 'GET' : method;
      const redirectBody = [301, 302, 303].includes(parsed_resp.status) ? undefined : options.body;
      return sniRequest(redirectUrl, {
        ...options,
        method: redirectMethod,
        body: redirectBody,
        maxRedirects: maxRedirects - 1,
      });
    }
  }

  const { status, statusText, headers, bodyBuffer: respBody, url } = parsed_resp;

  return {
    status,
    statusText,
    headers,
    ok: status >= 200 && status < 300,
    url,
    text: () => respBody.toString('utf8'),
    json: () => JSON.parse(respBody.toString('utf8')),
    buffer: () => respBody,
    arrayBuffer: () => respBody.buffer.slice(respBody.byteOffset, respBody.byteOffset + respBody.byteLength),
  };
}

module.exports = { sniRequest, resolveBugHostIp, getUpstreamProxy, connectViaSni, DEFAULT_BUG_HOSTS };
