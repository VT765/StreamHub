import { io, type Socket } from 'socket.io-client';
import { api } from '../../lib/api';
import type { ChatMessage, JoinErrorCode, Participant, PermissionState, Quality, RoomInfo } from './types';

/**
 * WebRTC full-mesh call engine.
 *
 * Every pair of participants has one RTCPeerConnection with three fixed transceivers:
 *   [0] audio (mic)   [1] video (camera)   [2] video (screen share)
 * Tracks are swapped with RTCRtpSender.replaceTrack, so toggling media or switching devices never
 * renegotiates. The existing participant offers to a newcomer; renegotiation (ICE restarts) uses
 * the perfect-negotiation pattern with the newcomer as the polite peer.
 */

export type CallStatus = 'idle' | 'joining' | 'in-call' | 'reconnecting' | 'left' | 'ended' | 'removed' | 'replaced' | 'error';

export interface RemoteMedia {
  cam: MediaStream;
  screen: MediaStream;
}

export interface Notice {
  id: number;
  text: string;
}

export interface Devices {
  audioinput: MediaDeviceInfo[];
  videoinput: MediaDeviceInfo[];
  audiooutput: MediaDeviceInfo[];
}

export interface MeetingState {
  status: CallStatus;
  error: { code: JoinErrorCode; message: string } | null;
  selfId: string | null;
  room: RoomInfo | null;
  participants: Participant[];
  messages: ChatMessage[];
  notices: Notice[];
  remote: Record<string, RemoteMedia>;
  peerQuality: Record<string, Quality>;
  devices: Devices;
  selected: { audioinput?: string; videoinput?: string; audiooutput?: string };
  permissions: { audio: PermissionState; video: PermissionState };
  local: {
    stream: MediaStream | null;
    screenStream: MediaStream | null;
    mic: boolean;
    cam: boolean;
    screen: boolean;
    handRaised: boolean;
    speaking: boolean;
    level: number;
    facingMode: 'user' | 'environment';
    noiseSuppression: boolean;
    dataSaver: boolean;
    recording: boolean;
  };
}

interface Peer {
  userId: string;
  socketId: string;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  answererPrepared: boolean;
  queue: Promise<void>;
  restartTimer?: ReturnType<typeof setTimeout>;
  prevStats?: { lost: number; received: number };
  appliedProfile?: string;
}

type SignalData = { type: 'description'; description: RTCSessionDescriptionInit } | { type: 'candidate'; candidate: RTCIceCandidateInit };

const isMobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const QUALITY_RANK: Record<Quality, number> = { unknown: 0, good: 1, fair: 2, poor: 3 };

/** Bitrate profiles for the camera sender, chosen per peer from measured link quality. */
const PROFILES = {
  high: { maxBitrate: 1_200_000, scaleResolutionDownBy: 1, maxFramerate: 30 },
  medium: { maxBitrate: 450_000, scaleResolutionDownBy: 2, maxFramerate: 24 },
  low: { maxBitrate: 150_000, scaleResolutionDownBy: 4, maxFramerate: 15 },
} as const;

export class MeetingClient {
  readonly roomCode: string;
  private state: MeetingState;
  private listeners = new Set<() => void>();
  private socket: Socket | null = null;
  private peers = new Map<string, Peer>(); // by userId
  private iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  private audioTrack: MediaStreamTrack | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private joinParams: { passcode?: string } = {};
  private wantInCall = false;
  private statsTimer?: ReturnType<typeof setInterval>;
  private levelTimer?: ReturnType<typeof setInterval>;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserSource: MediaStreamAudioSourceNode | null = null;
  private lastLoud = 0;
  private sentSpeaking = false;
  private noticeSeq = 0;
  private destroyed = false;

