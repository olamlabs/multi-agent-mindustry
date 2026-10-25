export class ViewerHealth {
  constructor(seat, { staleMs = 15_000 } = {}) {
    Object.assign(this, { seat, staleMs });
    this.latest = null;
  }

  update(value, now = Date.now()) {
    if (!value || value.seat !== this.seat || !Number.isSafeInteger(value.timestamp_ms)
      || typeof value.connected !== 'boolean' || !Number.isSafeInteger(value.connections) || value.connections < 0
      || !Number.isSafeInteger(value.attempts) || value.attempts < 0
      || !Number.isSafeInteger(value.disconnected_since_ms) || value.disconnected_since_ms < 0) {
      throw new Error(`${this.seat}: invalid native viewer heartbeat`);
    }
    const age = now - value.timestamp_ms;
    const connected = value.connected && value.connections > 0 && age >= -1000 && age <= this.staleMs;
    this.latest = { ...value, connected, heartbeat_age_ms: age, recoveries: Math.max(0, value.connections - 1) };
    return this.latest;
  }

  requireConnected() {
    if (!this.latest?.connected) throw new Error(`${this.seat}: native viewer is not connected; recording cannot be acknowledged or finalized`);
    return this.latest;
  }
}
