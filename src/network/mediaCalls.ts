// P2P Voice and Video Media Call Manager (Phase 5)
// Handles getUserMedia audio/video capture, track toggling, screen sharing,
// and DTLS-SRTP hardware-accelerated encrypted media transport.

export interface MediaCallCallbacks {
  onLocalStream: (stream: MediaStream) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onCallEnded: () => void;
  onError: (err: string) => void;
}

export class MediaCallManager {
  private localStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private isAudioMuted = false;
  private isVideoMuted = false;
  private isScreenSharing = false;
  private callbacks: MediaCallCallbacks;
  private onStreamSend: (stream: MediaStream) => void;
  private onStreamRemove: (stream: MediaStream) => void;

  constructor(
    callbacks: MediaCallCallbacks,
    onStreamSend: (stream: MediaStream) => void,
    onStreamRemove: (stream: MediaStream) => void
  ) {
    this.callbacks = callbacks;
    this.onStreamSend = onStreamSend;
    this.onStreamRemove = onStreamRemove;
  }

  public getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  public getIsAudioMuted(): boolean {
    return this.isAudioMuted;
  }

  public getIsVideoMuted(): boolean {
    return this.isVideoMuted;
  }

  public getIsScreenSharing(): boolean {
    return this.isScreenSharing;
  }

  /**
   * Starts an outgoing audio or video call
   */
  public async startMedia(video = true, audio = true): Promise<MediaStream | null> {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { max: 30 } } : false,
        audio: audio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
      });

      this.callbacks.onLocalStream(this.localStream);
      this.onStreamSend(this.localStream);
      return this.localStream;
    } catch (err: any) {
      this.callbacks.onError(`Camera/Microphone access error: ${err.message}`);
      return null;
    }
  }

  /**
   * Toggles microphone audio track
   */
  public toggleAudio(): boolean {
    if (!this.localStream) return false;
    this.isAudioMuted = !this.isAudioMuted;
    this.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !this.isAudioMuted;
    });
    return this.isAudioMuted;
  }

  /**
   * Toggles camera video track
   */
  public toggleVideo(): boolean {
    if (!this.localStream) return false;
    this.isVideoMuted = !this.isVideoMuted;
    this.localStream.getVideoTracks().forEach((track) => {
      track.enabled = !this.isVideoMuted;
    });
    return this.isVideoMuted;
  }

  /**
   * Starts or stops screen sharing
   */
  public async toggleScreenShare(): Promise<boolean> {
    if (this.isScreenSharing) {
      this.stopScreenShare();
      return false;
    }

    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      this.isScreenSharing = true;
      this.onStreamSend(this.screenStream);
      this.callbacks.onLocalStream(this.screenStream);

      // Listen for browser's native "Stop Sharing" button
      this.screenStream.getVideoTracks()[0].onended = () => {
        this.stopScreenShare();
      };

      return true;
    } catch {
      return false;
    }
  }

  private stopScreenShare() {
    if (this.screenStream) {
      this.onStreamRemove(this.screenStream);
      this.screenStream.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
    }
    this.isScreenSharing = false;
    if (this.localStream) {
      this.callbacks.onLocalStream(this.localStream);
      this.onStreamSend(this.localStream);
    }
  }

  /**
   * Terminates active media call
   */
  public endCall(): void {
    if (this.localStream) {
      this.onStreamRemove(this.localStream);
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    if (this.screenStream) {
      this.onStreamRemove(this.screenStream);
      this.screenStream.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
    }
    this.isAudioMuted = false;
    this.isVideoMuted = false;
    this.isScreenSharing = false;
    this.callbacks.onCallEnded();
  }
}
