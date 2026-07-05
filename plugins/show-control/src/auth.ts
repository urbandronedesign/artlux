// PIN pairing + per-device token auth for the tablet remote. State persists in a userData sidecar so
// pairings survive app restarts / project switches (machine-global, like device trust). A tablet
// enters the PIN once (shown on the operator panel); it gets a bearer token cached in its localStorage
// and reused thereafter. The PIN gates NEW pairings only — revoking (kick) clears tokens.

import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';

interface Device { token: string; name: string; pairedAt: number }
interface Store { pin: string; devices: Device[] }

const file = () => join(app.getPath('userData'), 'showctl-devices.json');

let store: Store | null = null;

function genPin(): string {
  // 4-digit, zero-padded. randomInt is CSPRNG-backed.
  return String(randomInt(0, 10000)).padStart(4, '0');
}

function load(): Store {
  if (store) return store;
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf-8')) as Partial<Store>;
    store = { pin: parsed.pin || genPin(), devices: Array.isArray(parsed.devices) ? parsed.devices : [] };
  } catch {
    store = { pin: genPin(), devices: [] };
  }
  return store;
}

function persist(): void {
  try { writeFileSync(file(), JSON.stringify(store, null, 2), 'utf-8'); }
  catch (e) { console.error('[show-control] auth persist failed', e); }
}

export function getPin(): string { return load().pin; }

export function regeneratePin(): string {
  const s = load();
  s.pin = genPin();
  persist();
  return s.pin;
}

/** Verify a bearer token belongs to a paired device. */
export function verifyToken(token: string | undefined | null): boolean {
  if (!token) return false;
  return load().devices.some((d) => d.token === token);
}

/** Attempt to pair: on a correct PIN, issue + persist a token. Returns the token or null. */
export function pair(pin: string, name: string): string | null {
  const s = load();
  if (pin !== s.pin) return null;
  const token = randomBytes(24).toString('hex');
  s.devices.push({ token, name: (name || 'Tablet').slice(0, 40), pairedAt: Date.now() });
  persist();
  return token;
}

export function deviceName(token: string): string {
  return load().devices.find((d) => d.token === token)?.name ?? 'Tablet';
}

export interface PairedDevice { token: string; name: string; pairedAt: number }
export function listDevices(): PairedDevice[] {
  return load().devices.map((d) => ({ ...d }));
}

/** Kick one device (by token) or all (revoke every pairing). New pairings need the PIN again. */
export function revoke(token?: string): void {
  const s = load();
  s.devices = token ? s.devices.filter((d) => d.token !== token) : [];
  persist();
}
