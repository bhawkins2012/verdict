#!/usr/bin/env node
// Wait until a TCP port accepts connections. No dependencies.
// Usage: node scripts/wait-for-port.js [host] [port] [timeoutSeconds]
const net = require('net')

const host = process.argv[2] || 'localhost'
const port = Number(process.argv[3] || 5432)
const timeoutMs = Number(process.argv[4] || 60) * 1000
const deadline = Date.now() + timeoutMs

function attempt() {
  const socket = net.connect({ host, port })
  socket.once('connect', () => {
    socket.destroy()
    console.log(`${host}:${port} is accepting connections`)
    process.exit(0)
  })
  socket.once('error', () => {
    socket.destroy()
    if (Date.now() >= deadline) {
      console.error(`Timed out after ${timeoutMs / 1000}s waiting for ${host}:${port}`)
      process.exit(1)
    }
    setTimeout(attempt, 500)
  })
}

attempt()
