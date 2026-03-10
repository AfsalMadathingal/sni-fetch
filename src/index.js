'use strict';

const { sniRequest, DEFAULT_BUG_HOSTS } = require('./request');
const { createProxy, startProxy } = require('./proxy');

/**
 * sni-fetch public API
 *
 * Usage:
 *   const sni = require('sni-fetch');
 *
 *   const res = await sni.get('https://example.com');
 *   console.log(await res.text());
 *
 *   const res2 = await sni.post('https://api.example.com/data', { foo: 'bar' });
 *   console.log(await res2.json());
 *
 *   // Start a local HTTP proxy (for npm, curl, etc.)
 *   const { port } = await sni.startProxy(8118, { bugHost: 'github.com' });
 */

async function get(url, options = {}) {
  return sniRequest(url, { ...options, method: 'GET' });
}

async function post(url, body, options = {}) {
  return sniRequest(url, { ...options, method: 'POST', body });
}

async function put(url, body, options = {}) {
  return sniRequest(url, { ...options, method: 'PUT', body });
}

async function patch(url, body, options = {}) {
  return sniRequest(url, { ...options, method: 'PATCH', body });
}

async function del(url, options = {}) {
  return sniRequest(url, { ...options, method: 'DELETE' });
}

async function request(url, options = {}) {
  return sniRequest(url, options);
}

module.exports = {
  get,
  post,
  put,
  patch,
  delete: del,
  request,
  createProxy,
  startProxy,
  DEFAULT_BUG_HOSTS,
};