  constructor(roomCode: string) {
    this.roomCode = roomCode;
    this.state = {
      status: 'idle',
      error: null,
      selfId: null,
      room: null,
      participants: [],
      messages: [],
      notices: [],
      remote: {},
      peerQuality: {},
      devices: { audioinput: [], videoinput: [], audiooutput: [] },
      selected: {},
      permissions: { audio: 'prompt', video: 'prompt' },
      local: {
        stream: null,
        screenStream: null,
        mic: true,
        cam: true,
        screen: false,
        handRaised: false,
        speaking: false,
        level: 0,
        facingMode: 'user',
        noiseSuppression: true,
        dataSaver: false,
        recording: false,
      },
    };
    navigator.mediaDevices?.addEventListener('devicechange', this.onDeviceChange);
    api
      .get<{ iceServers: RTCIceServer[] }>('/meetings/ice-servers')
      .then((r) => (this.iceServers = r.iceServers))
      .catch(() => {});
  }

  // ───────────────────────── store ─────────────────────────

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = () => this.state;

  private set(patch: Partial<MeetingState>) {
    if (this.destroyed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  private setLocal(patch: Partial<MeetingState['local']>) {
    this.set({ local: { ...this.state.local, ...patch } });
  }

  notify(text: string) {
    const id = ++this.noticeSeq;
    this.set({ notices: [...this.state.notices, { id, text }].slice(-4) });
    setTimeout(() => this.set({ notices: this.state.notices.filter((n) => n.id !== id) }), 5000);
  }

  get self(): Participant | undefined {
    return this.state.participants.find((p) => p.userId && p.socketId === this.state.selfId);
  }

  // ───────────────────────── local media ─────────────────────────

  get isMobile() {
    return isMobile;
  }

  private audioConstraints(deviceId?: string): MediaTrackConstraints {
    return {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: this.state.local.noiseSuppression,
      autoGainControl: true,
    };
  }

  private videoConstraints(deviceId?: string): MediaTrackConstraints {
    const saver = this.state.local.dataSaver;
    return {
      ...(deviceId
        ? { deviceId: { exact: deviceId } }
        : isMobile
          ? { facingMode: this.state.local.facingMode }
          : {}),
      width: { ideal: saver ? 640 : 1280 },
      height: { ideal: saver ? 360 : 720 },
      frameRate: { ideal: saver ? 15 : 30 },
    };
  }

  /**
   * Acquire mic + camera. Falls back to each separately so a denied camera doesn't block audio,
   * and records the permission state of each for the UI.
   */
  async startLocalMedia(want: { audio: boolean; video: boolean } = { audio: true, video: true }) {
    const permissions = { ...this.state.permissions };
    const classify = (err: unknown): PermissionState => {
      const name = (err as DOMException)?.name;
      return name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable';
    };

    if (!navigator.mediaDevices?.getUserMedia) {
      this.set({ permissions: { audio: 'unavailable', video: 'unavailable' } });
      return;
    }

    if (want.audio && want.video) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: this.audioConstraints(this.state.selected.audioinput),
          video: this.videoConstraints(this.state.selected.videoinput),
        });
        this.setAudioTrack(stream.getAudioTracks()[0] ?? null);
        this.setVideoTrack(stream.getVideoTracks()[0] ?? null);
        permissions.audio = permissions.video = 'granted';
        this.set({ permissions });
        await this.refreshDevices();
        return;
      } catch {
        // fall through to individual attempts to learn which one failed
      }
    }
    if (want.audio) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints(this.state.selected.audioinput) });
        this.setAudioTrack(s.getAudioTracks()[0]);
        permissions.audio = 'granted';
      } catch (err) {
        permissions.audio = classify(err);
        this.setLocal({ mic: false });
      }
    }
    if (want.video) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraints(this.state.selected.videoinput) });
        this.setVideoTrack(s.getVideoTracks()[0]);
        permissions.video = 'granted';
      } catch (err) {
        permissions.video = classify(err);
        this.setLocal({ cam: false });
      }
    }
    this.set({ permissions });
    await this.refreshDevices();
  }

  private rebuildLocalStream() {
    const tracks = [this.audioTrack, this.videoTrack].filter((t): t is MediaStreamTrack => !!t && t.readyState === 'live');
    this.setLocal({ stream: tracks.length ? new MediaStream(tracks) : null });
  }

  private setAudioTrack(track: MediaStreamTrack | null) {
    if (this.audioTrack && this.audioTrack !== track) this.audioTrack.stop();
    this.audioTrack = track;
    if (track) {
      track.enabled = this.state.local.mic;
      track.onended = () => this.onTrackEnded('audio');
      const settings = track.getSettings();
      if (settings.deviceId) this.set({ selected: { ...this.state.selected, audioinput: settings.deviceId } });
    }
    this.startLevelMeter();
    this.rebuildLocalStream();
    this.applySenders();
  }

  private setVideoTrack(track: MediaStreamTrack | null) {
    if (this.videoTrack && this.videoTrack !== track) this.videoTrack.stop();
    this.videoTrack = track;
    if (track) {
      track.onended = () => this.onTrackEnded('video');
      const settings = track.getSettings();
      if (settings.deviceId) this.set({ selected: { ...this.state.selected, videoinput: settings.deviceId } });
      if (settings.facingMode === 'user' || settings.facingMode === 'environment') this.setLocal({ facingMode: settings.facingMode });
    }
    this.rebuildLocalStream();
    this.applySenders();
  }

  /** Device unplugged or revoked mid-call: fall back to the default device. */
  private async onTrackEnded(kind: 'audio' | 'video') {
    if (this.destroyed) return;
    if (kind === 'audio' && this.state.local.mic) {
      this.notify('Microphone disconnected — switching to the default mic');
      this.set({ selected: { ...this.state.selected, audioinput: undefined } });
      await this.reacquire('audio').catch(() => this.setMic(false));
    }
    if (kind === 'video' && this.state.local.cam) {
      this.notify('Camera disconnected — switching to the default camera');
      this.set({ selected: { ...this.state.selected, videoinput: undefined } });
      await this.reacquire('video').catch(() => this.setCam(false));
    }
  }

  private async reacquire(kind: 'audio' | 'video', deviceId?: string) {
    if (kind === 'audio') {
      const s = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints(deviceId) });
      this.setAudioTrack(s.getAudioTracks()[0]);
      this.set({ permissions: { ...this.state.permissions, audio: 'granted' } });
    } else {
      // Mobile cameras often can't be opened twice: release the old one first.
      this.videoTrack?.stop();
      const s = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraints(deviceId) });
      this.setVideoTrack(s.getVideoTracks()[0]);
      this.set({ permissions: { ...this.state.permissions, video: 'granted' } });
    }
  }

  async refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices();
    const devices: Devices = { audioinput: [], videoinput: [], audiooutput: [] };
    for (const d of all) if (d.deviceId && d.kind in devices) devices[d.kind as keyof Devices].push(d);
    this.set({ devices });
  }

  private onDeviceChange = () => {
    void this.refreshDevices();
  };

  async selectDevice(kind: 'audioinput' | 'videoinput' | 'audiooutput', deviceId: string) {
    this.set({ selected: { ...this.state.selected, [kind]: deviceId } });
    try {
      if (kind === 'audioinput') await this.reacquire('audio', deviceId);
      if (kind === 'videoinput' && this.state.local.cam) await this.reacquire('video', deviceId);
    } catch {
      this.notify('Couldn’t switch to that device');
    }
  }

  async setMic(on: boolean) {
    if (on && !this.audioTrack) {
      try {
        await this.reacquire('audio', this.state.selected.audioinput);
      } catch {
        this.set({ permissions: { ...this.state.permissions, audio: 'denied' } });
        this.notify('Microphone permission is blocked. Allow it in your browser’s site settings.');
        return;
      }
    }
    if (this.audioTrack) this.audioTrack.enabled = on;
    this.setLocal({ mic: on, speaking: on ? this.state.local.speaking : false });
    this.emitMedia({ mic: on, ...(on ? {} : { speaking: false }) });
  }

  /** Turning the camera off releases it (camera light off); turning on re-opens it. */
  async setCam(on: boolean) {
    if (on) {
      try {
        if (!this.videoTrack || this.videoTrack.readyState !== 'live') await this.reacquire('video', this.state.selected.videoinput);
      } catch {
        this.set({ permissions: { ...this.state.permissions, video: 'denied' } });
        this.notify('Camera permission is blocked. Allow it in your browser’s site settings.');
        return;
      }
    } else if (this.videoTrack) {
      this.videoTrack.stop();
      this.videoTrack = null;
      this.rebuildLocalStream();
    }
    this.setLocal({ cam: on });
    this.applySenders();
    this.emitMedia({ cam: on });
  }

  /** Front ↔ rear on phones; cycles cameras on desktops with several. */
  async switchCamera() {
    if (!this.state.local.cam) return;
    try {
      if (isMobile) {
        const next = this.state.local.facingMode === 'user' ? 'environment' : 'user';
        this.setLocal({ facingMode: next });
        this.set({ selected: { ...this.state.selected, videoinput: undefined } });
        await this.reacquire('video');
      } else {
        const cams = this.state.devices.videoinput;
        if (cams.length < 2) return;
        const i = cams.findIndex((c) => c.deviceId === this.state.selected.videoinput);
        await this.selectDevice('videoinput', cams[(i + 1) % cams.length].deviceId);
      }
    } catch {
      this.notify('Couldn’t switch camera');
    }
  }

  async setNoiseSuppression(on: boolean) {
    this.setLocal({ noiseSuppression: on });
    if (!this.audioTrack) return;
    try {
      await this.audioTrack.applyConstraints({ ...this.audioTrack.getConstraints(), noiseSuppression: on });
    } catch {
      await this.reacquire('audio', this.state.selected.audioinput).catch(() => {});
    }
  }

  setDataSaver(on: boolean) {
    this.setLocal({ dataSaver: on });
    for (const peer of this.peers.values()) peer.appliedProfile = undefined;
    void this.collectStats();
  }

  async startScreenShare() {
    const me = this.self;
    if (me && !me.effectiveCanScreenShare) {
      this.notify('The host hasn’t allowed you to share your screen');
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.notify('Screen sharing isn’t supported in this browser');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
      const track = stream.getVideoTracks()[0];
      track.contentHint = 'detail';
      track.onended = () => this.stopScreenShare();
      this.screenTrack = track;
      this.setLocal({ screen: true, screenStream: stream });
      this.applySenders();
      this.emitMedia({ screen: true });
    } catch (err) {
      if ((err as DOMException).name !== 'NotAllowedError') this.notify('Couldn’t start screen sharing');
    }
  }

  stopScreenShare() {
    this.screenTrack?.stop();
    this.screenTrack = null;
    this.setLocal({ screen: false, screenStream: null });
    this.applySenders();
    this.emitMedia({ screen: false });
  }

  setHand(raised: boolean) {
    this.setLocal({ handRaised: raised });
    this.emitMedia({ handRaised: raised });
  }

  setRecording(on: boolean) {
    this.setLocal({ recording: on });
    this.emitMedia({ recording: on });
  }

  /** Local audio + every remote audio track, for the recorder. */
  audioTracksForRecording(): MediaStreamTrack[] {
    const out: MediaStreamTrack[] = [];
    if (this.audioTrack && this.state.local.mic) out.push(this.audioTrack);
    for (const m of Object.values(this.state.remote)) out.push(...m.cam.getAudioTracks());
    return out;
  }

  // ── speaking detection ──

  private startLevelMeter() {
    if (!this.audioTrack) return;
    try {
      this.audioCtx ??= new AudioContext();
      this.analyserSource?.disconnect();
      this.analyser ??= this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyserSource = this.audioCtx.createMediaStreamSource(new MediaStream([this.audioTrack]));
      this.analyserSource.connect(this.analyser);
    } catch {
      return;
    }
    if (this.levelTimer) return;
    const buf = new Float32Array(512);
    this.levelTimer = setInterval(() => {
      if (!this.analyser) return;
      if (this.audioCtx?.state === 'suspended') void this.audioCtx.resume().catch(() => {});
      this.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      const level = this.state.local.mic ? Math.min(1, rms * 8) : 0;
      const now = Date.now();
      if (level > 0.12) this.lastLoud = now;
      const speaking = this.state.local.mic && now - this.lastLoud < 700;
      if (Math.abs(level - this.state.local.level) > 0.03 || speaking !== this.state.local.speaking) {
        this.setLocal({ level, speaking });
      }
      if (speaking !== this.sentSpeaking && this.state.status === 'in-call') {
        this.sentSpeaking = speaking;
        this.emitMedia({ speaking });
      }
    }, 120);
  }

  // ───────────────────────── signaling / join ─────────────────────────

  private ensureSocket() {
    if (this.socket) return this.socket;
    // Production: connect straight to the API host (the frontend's proxy can't carry WebSockets),
    // authenticating with a short-lived token fetched before every (re)connect.
    const socketUrl = import.meta.env.VITE_SOCKET_URL as string | undefined;
    const socket = socketUrl
      ? io(socketUrl, {
          path: '/socket.io',
          transports: ['websocket', 'polling'],
          auth: (cb) => {
            api
              .get<{ token: string }>('/auth/socket-token')
              .then(({ token }) => cb({ token }))
              .catch(() => cb({}));
          },
        })
      : io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] });
    this.socket = socket;

    socket.on('connect', () => {
      if (this.wantInCall) void this.join(this.joinParams.passcode, true);
    });
    socket.on('disconnect', (reason) => {
      if (!this.wantInCall) return;
      this.set({ status: 'reconnecting' });
      // The server forced us out (e.g. after ending/removal): don't spin.
      if (reason === 'io server disconnect') socket.connect();
    });
    socket.on('connect_error', (err) => {
      if (err.message === 'UNAUTHENTICATED') {
        this.wantInCall = false;
        this.set({ status: 'error', error: { code: 'UNAUTHENTICATED', message: 'Your session expired. Please sign in again.' } });
      } else if (this.wantInCall) {
        this.set({ status: 'reconnecting' });
      }
    });

    socket.on('participant:joined', ({ participant }: { participant: Participant }) => {
      this.upsertParticipant(participant);
      if (participant.socketId === socket.id) return;
      // We're already in the room, so we offer to the newcomer (or to their replacement socket).
      const existing = this.peers.get(participant.userId);
      if (existing && existing.socketId !== participant.socketId) this.closePeer(participant.userId);
      if (!this.peers.has(participant.userId)) this.createPeer(participant.userId, participant.socketId, false);
    });
    socket.on('participant:updated', ({ participant }: { participant: Participant }) => this.upsertParticipant(participant));
    socket.on('participant:left', ({ userId }: { userId: string }) => {
      const p = this.state.participants.find((x) => x.userId === userId);
      this.closePeer(userId);
      this.set({ participants: this.state.participants.filter((x) => x.userId !== userId) });
      if (p && p.socketId !== this.state.selfId) this.notify(`${p.name} left`);
    });
    socket.on('participants:sync', ({ room, participants }: { room: RoomInfo; participants: Participant[] }) => {
      this.set({ room, participants });
    });
    socket.on('room:updated', ({ room }: { room: RoomInfo }) => this.set({ room }));
    socket.on('signal', (msg: { from: string; fromUserId: string; data: SignalData }) => this.onSignal(msg));
    socket.on('chat:message', ({ message }: { message: ChatMessage }) => {
      if (this.state.messages.some((m) => m.id === message.id)) return;
      this.set({ messages: [...this.state.messages, message] });
    });
    socket.on('force:mute', ({ by }: { by: string }) => {
      void this.setMic(false);
      this.notify(`${by} muted you`);
    });
    socket.on('force:stopScreen', ({ reason }: { reason: string }) => {
      if (this.state.local.screen) this.stopScreenShare();
      this.notify(reason);
    });
    socket.on('notice', ({ message }: { message: string }) => this.notify(message));
    socket.on('room:replaced', () => this.terminate('replaced'));
    socket.on('room:removed', () => this.terminate('removed'));
    socket.on('room:ended', () => this.terminate('ended'));
    return socket;
  }

  async join(passcode?: string, isRejoin = false) {
    this.joinParams = { passcode };
    this.wantInCall = true;
    const socket = this.ensureSocket();
    if (!isRejoin) this.set({ status: 'joining', error: null });
    if (!socket.connected) return; // 'connect' handler joins

    // Fresh signaling state on every (re)join; peers will re-offer to our new socket.
    for (const userId of [...this.peers.keys()]) this.closePeer(userId);

    try {
      const res = await socket.timeout(10_000).emitWithAck('room:join', {
        roomCode: this.roomCode,
        passcode,
        mic: this.state.local.mic && !!this.audioTrack,
        cam: this.state.local.cam && !!this.videoTrack,
      });
      if (!res.ok) {
        this.wantInCall = false;
        this.set({ status: 'error', error: { code: res.code, message: res.message } });
        return;
      }
      this.set({
        status: 'in-call',
        error: null,
        selfId: res.selfId,
        room: res.room,
        participants: res.participants,
        messages: res.messages,
      });
      // Restore presence state lost by the server on refresh.
      if (this.state.local.handRaised || this.state.local.screen || this.state.local.recording) {
        this.emitMedia({ handRaised: this.state.local.handRaised, screen: this.state.local.screen, recording: this.state.local.recording });
      }
      if (isRejoin && res.reconnected) this.notify('Reconnected');
      this.startStats();
    } catch {
      if (!this.socket?.connected) return; // will retry on reconnect
      this.set({ status: 'reconnecting' });
      setTimeout(() => this.wantInCall && void this.join(passcode, true), 2000);
    }
  }

  private emitMedia(patch: Partial<Pick<Participant, 'mic' | 'cam' | 'screen' | 'handRaised' | 'speaking' | 'quality' | 'recording'>>) {
    if (this.state.status !== 'in-call') return;
    this.socket?.emit('media:update', patch);
  }

  private request(event: string, payload: unknown = {}) {
    return new Promise<void>((resolve, reject) => {
      if (!this.socket) return reject(new Error('Not connected'));
      this.socket.timeout(8000).emit(event, payload, (err: Error | null, res: { ok: boolean; message?: string }) => {
        if (err) return reject(new Error('Request timed out'));
        if (!res.ok) {
          this.notify(res.message ?? 'Action failed');
          return reject(new Error(res.message));
        }
        resolve();
      });
    });
  }

  sendChat(content: string) {
    return this.request('chat:send', { kind: 'text', content });
  }

  async sendFile(file: File) {
    const form = new FormData();
    form.append('file', file);
    const { file: uploaded } = await api.post<{ file: { id: string } }>(`/meetings/${this.roomCode}/files`, form);
    await this.request('chat:send', { kind: 'file', fileId: uploaded.id });
  }

  // moderation
  muteParticipant = (userId: string) => this.request('mod:mute', { userId });
  muteAll = () => this.request('mod:muteAll');
  removeParticipant = (userId: string) => this.request('mod:remove', { userId });
  setLocked = (locked: boolean) => this.request('mod:lock', { locked });
  setRole = (userId: string, role: 'COHOST' | 'PARTICIPANT') => this.request('mod:role', { userId, role });
  setPermissions = (userId: string, perms: { canScreenShare?: boolean | null; canChat?: boolean | null }) =>
    this.request('mod:permissions', { userId, ...perms });
  setRoomSettings = (settings: { allowScreenShare?: boolean; allowChat?: boolean }) => this.request('mod:settings', settings);
  endForAll = () => this.request('mod:end');

  async leave() {
    this.wantInCall = false;
    await new Promise<void>((resolve) => {
      if (!this.socket?.connected) return resolve();
      this.socket.timeout(2000).emit('room:leave', {}, () => resolve());
    });
    this.terminate('ended', false);
  }

  private terminate(status: 'ended' | 'removed' | 'replaced', fromServer = true) {
    this.wantInCall = false;
    for (const userId of [...this.peers.keys()]) this.closePeer(userId);
    this.stopStats();
    this.stopAllMedia();
    this.socket?.disconnect();
    this.socket = null;
    this.set({ status: fromServer ? status : 'left', remote: {}, participants: [] });
  }

  private upsertParticipant(p: Participant) {
    const list = this.state.participants;
    const i = list.findIndex((x) => x.userId === p.userId);
    if (i === -1 && p.socketId !== this.state.selfId && this.state.status === 'in-call') this.notify(`${p.name} joined`);
    this.set({ participants: i === -1 ? [...list, p] : list.map((x, j) => (j === i ? p : x)) });
  }

  // ───────────────────────── peers ─────────────────────────

  private createPeer(userId: string, socketId: string, polite: boolean): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    const peer: Peer = { userId, socketId, pc, polite, makingOffer: false, ignoreOffer: false, answererPrepared: false, queue: Promise.resolve() };
    this.peers.set(userId, peer);

    if (!polite) {
      // Offerer defines the three m-lines.
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      this.applySendersTo(peer);
      this.exposeRemote(peer);
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.sendSignal(peer, { type: 'candidate', candidate: candidate.toJSON() });
    };
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) this.sendSignal(peer, { type: 'description', description: pc.localDescription.toJSON() });
      } catch (err) {
        console.warn('[meet] negotiation failed', err);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      clearTimeout(peer.restartTimer);
      if (s === 'failed') pc.restartIce();
      // 'disconnected' often recovers by itself; restart ICE if it doesn't.
      if (s === 'disconnected') peer.restartTimer = setTimeout(() => pc.connectionState === 'disconnected' && pc.restartIce(), 4000);
      if (s === 'connected') peer.appliedProfile = undefined;
    };
    pc.ontrack = () => this.exposeRemote(peer);
    return peer;
  }

  private exposeRemote(peer: Peer) {
    const tx = peer.pc.getTransceivers();
    if (tx.length < 3) return;
    const cam = new MediaStream([tx[0].receiver.track, tx[1].receiver.track]);
    const screen = new MediaStream([tx[2].receiver.track]);
    this.set({ remote: { ...this.state.remote, [peer.userId]: { cam, screen } } });
  }

  private closePeer(userId: string) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    clearTimeout(peer.restartTimer);
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    this.peers.delete(userId);
    const { [userId]: _r, ...remote } = this.state.remote;
    const { [userId]: _q, ...peerQuality } = this.state.peerQuality;
    this.set({ remote, peerQuality });
  }

  private sendSignal(peer: Peer, data: SignalData) {
    this.socket?.emit('signal', { to: peer.socketId, data });
  }

  private onSignal({ from, fromUserId, data }: { from: string; fromUserId: string; data: SignalData }) {
    let peer = this.peers.get(fromUserId);
    if (peer && peer.socketId !== from) {
      // Stale peer from that user's previous socket.
      if (data.type === 'description' && data.description.type === 'offer') {
        this.closePeer(fromUserId);
        peer = undefined;
      } else return;
    }
    if (!peer) {
      if (data.type !== 'description' || data.description.type !== 'offer') return;
      peer = this.createPeer(fromUserId, from, true);
    }
    const p = peer;
    p.queue = p.queue.then(() => this.handleSignal(p, data)).catch((err) => console.warn('[meet] signal error', err));
  }

  /** Perfect negotiation. */
  private async handleSignal(peer: Peer, data: SignalData) {
    const { pc } = peer;
    if (pc.signalingState === 'closed') return;
    if (data.type === 'description') {
      const desc = data.description;
      const collision = desc.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(desc);
      if (desc.type === 'offer') {
        if (!peer.answererPrepared) {
          for (const t of pc.getTransceivers()) t.direction = 'sendrecv';
          peer.answererPrepared = true;
          this.applySendersTo(peer);
          this.exposeRemote(peer);
        }
        await pc.setLocalDescription();
        if (pc.localDescription) this.sendSignal(peer, { type: 'description', description: pc.localDescription.toJSON() });
      }
    } else {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!peer.ignoreOffer) console.warn('[meet] ICE candidate rejected', err);
      }
    }
  }

  private applySenders() {
    for (const peer of this.peers.values()) this.applySendersTo(peer);
  }

  private applySendersTo(peer: Peer) {
    const tx = peer.pc.getTransceivers();
    if (tx.length < 3 || (peer.polite && !peer.answererPrepared)) return;
    const live = (t: MediaStreamTrack | null) => (t && t.readyState === 'live' ? t : null);
    void tx[0].sender.replaceTrack(live(this.audioTrack)).catch(() => {});
    void tx[1].sender.replaceTrack(this.state.local.cam ? live(this.videoTrack) : null).catch(() => {});
    void tx[2].sender.replaceTrack(live(this.screenTrack)).catch(() => {});
  }

  // ───────────────────────── stats & bandwidth adaptation ─────────────────────────

  private startStats() {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => void this.collectStats(), 3000);
  }

  private stopStats() {
    clearInterval(this.statsTimer);
    this.statsTimer = undefined;
  }

  private async collectStats() {
    const peerQuality: Record<string, Quality> = {};
    for (const peer of this.peers.values()) {
      if (peer.pc.connectionState !== 'connected') {
        peerQuality[peer.userId] = peer.pc.connectionState === 'failed' || peer.pc.connectionState === 'disconnected' ? 'poor' : 'unknown';
        continue;
      }
      try {
        const report = await peer.pc.getStats();
        let rtt: number | undefined;
        let outgoing: number | undefined;
        let lost = 0;
        let received = 0;
        let remoteLossFraction = 0;
        report.forEach((s) => {
          if (s.type === 'candidate-pair' && (s.nominated || s.selected) && s.state === 'succeeded') {
            rtt = s.currentRoundTripTime;
            outgoing = s.availableOutgoingBitrate;
          }
          if (s.type === 'inbound-rtp') {
            lost += s.packetsLost ?? 0;
            received += s.packetsReceived ?? 0;
          }
          if (s.type === 'remote-inbound-rtp' && typeof s.fractionLost === 'number') {
            remoteLossFraction = Math.max(remoteLossFraction, s.fractionLost);
          }
        });
        const prev = peer.prevStats ?? { lost: 0, received: 0 };
        const dLost = Math.max(0, lost - prev.lost);
        const dRecv = Math.max(0, received - prev.received);
        peer.prevStats = { lost, received };
        const inboundLoss = dLost + dRecv > 0 ? dLost / (dLost + dRecv) : 0;
        const loss = Math.max(inboundLoss, remoteLossFraction);
        const rttMs = (rtt ?? 0) * 1000;

        let q: Quality = 'good';
        if (loss > 0.08 || rttMs > 600 || (outgoing !== undefined && outgoing < 200_000)) q = 'poor';
        else if (loss > 0.03 || rttMs > 300 || (outgoing !== undefined && outgoing < 500_000)) q = 'fair';
        peerQuality[peer.userId] = q;
        await this.adaptBitrate(peer, q);
      } catch {
        peerQuality[peer.userId] = 'unknown';
      }
    }
    this.set({ peerQuality });
    const worst = Object.values(peerQuality).reduce<Quality>((w, q) => (QUALITY_RANK[q] > QUALITY_RANK[w] ? q : w), 'unknown');
    const mine = this.self?.quality;
    const overall = this.peers.size ? (worst === 'unknown' ? 'good' : worst) : 'unknown';
    if (mine !== overall) this.emitMedia({ quality: overall });
  }

  private async adaptBitrate(peer: Peer, q: Quality) {
    const profileName = this.state.local.dataSaver || q === 'poor' ? 'low' : q === 'fair' ? 'medium' : 'high';
    if (peer.appliedProfile === profileName) return;
    const sender = peer.pc.getTransceivers()[1]?.sender;
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    Object.assign(params.encodings[0], PROFILES[profileName]);
    try {
      await sender.setParameters(params);
      peer.appliedProfile = profileName;
    } catch {
      // Some browsers reject setParameters before the first negotiation completes; retry next tick.
    }
  }

  // ───────────────────────── teardown ─────────────────────────

  private stopAllMedia() {
    this.audioTrack?.stop();
    this.videoTrack?.stop();
    this.screenTrack?.stop();
    this.audioTrack = this.videoTrack = this.screenTrack = null;
    clearInterval(this.levelTimer);
    this.levelTimer = undefined;
    this.analyserSource?.disconnect();
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.analyser = null;
    this.setLocal({ stream: null, screenStream: null, screen: false, speaking: false, level: 0 });
  }

  destroy() {
    this.wantInCall = false;
    for (const userId of [...this.peers.keys()]) this.closePeer(userId);
    this.stopStats();
    this.stopAllMedia();
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    navigator.mediaDevices?.removeEventListener('devicechange', this.onDeviceChange);
    this.destroyed = true;
    this.listeners.clear();
  }
}
