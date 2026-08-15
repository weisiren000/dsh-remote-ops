#!/usr/bin/env node
import { startHostd } from './server.js'

function readFlag(args, name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  return args[index + 1]
}

function parseArgs(argv) {
  const args = argv.slice(2)
  return {
    listen: readFlag(args, '--listen'),
    dataDir: readFlag(args, '--data-dir'),
    allowInsecure: args.includes('--allow-insecure'),
    tlsCert: readFlag(args, '--tls-cert'),
    tlsKey: readFlag(args, '--tls-key'),
  }
}

const options = parseArgs(process.argv)
const server = await startHostd(options)
process.stdout.write(`remote-hostd listening on ${server.url}\n`)
process.stdout.write(`pairing code: ${server.pairingCode}\n`)

const shutdown = async () => {
  await server.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
