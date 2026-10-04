// Unit tests for Onion Routing 512-byte cells & layered encryption
import { describe, it, expect } from 'vitest';
import {
  createCell,
  parseCell,
  CellCommand,
  CELL_SIZE,
  OnionCircuitManager,
} from '../onionRouting';

describe('Onion Routing Protocol (Phase 7)', () => {
  it('creates fixed 512-byte cells with padding', () => {
    const payload = new TextEncoder().encode('Hello Onion World');
    const cell = createCell(101, CellCommand.RELAY, payload);

    expect(cell.byteLength).toBe(CELL_SIZE);

    const parsed = parseCell(cell);
    expect(parsed.circuitId).toBe(101);
    expect(parsed.command).toBe(CellCommand.RELAY);
    expect(parsed.payloadLength).toBe(payload.byteLength);
    expect(new TextDecoder().decode(parsed.payload)).toBe('Hello Onion World');
  });

  it('builds 3-hop circuit and performs multi-layer onion peeling', async () => {
    const onionManager = new OnionCircuitManager();
    const circuit = await onionManager.buildCircuit();

    expect(circuit.status).toBe('established');
    expect(circuit.hops.length).toBe(3);

    const secretPayload = new TextEncoder().encode('Layered Anonymous Content');
    // Wrap with 3 layers of encryption
    const onionCell = await onionManager.wrapOnionCell(secretPayload);
    expect(onionCell.byteLength).toBe(CELL_SIZE);

    // Hop 0 (Guard) peels layer 1
    const peeledAtGuard = await onionManager.peelOneLayer(onionCell, 0);
    // Hop 1 (Middle) peels layer 2
    const peeledAtMiddle = await onionManager.peelOneLayer(peeledAtGuard, 1);
    // Hop 2 (Exit) peels layer 3
    const peeledAtExit = await onionManager.peelOneLayer(peeledAtMiddle, 2);

    // Now exit node reads decrypted 512-byte cell
    const finalParsed = parseCell(peeledAtExit);
    expect(finalParsed.command).toBe(CellCommand.RELAY);
    expect(new TextDecoder().decode(finalParsed.payload)).toBe('Layered Anonymous Content');
  });
});
