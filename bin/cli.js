#!/usr/bin/env node
'use strict';

const { sniRequest } = require('../src/request');
const { startProxy } = require('../src/proxy');

const args = process.argv.slice(2);

function printHelp() {
  console.log(`
sni-fetch - SNI bug host tunneler for restricted environments

USAGE
  sni-fetch <url> [options]          Make an HTTP request via SNI tunnel
  sni-fetch proxy [options]          Start a local HTTP/HTTPS proxy server

REQUEST OPTIONS
  --method, -X <method>             HTTP method (default: GET)
  --data, -d <body>                 Request body (string or JSON)
  --header, -H <key:value>          Add request header (repeatable)
  --bug-host <host>                 Bug host to SNI-tunnel through (default: github.com)
  --bug-port <port>                 Bug host port (default: 443)
  --bug-ip <ip>                     Use specific IP for bug host (skip DNS)
  --no-verify                       Skip TLS certificate verification
  --max-redirects <n>               Max redirects to follow (default: 5)
  --timeout <ms>                    Connection timeout in milliseconds (default: 30000)
  --output, -o <file>               Write response body to file
  --include, -i                     Include response headers in output
  --silent, -s                      Only output body, no status info
  --json                            Parse and pretty-print JSON response

PROXY OPTIONS
  --port, -p <port>                 Proxy listen port (default: 8118)
  --bug-host <host>                 Bug host for all tunneled connections
  --bug-port <port>                 Bug host port (default: 443)
  --verbose, -v                     Verbose proxy logging

EXAMPLES
  sni-fetch https://example.com
  sni-fetch https://api.github.com/users/octocat --bug-host npmjs.com
  sni-fetch https://httpbin.org/post -X POST -d '{"hello":"world"}' -H 'content-type:application/json'
  sni-fetch proxy --port 8118 --bug-host github.com
  # Then: export HTTPS_PROXY=http://127.0.0.1:8118 NODE_TLS_REJECT_UNAUTHORIZED=0
  #       npm install / curl / any tool
`);
}

function parseArgs(args) {
  const opts = {
    method: 'GET',
    headers: {},
    bugHost: 'github.com',
    bugPort: 443,
    maxRedirects: 5,
    timeout: 30000,
    include: false,
    silent: false,
    json: false,
    verbose: false,
  };
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--help': case '-h': opts.help = true; break;
      case '--method': case '-X': opts.method = args[++i]; break;
      case '--data': case '-d': opts.body = args[++i]; break;
      case '--bug-host': opts.bugHost = args[++i]; break;
      case '--bug-port': opts.bugPort = parseInt(args[++i], 10); break;
      case '--bug-ip': opts.bugIp = args[++i]; break;
      case '--no-verify': opts.rejectUnauthorized = true; break;
      case '--max-redirects': opts.maxRedirects = parseInt(args[++i], 10); break;
      case '--timeout': opts.timeout = parseInt(args[++i], 10); break;
      case '--output': case '-o': opts.output = args[++i]; break;
      case '--include': case '-i': opts.include = true; break;
      case '--silent': case '-s': opts.silent = true; break;
      case '--json': opts.json = true; break;
      case '--port': case '-p': opts.port = parseInt(args[++i], 10); break;
      case '--verbose': case '-v': opts.verbose = true; break;
      case '--header': case '-H': {
        const hdr = args[++i];
        const idx = hdr.indexOf(':');
        if (idx > 0) {
          const k = hdr.slice(0, idx).trim().toLowerCase();
          const v = hdr.slice(idx + 1).trim();
          opts.headers[k] = v;
        }
        break;
      }
      default:
        if (!a.startsWith('-')) positional.push(a);
        break;
    }
  }

  return { opts, positional };
}

async function runRequest(url, opts) {
  // Auto-detect JSON body
  if (opts.body && opts.body.startsWith('{') || (opts.body && opts.body.startsWith('['))) {
    try {
      opts.body = JSON.parse(opts.body);
    } catch { /* keep as string */ }
  }

  if (!opts.silent) {
    process.stderr.write(`Connecting: ${url}\n`);
    process.stderr.write(`Bug host:   ${opts.bugHost}:${opts.bugPort}\n`);
  }

  const res = await sniRequest(url, opts);

  if (!opts.silent) {
    process.stderr.write(`\nHTTP ${res.status} ${res.statusText}\n`);
  }

  if (opts.include) {
    for (const [k, v] of Object.entries(res.headers)) {
      process.stdout.write(`${k}: ${v}\n`);
    }
    process.stdout.write('\n');
  }

  const body = res.buffer();

  if (opts.output) {
    const fs = require('fs');
    fs.writeFileSync(opts.output, body);
    if (!opts.silent) process.stderr.write(`Saved to: ${opts.output}\n`);
  } else if (opts.json) {
    const obj = JSON.parse(body.toString('utf8'));
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  } else {
    process.stdout.write(body);
  }

  process.exitCode = res.ok ? 0 : 1;
}

async function runProxy(opts) {
  const port = opts.port || 8118;
  await startProxy(port, {
    bugHost: opts.bugHost,
    bugPort: opts.bugPort,
    bugIp: opts.bugIp,
    verbose: true,
  });

  console.log('\nProxy is running. Press Ctrl+C to stop.\n');

  // Keep process alive
  process.on('SIGINT', () => {
    console.log('\n[sni-proxy] Shutting down.');
    process.exit(0);
  });
}

async function main() {
  const { opts, positional } = parseArgs(args);

  if (opts.help || positional.length === 0) {
    printHelp();
    process.exit(0);
  }

  const command = positional[0];

  if (command === 'proxy') {
    await runProxy(opts);
  } else if (command.startsWith('http://') || command.startsWith('https://')) {
    await runRequest(command, opts);
  } else {
    console.error(`Unknown command or invalid URL: ${command}`);
    console.error('Use --help for usage.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
