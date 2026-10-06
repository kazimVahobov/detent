// detent dashboard — a page that watches this product, on localhost.
//
// It reads; it never writes. GET is the only method it answers, it listens on
// 127.0.0.1 only, and the page it serves loads nothing from anywhere else.

import { createServer } from 'node:http'
import process from 'node:process'
import { PAGE } from '../dashboard-page.mjs'
import { snapshot } from '../snapshot.mjs'

export const options = { port: { type: 'string', default: '4100' } }

export function serve(product, { port = 4100, host = '127.0.0.1' } = {}) {
  const server = createServer((request, response) => {
    const headers = {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // Nothing from outside: no scripts, styles, fonts or images but its own.
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { ...headers, allow: 'GET, HEAD', 'content-type': 'text/plain' })
      return response.end('the dashboard only reads\n')
    }
    const path = new URL(request.url, 'http://localhost').pathname
    if (path === '/') {
      response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' })
      return response.end(PAGE)
    }
    if (path === '/state.json') {
      try {
        const body = JSON.stringify(snapshot(product))
        response.writeHead(200, { ...headers, 'content-type': 'application/json' })
        return response.end(body)
      } catch (error) {
        response.writeHead(500, { ...headers, 'content-type': 'text/plain' })
        return response.end(`${error.message}\n`)
      }
    }
    response.writeHead(404, { ...headers, 'content-type': 'text/plain' })
    response.end('not here\n')
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}

export async function run(product, _positionals, values) {
  const port = Number(values.port)
  let server
  try {
    server = await serve(product, { port })
  } catch (error) {
    process.stderr.write(`detent dashboard: cannot listen on 127.0.0.1:${port} — ${error.code === 'EADDRINUSE' ? 'something is already there; try --port' : error.message}\n`)
    return 1
  }
  process.stdout.write(`watching ${product.name} at http://127.0.0.1:${server.address().port}/ — Ctrl-C to stop\n`)
  await new Promise((resolve) => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
  server.close()
  return 0
}
