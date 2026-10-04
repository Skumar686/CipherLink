// Onion Routing Subsystem for IP Privacy (Phase 7)
// Implements 3-hop telescoping circuits, fixed 512-byte cells,
// layered AES-CTR per-hop encryption (onion peeling), and end-to-end AES-GCM integrity.

import { bufferToBase64, base64ToBuffer } from '../crypto/identity';

export const CELL_SIZE = 512; // Standard Tor fixed cell size (bytes)

export enum CellCommand {
  PADDING = 0,
  CREATE = 1,
  CREATED = 2,
  RELAY = 3,
  DESTROY = 4,
}

export interface RelayNodeInfo {
  id: string;
  name: string;
  location: string;
  role: 'guard' | 'middle' | 'exit';
  pubKeyHex: string;
  latencyMs: number;
}

// Static signed relay directory for the project demonstration
export const STATIC_RELAY_DIRECTORY: RelayNodeInfo[] = [
  {
    id: 'relay-guard-fra',
    name: 'Guard Node Alpha',
    location: 'Frankfurt, DE (Relay #1)',
    role: 'guard',
    pubKeyHex: '04c3a1b89ef726a45d098e2197bb32014fec65a91082d431c70e0a5814e8b392',
    latencyMs: 18,
  },
  {
    id: 'relay-mid-ams',
    name: 'Middle Node Beta',
    location: 'Amsterdam, NL (Relay #2)',
    role: 'middle',
    pubKeyHex: '04e8d352b89f1a0c7743d19e0b82f42a1975e114098ca30172bf4981d390a421',
    latencyMs: 25,
  },
  {
    id: 'relay-exit-zrh',
    name: 'Rendezvous Node Gamma',
    location: 'Zurich, CH (Relay #3 - RP)',
    role: 'exit',
    pubKeyHex: '04889c20a117b3d90234a9ef182a940173e0491823bb19024fca1823901bcae8',
    latencyMs: 32,
  },
];

export interface OnionHopKey {
  hopIndex: number;
  node: RelayNodeInfo;
  sessionKey: CryptoKey;
  rawKey: Uint8Array;
}

export interface CircuitState {
  circuitId: number;
  status: 'idle' | 'building' | 'established' | 'closed';
  hops: OnionHopKey[];
  totalCircuitLatencyMs: number;
}

/**
 * Creates a fixed 512-byte cell with header and payload.
 * [0..1]: Circuit ID (2 bytes)
 * [2]: Command (1 byte)
 * [3..4]: Payload Length (2 bytes)
 * [5..511]: Payload + Random Padding
 */
export function createCell(circuitId: number, command: CellCommand, payload: Uint8Array): Uint8Array {
  const cell = new Uint8Array(CELL_SIZE);
  const view = new DataView(cell.buffer);

  view.setUint16(0, circuitId, false);
  cell[2] = command;
  view.setUint16(3, payload.byteLength, false);

  if (payload.byteLength > CELL_SIZE - 5) {
    throw new Error(`Payload exceeds maximum Tor cell payload size (${CELL_SIZE - 5} bytes)`);
  }

  cell.set(payload, 5);

  // Fill remaining bytes with cryptographically random padding to prevent traffic fingerprinting
  const paddingLen = CELL_SIZE - 5 - payload.byteLength;
  if (paddingLen > 0) {
    const padBytes = crypto.getRandomValues(new Uint8Array(paddingLen));
    cell.set(padBytes, 5 + payload.byteLength);
  }

  return cell;
}

/**
 * Parses a 512-byte cell
 */
export function parseCell(cell: Uint8Array): {
  circuitId: number;
  command: CellCommand;
  payloadLength: number;
  payload: Uint8Array;
} {
  if (cell.byteLength !== CELL_SIZE) {
    throw new Error(`Invalid cell size: ${cell.byteLength}, expected ${CELL_SIZE}`);
  }
  const view = new DataView(cell.buffer);
  const circuitId = view.getUint16(0, false);
  const command = cell[2] as CellCommand;
  const payloadLength = view.getUint16(3, false);
  const payload = cell.slice(5, 5 + payloadLength);

  return { circuitId, command, payloadLength, payload };
}

/**
 * Generates an AES-CTR 128-bit key for layered stream encryption (no cell size expansion)
 */
export async function generateHopKey(): Promise<{ key: CryptoKey; raw: Uint8Array }> {
  const raw = crypto.getRandomValues(new Uint8Array(16)); // 128-bit AES
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-CTR' }, false, [
    'encrypt',
    'decrypt',
  ]);
  return { key, raw };
}

/**
 * Encrypts/decrypts a 512-byte cell using AES-CTR (symmetric operation).
 * Fixed counter ensures deterministic streaming over cell payload.
 */
