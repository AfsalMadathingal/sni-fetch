'use strict';

const sni = require('../src/index');

async function run() {
  console.log('Testing sni-fetch...\n');

  // Test 1: GET request
  console.log('Test 1: GET https://httpbin.org/get');
  try {
    const res = await sni.get('https://httpbin.org/get', {
      bugHost: 'github.com',
    });
    console.log(`  Status: ${res.status} ${res.statusText}`);
    const json = res.json();
    console.log(`  URL from response: ${json.url}`);
    console.log('  PASS\n');
  } catch (err) {
    console.log(`  FAIL: ${err.message}\n`);
  }

  // Test 2: POST with JSON body
  console.log('Test 2: POST https://httpbin.org/post');
  try {
    const res = await sni.post('https://httpbin.org/post', { hello: 'world' }, {
      bugHost: 'github.com',
    });
    console.log(`  Status: ${res.status} ${res.statusText}`);
    const json = res.json();
    console.log(`  Echo body: ${JSON.stringify(json.json)}`);
    console.log('  PASS\n');
  } catch (err) {
    console.log(`  FAIL: ${err.message}\n`);
  }

  // Test 3: Custom headers
  console.log('Test 3: GET with custom headers');
  try {
    const res = await sni.get('https://httpbin.org/headers', {
      bugHost: 'github.com',
      headers: { 'x-custom-header': 'sni-test-value' },
    });
    console.log(`  Status: ${res.status} ${res.statusText}`);
    const json = res.json();
    const echo = json.headers['X-Custom-Header'];
    console.log(`  Echoed header: ${echo}`);
    console.log(echo === 'sni-test-value' ? '  PASS\n' : '  FAIL (header mismatch)\n');
  } catch (err) {
    console.log(`  FAIL: ${err.message}\n`);
  }
}

run();
