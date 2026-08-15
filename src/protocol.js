export const PROTOCOL_VERSION = 1
export const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function toWireHost(host) {
  return {
    host_id: host.hostId,
    display_name: host.displayName,
    address: host.address,
    online: host.online,
    cwd: host.cwd,
    os: host.os,
    dialect: host.dialect,
    last_heartbeat_at: host.lastHeartbeatAt,
    status: host.status,
    last_error: host.lastError,
    last_error_at: host.lastErrorAt,
    latency_ms: host.latencyMs,
    connection_started_at: host.connectionStartedAt,
  }
}

export function fromWireHost(payload) {
  return {
    hostId: payload.host_id,
    displayName: payload.display_name,
    address: payload.address,
    online: payload.online,
    cwd: payload.cwd,
    os: payload.os,
    dialect: payload.dialect,
    lastHeartbeatAt: payload.last_heartbeat_at,
    status: payload.status,
    lastError: payload.last_error,
    lastErrorAt: payload.last_error_at,
    latencyMs: payload.latency_ms,
    connectionStartedAt: payload.connection_started_at,
  }
}
