import { describe, expect, test } from 'vitest';
import { unsecuredNeedsAck } from './api';
import { runtimeRank, simHostWarnings, simulatorAppFor, validateSimHostInput, type SimHost, type SimHostInput } from './model';

const base: SimHostInput = {
  name: 'Mac',
  controllerUrl: 'https://sim.example.com',
  streamUrl: null,
  agentHostId: 'mac-1',
  runtime: 'isolated',
  macosVersion: '26.1',
  hardwareModel: null,
  chip: null,
  ramGb: 16,
  vmCapUnlocked: false,
  maxSessions: 2,
  scope: 'all',
  priority: 10,
  notes: null,
};

describe('simulator host model', () => {
  test('macOS 26 runs the Xcode Simulator; 27 and later run Device Hub', () => {
    expect(simulatorAppFor('26')).toBe('simulator');
    expect(simulatorAppFor('26.4.1')).toBe('simulator');
    expect(simulatorAppFor('27')).toBe('device-hub');
    expect(simulatorAppFor('28.0')).toBe('device-hub');
  });

  test('a fully isolated host is held to two simulators (one VM each) unless the cap is unlocked', () => {
    expect(validateSimHostInput({ ...base, maxSessions: 3 }).maxSessions).toMatch(/at most 2/);
    expect(validateSimHostInput({ ...base, maxSessions: 3, vmCapUnlocked: true })).toEqual({});
    // Build-isolated hosts run simulators on the Mac; VMs are only for builds.
    expect(validateSimHostInput({ ...base, maxSessions: 3, runtime: 'build-isolated' })).toEqual({});
    expect(validateSimHostInput({ ...base, maxSessions: 3, runtime: 'unsecure' })).toEqual({});
  });

  test('routing prefers fully isolated, then build isolated, then unsecured', () => {
    expect(['unsecure', 'build-isolated', 'isolated'].sort((a, b) => runtimeRank(a) - runtimeRank(b))).toEqual([
      'isolated',
      'build-isolated',
      'unsecure',
    ]);
  });

  test('rejects bad URLs, versions and credentials in URLs', () => {
    expect(validateSimHostInput({ ...base, controllerUrl: 'ftp://x' }).controllerUrl).toBeDefined();
    expect(validateSimHostInput({ ...base, controllerUrl: 'https://u:p@x.com' }).controllerUrl).toMatch(/credentials/);
    expect(validateSimHostInput({ ...base, streamUrl: 'https://x.com' }).streamUrl).toBeDefined();
    expect(validateSimHostInput({ ...base, macosVersion: 'Tahoe' }).macosVersion).toBeDefined();
  });

  test('putting an unsecured host into service, or widening it to everyone, needs an acknowledgement', () => {
    const off = { runtime: 'unsecure', serving: false, scope: 'beta' };
    const on = { runtime: 'unsecure', serving: true, scope: 'beta' };
    expect(unsecuredNeedsAck(off, on, false)?.status).toBe(409);
    expect(unsecuredNeedsAck(off, on, true)).toBeNull();
    expect(unsecuredNeedsAck(on, { ...on, scope: 'all' }, false)?.status).toBe(409);
    // Already serving, nothing widened: an unrelated edit needs nothing.
    expect(unsecuredNeedsAck(on, on, false)).toBeNull();
    // Isolated and build-isolated hosts never need it.
    expect(unsecuredNeedsAck(null, { runtime: 'build-isolated', serving: true, scope: 'all' }, false)).toBeNull();
    expect(unsecuredNeedsAck(null, { runtime: 'isolated', serving: true, scope: 'all' }, false)).toBeNull();
    // A new unsecured host created serving needs it.
    expect(unsecuredNeedsAck(null, on, false)?.status).toBe(409);
  });

  test('warns loudest about an unsecured host serving everyone; a build-isolated host reporting bare-metal is normal', () => {
    const host = { ...base, id: 'h', hasOwnToken: false, serving: true, lastTest: null, createdAt: '', updatedAt: '' } as SimHost;
    const up = { reachable: true, agentConnected: true, reportedKind: 'bare-metal', reportedSlots: 2, activeSessions: 0, lastHeartbeatAt: null, latencyMs: 10, error: null };
    const unsecured = simHostWarnings({ ...host, runtime: 'unsecure' }, up);
    expect(unsecured[0]).toMatchObject({ tone: 'danger' });
    expect(simHostWarnings({ ...host, runtime: 'build-isolated' }, up)).toEqual([]);
    expect(simHostWarnings({ ...host, runtime: 'build-isolated', scope: 'beta' }, up)).toEqual([]);
  });
});