export async function applyHopLayer(cell: Uint8Array, hopKey: CryptoKey, hopIndex: number): Promise<Uint8Array> {
  const counter = new Uint8Array(16);
  counter[0] = hopIndex & 0xff;
  const result = await crypto.subtle.encrypt(
    {
      name: 'AES-CTR',
      counter,
      length: 64,
    },
    hopKey,
    cell
  );
  return new Uint8Array(result);
}

/**
 * Onion Client Engine:
 * Manages 3-hop circuit construction, onion wrapping (multi-layer encryption),
 * onion peeling (multi-layer decryption), and dummy cover traffic injection.
 */
export class OnionCircuitManager {
  private circuit: CircuitState = {
    circuitId: Math.floor(Math.random() * 65535) + 1,
    status: 'idle',
    hops: [],
    totalCircuitLatencyMs: 0,
  };

  private coverTrafficTimer: any = null;
  private onCellPeelCallback?: (step: { hopName: string; layer: number; direction: 'wrap' | 'peel' }) => void;

  public setOnCellPeel(cb: (step: { hopName: string; layer: number; direction: 'wrap' | 'peel' }) => void) {
    this.onCellPeelCallback = cb;
  }

  public getCircuit(): CircuitState {
    return { ...this.circuit };
  }

  /**
   * Telescoping Circuit Construction:
   * Progressively extends circuit hop by hop:
   * Client -> Guard (Hop 0) -> Middle (Hop 1) -> Exit/RP (Hop 2).
   */
  public async buildCircuit(): Promise<CircuitState> {
    this.circuit.status = 'building';
    this.circuit.hops = [];
    this.circuit.totalCircuitLatencyMs = 0;

    for (let i = 0; i < STATIC_RELAY_DIRECTORY.length; i++) {
      const node = STATIC_RELAY_DIRECTORY[i];
      // Simulate RTT delay of circuit extension
      await new Promise((r) => setTimeout(r, 60));

      const { key, raw } = await generateHopKey();
      this.circuit.hops.push({
        hopIndex: i,
        node,
        sessionKey: key,
        rawKey: raw,
      });

      this.circuit.totalCircuitLatencyMs += node.latencyMs * 2;
    }

    this.circuit.status = 'established';
    return this.circuit;
  }

  /**
   * Wraps an end-to-end payload in 3 layers of onion encryption:
   * Layer 3 (Exit) -> Layer 2 (Middle) -> Layer 1 (Guard).
   */
  public async wrapOnionCell(e2eCiphertext: Uint8Array): Promise<Uint8Array> {
    if (this.circuit.status !== 'established' || this.circuit.hops.length < 3) {
      await this.buildCircuit();
    }

    // Step 1: Place e2e payload in a fixed 512-byte RELAY cell
    let currentCell = createCell(this.circuit.circuitId, CellCommand.RELAY, e2eCiphertext);

    // Step 2: Encrypt in reverse order (Hop 2 Exit first, then Middle, then Guard)
    for (let i = this.circuit.hops.length - 1; i >= 0; i--) {
      const hop = this.circuit.hops[i];
      currentCell = await applyHopLayer(currentCell, hop.sessionKey, hop.hopIndex);
      if (this.onCellPeelCallback) {
        this.onCellPeelCallback({
          hopName: hop.node.name,
          layer: i + 1,
          direction: 'wrap',
        });
      }
    }

    return currentCell;
  }

  /**
   * Simulates a relay peeling one onion layer
   */
  public async peelOneLayer(cell: Uint8Array, hopIndex: number): Promise<Uint8Array> {
    const hop = this.circuit.hops[hopIndex];
    if (!hop) return cell;
    const peeled = await applyHopLayer(cell, hop.sessionKey, hop.hopIndex);
    if (this.onCellPeelCallback) {
      this.onCellPeelCallback({
        hopName: hop.node.name,
        layer: hopIndex + 1,
        direction: 'peel',
      });
    }
    return peeled;
  }

  /**
   * Starts periodic dummy cover traffic (PADDING cells) to resist traffic analysis.
   */
  public startCoverTraffic(sendCell: (cell: Uint8Array) => void, intervalMs = 3000) {
    this.stopCoverTraffic();
    this.coverTrafficTimer = setInterval(() => {
      if (this.circuit.status === 'established') {
        const dummyPayload = new Uint8Array(32);
        crypto.getRandomValues(dummyPayload);
        const cell = createCell(this.circuit.circuitId, CellCommand.PADDING, dummyPayload);
        sendCell(cell);
      }
    }, intervalMs);
  }

  public stopCoverTraffic() {
    if (this.coverTrafficTimer) {
      clearInterval(this.coverTrafficTimer);
      this.coverTrafficTimer = null;
    }
  }

  public destroy() {
    this.stopCoverTraffic();
    this.circuit.status = 'closed';
    this.circuit.hops = [];
  }
}
