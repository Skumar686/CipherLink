// Decentralized Peer Discovery & Signaling using Trystero (BitTorrent Trackers)
// Implements rendezvous rooms, explicit accept/reject connection flow,
// mutual identity verification, session key derivation, and reliable transport binding.

import { joinRoom, type Room } from '@trystero-p2p/torrent';
import {
  type UserIdentity,
  bufferToBase64,
  base64ToBuffer,
  deriveIdFromSpki,
} from '../crypto/identity';
import {
  generateEphemeralEcdh,
  deriveSessionKey,
  importEphemeralPublicKey,
  encryptPayload,
  decryptPayload,
} from '../crypto/session';
import {
  generateChallenge,
  signHandshakeChallenge,
  verifyHandshakeResponse,
  computeSafetyNumber,
} from '../crypto/handshakeAuth';
import { ReliableTransport } from './reliableTransport';
import type { TransportPacket, NetworkMetrics, ConnectionStatus } from './types';
import { normalizeId } from '../crypto/crockford';

const APP_ID = 'cipherlink-secure-p2p-v1';

/**
 * ICE / STUN / TURN servers for cross-network WebRTC connectivity.
 * Includes Google, Cloudflare, and public Open Relay TURN as fallback.
 */
const TURN_CONFIG: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  // Public TURN fallback (Open Relay Project)
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

export interface IncomingRequest {
  callerId: string;
  callerDisplayName: string;
  peerTrysteroId: string;
  accept: () => Promise<void>;
  reject: (reason?: string) => void;
}

export interface SignalingCallbacks {
  onStatusChange: (status: ConnectionStatus, detail?: string) => void;
  onIncomingRequest: (request: IncomingRequest) => void;
  onConnected: (peerInfo: {
    peerId: string;
    safetyNumber: string;
    sessionKey: CryptoKey;
    reliableTransport: ReliableTransport;
  }) => void;
  onDisconnected: () => void;
  onMessageReceived: (text: string, timestamp: number, seq: number) => void;
  onFileChunkReceived: (packet: TransportPacket) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onMetricsChange: (metrics: NetworkMetrics) => void;
}

/**
 * Derives a deterministic room key for decentralized rendezvous
 */
export async function deriveRoomName(id: string): Promise<string> {
  const norm = normalizeId(id);
  const data = new TextEncoder().encode(`cipherlink:room:v1:${norm}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `cl-${hex.slice(0, 16)}`;
}

export class PeerSessionManager {
  private localIdentity: UserIdentity;
  private callbacks: SignalingCallbacks;
  private localListenRoom: Room | null = null;
  private activeRoom: Room | null = null;
  private activePeerTrysteroId: string | null = null;
  private sessionKey: CryptoKey | null = null;
  private reliableTransport: ReliableTransport | null = null;
  private safetyNumber: string = '';
  private remotePeerId: string = '';
  private status: ConnectionStatus = 'disconnected';

  // Ephemeral keys for active handshake
  private ephemeralKeyPair: { keyPair: CryptoKeyPair; rawPublicKey: ArrayBuffer; base64PublicKey: string } | null = null;
  private localChallenge: Uint8Array | null = null;

  constructor(localIdentity: UserIdentity, callbacks: SignalingCallbacks) {
    this.localIdentity = localIdentity;
    this.callbacks = callbacks;
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public getSessionKey(): CryptoKey | null {
    return this.sessionKey;
  }

  public getSafetyNumber(): string {
    return this.safetyNumber;
  }

  public getRemotePeerId(): string {
    return this.remotePeerId;
  }

  public getReliableTransport(): ReliableTransport | null {
    return this.reliableTransport;
  }

  private setStatus(status: ConnectionStatus, detail?: string) {
    this.status = status;
    this.callbacks.onStatusChange(status, detail);
  }

  /**
   * Starts listening on the local user's rendezvous room for incoming connections.
   */
  public async startListening(): Promise<void> {
    try {
      const roomName = await deriveRoomName(this.localIdentity.id);
      this.localListenRoom = joinRoom({ appId: APP_ID, turnConfig: TURN_CONFIG }, roomName);

      const reqAction = this.localListenRoom.makeAction('req');
      const accAction = this.localListenRoom.makeAction('acc');
      const rejAction = this.localListenRoom.makeAction('rej');
      const confAction = this.localListenRoom.makeAction('conf');
      const relDataAction = this.localListenRoom.makeAction('reldata');

      // Setup audio/video stream listener
      this.localListenRoom.onPeerStream = (stream: MediaStream) => {
        this.callbacks.onRemoteStream(stream);
      };

      // Handle inbound connection request
      reqAction.onMessage = async (data: any, context) => {
        const peerId = context.peerId;
        const { callerId, callerSpkiBase64, callerEphemeralBase64, callerChallengeBase64 } = data;

        // Verify caller's ID matches their SPKI
        const callerSpki = base64ToBuffer(callerSpkiBase64);
        const { formattedId } = await deriveIdFromSpki(callerSpki);
        if (formattedId !== callerId) {
          rejAction.send({ reason: 'Identity signature verification failed' }, { target: peerId });
          return;
        }

        // Present explicit accept / reject prompt to user
        this.callbacks.onIncomingRequest({
          callerId,
          callerDisplayName: `Peer ${callerId.slice(0, 4)}`,
          peerTrysteroId: peerId,
          accept: async () => {
            this.activeRoom = this.localListenRoom;
            this.activePeerTrysteroId = peerId;
            this.remotePeerId = callerId;
            this.setStatus('authenticating', 'Authenticating peer handshake...');

            // Generate our challenge & ephemeral ECDH
            this.ephemeralKeyPair = await generateEphemeralEcdh();
            this.localChallenge = generateChallenge();

            // Sign caller's challenge with our long-term identity key
            const callerChallengeBytes = new Uint8Array(base64ToBuffer(callerChallengeBase64));
            const signatureBase64 = await signHandshakeChallenge(
              this.localIdentity,
              callerChallengeBytes,
              this.ephemeralKeyPair.rawPublicKey
            );

            // Import caller ephemeral key and derive shared session key
            const callerEphemeralKey = await importEphemeralPublicKey(
              base64ToBuffer(callerEphemeralBase64)
            );
            this.sessionKey = await deriveSessionKey(
              this.ephemeralKeyPair.keyPair.privateKey,
              callerEphemeralKey
            );

            // Calculate Safety Number
            this.safetyNumber = await computeSafetyNumber(
              this.localIdentity.publicKeySpki,
              callerSpki
            );

            // Send acceptance with our credentials and signature
            accAction.send(
              {
                responderId: this.localIdentity.id,
                responderSpkiBase64: this.localIdentity.publicKeyBase64,
                responderEphemeralBase64: this.ephemeralKeyPair.base64PublicKey,
                challengeBase64: bufferToBase64(this.localChallenge.buffer),
                signatureBase64,
              },
              { target: peerId }
            );

            // Await confirmation and finalize transport
            confAction.onMessage = (_confData: any) => {
              this.initializeReliableTransport(relDataAction, peerId);
            };
          },
          reject: (reason = 'User declined connection') => {
            rejAction.send({ reason }, { target: peerId });
          },
        });
      };

      this.localListenRoom.onPeerLeave = (peerId: string) => {
        if (peerId === this.activePeerTrysteroId) {
          this.disconnect('Peer disconnected from room');
        }
      };
    } catch (err: any) {
      this.setStatus('failed', `Failed to start listener: ${err.message}`);
    }
  }

  /**
   * Dials a remote peer by their 12-character ID.
   */
  public async connectToPeer(targetId: string): Promise<void> {
    const cleanTargetId = normalizeId(targetId);
    if (!cleanTargetId || cleanTargetId === normalizeId(this.localIdentity.id)) {
      throw new Error('Cannot dial own ID or empty ID');
    }

    this.setStatus('signaling', `Connecting to peer room for ${targetId}...`);
    this.remotePeerId = targetId;

    const roomName = await deriveRoomName(cleanTargetId);
    const room = joinRoom({ appId: APP_ID, turnConfig: TURN_CONFIG }, roomName);
    this.activeRoom = room;

    const reqAction = room.makeAction('req');
    const accAction = room.makeAction('acc');
    const rejAction = room.makeAction('rej');
    const confAction = room.makeAction('conf');
    const relDataAction = room.makeAction('reldata');

    // Setup stream listener for calls
    room.onPeerStream = (stream: MediaStream) => {
      this.callbacks.onRemoteStream(stream);
    };

    // Generate local ephemeral ECDH keypair and challenge
    this.ephemeralKeyPair = await generateEphemeralEcdh();
    this.localChallenge = generateChallenge();

    let hasSentReq = false;

    const sendReqToPeer = (peerId: string) => {
      if (hasSentReq) return;
      hasSentReq = true;
      this.activePeerTrysteroId = peerId;

      this.setStatus('signaling', 'Rendezvous established. Awaiting peer acceptance...');
      reqAction.send(
        {
          callerId: this.localIdentity.id,
          callerSpkiBase64: this.localIdentity.publicKeyBase64,
          callerEphemeralBase64: this.ephemeralKeyPair!.base64PublicKey,
          callerChallengeBase64: bufferToBase64(this.localChallenge!.buffer),
        },
        { target: peerId }
      );
    };

    // If peers are already in room, dial immediately
    const existingPeers = room.getPeers();
    const peerKeys = Object.keys(existingPeers);
    if (peerKeys.length > 0) {
      sendReqToPeer(peerKeys[0]);
    }

    room.onPeerJoin = (peerId: string) => {
      sendReqToPeer(peerId);
    };

    // Handle peer rejection
    rejAction.onMessage = (data: any) => {
      this.setStatus('rejected', data?.reason || 'Peer declined connection request');
    };

    // Handle peer acceptance
    accAction.onMessage = async (data: any, context) => {
      const peerId = context.peerId;
      this.setStatus('authenticating', 'Peer accepted. Verifying cryptographic credentials...');
      const {
        responderId,
        responderSpkiBase64,
        responderEphemeralBase64,
        challengeBase64,
        signatureBase64,
      } = data;

      // Authenticate responder: Verify signature of our challenge + ID match
      const authResult = await verifyHandshakeResponse({
        expectedId: targetId,
        remoteIdentitySpkiBase64: responderSpkiBase64,
        remoteEphemeralRawBase64: responderEphemeralBase64,
        localChallenge: this.localChallenge!,
        signatureBase64,
      });

      if (!authResult.valid) {
        this.setStatus('failed', `Handshake validation failed: ${authResult.reason}`);
        room.leave();
        return;
      }

      // Responder is authentic! Now derive session key via ECDH + HKDF
      const responderEphemeralKey = await importEphemeralPublicKey(
        base64ToBuffer(responderEphemeralBase64)
      );
      this.sessionKey = await deriveSessionKey(
        this.ephemeralKeyPair!.keyPair.privateKey,
        responderEphemeralKey
      );

      // Compute Safety Number
      const remoteSpkiBuffer = base64ToBuffer(responderSpkiBase64);
      this.safetyNumber = await computeSafetyNumber(
        this.localIdentity.publicKeySpki,
        remoteSpkiBuffer
      );

      // Sign responder's challenge and send confirmation
      const responderChallengeBytes = new Uint8Array(base64ToBuffer(challengeBase64));
      const myConfirmSignature = await signHandshakeChallenge(
        this.localIdentity,
        responderChallengeBytes,
        this.ephemeralKeyPair!.rawPublicKey
      );

      confAction.send({ signatureBase64: myConfirmSignature }, { target: peerId });

      // Initialize Reliable Transport
      this.initializeReliableTransport(relDataAction, peerId);
    };

    room.onPeerLeave = (peerId: string) => {
      if (peerId === this.activePeerTrysteroId) {
        this.disconnect('Peer left room');
      }
    };
  }

  /**
   * Initializes the Custom Reliable Transport Protocol over the raw Trystero action channel.
   */
  private initializeReliableTransport(relDataAction: any, peerTrysteroId: string) {
    if (this.reliableTransport) {
      this.reliableTransport.destroy();
    }

    this.reliableTransport = new ReliableTransport({
      initialRtoMs: 350,
      maxRtoMs: 2500,
      maxRetries: 6,
      sendRaw: (packet: TransportPacket) => {
        relDataAction.send(packet, { target: peerTrysteroId });
      },
      onDelivered: async (packet: TransportPacket) => {
        if (packet.type === 'DATA' && packet.payload && this.sessionKey) {
          try {
            const decryptedBytes = await decryptPayload(this.sessionKey, packet.payload);
            const text = new TextDecoder().decode(decryptedBytes);
            this.callbacks.onMessageReceived(text, packet.timestamp, packet.seq || 0);
          } catch (err: any) {
            console.error('Decryption failed for packet', packet.seq, err);
          }
        } else if (packet.type === 'FILE_CHUNK') {
          this.callbacks.onFileChunkReceived(packet);
        }
      },
      onMetricsChange: (metrics: NetworkMetrics) => {
        this.callbacks.onMetricsChange(metrics);
      },
    });

    relDataAction.onMessage = (packet: TransportPacket, context: any) => {
      if (context.peerId === peerTrysteroId && this.reliableTransport) {
        this.reliableTransport.handleIncoming(packet);
      }
    };

    this.setStatus('connected');
    this.callbacks.onConnected({
      peerId: this.remotePeerId,
      safetyNumber: this.safetyNumber,
      sessionKey: this.sessionKey!,
      reliableTransport: this.reliableTransport,
    });
  }

  /**
   * Encrypts and sends a chat message through the custom reliable transport layer.
   */
  public async sendChatMessage(text: string): Promise<number | null> {
    if (!this.sessionKey || !this.reliableTransport) {
      throw new Error('Cannot send message: Not connected or session key missing');
    }

    // Encrypt message with AES-256-GCM
    const encrypted = await encryptPayload(this.sessionKey, text);

    // Send through reliable transport
    const seq = this.reliableTransport.send({
      type: 'DATA',
      payload: encrypted,
    });

    return seq;
  }

  /**
   * Sends a pre-wrapped onion cell (already AES-CTR layered by the caller)
   * through the reliable transport as an ONION_CELL packet.
   * The receiver must peel the layers themselves using the shared circuit keys.
   * NOTE: Because this is a local simulation, both peers share the same circuit
   * keys (generated on the sender). In a real onion network each relay would
   * hold only its own layer key.
   */
  public sendOnionCell(wrappedCell: Uint8Array): number | null {
    if (!this.reliableTransport) return null;
    return this.reliableTransport.send({
      type: 'ONION_CELL',
      payload: wrappedCell,
    });
  }

  /**
   * Adds local media stream for audio/video calling.
   */
  public addMediaStream(stream: MediaStream): void {
    if (this.activeRoom && this.activePeerTrysteroId) {
      this.activeRoom.addStream(stream, { target: this.activePeerTrysteroId });
    }
  }

  /**
   * Removes local media stream.
   */
  public removeMediaStream(stream: MediaStream): void {
    if (this.activeRoom && this.activePeerTrysteroId) {
      this.activeRoom.removeStream(stream, { target: this.activePeerTrysteroId });
    }
  }

  /**
   * Disconnects current active session.
   */
  public disconnect(reason = 'Disconnected'): void {
    if (this.reliableTransport) {
      this.reliableTransport.destroy();
      this.reliableTransport = null;
    }
    if (this.activeRoom && this.activeRoom !== this.localListenRoom) {
      this.activeRoom.leave();
      this.activeRoom = null;
    }
    this.activePeerTrysteroId = null;
    this.sessionKey = null;
    this.safetyNumber = '';
    this.remotePeerId = '';
    this.ephemeralKeyPair = null;
    this.localChallenge = null;
    this.setStatus('disconnected', reason);
    this.callbacks.onDisconnected();
  }

  public destroy(): void {
    this.disconnect();
    if (this.localListenRoom) {
      this.localListenRoom.leave();
      this.localListenRoom = null;
    }
  }
}
