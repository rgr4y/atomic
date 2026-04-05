import type { Transport, HttpTransportConfig } from './types';
import { COMMAND_MAP } from './command-map';
import { normalizeServerEvent } from './event-normalizer';

export class HttpTransport implements Transport {
  readonly mode = 'http' as const;
  private config: HttpTransportConfig;
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<(payload: any) => void>>();
  private connected = false;
  private shouldReconnect = false;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pingTimeout: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private wsUrl: string | null = null;
  private authExpired = false;
  onConnectionChange?: (connected: boolean) => void;

  constructor(config: HttpTransportConfig) {
    this.config = config;
  }

  getConfig(): HttpTransportConfig {
    return this.config;
  }

  async connect(): Promise<void> {
    if (!this.config.baseUrl) return;
    this.shouldReconnect = true;
    this.wsUrl = this.config.baseUrl
      .replace(/^http/, 'ws')
      .replace(/\/$/, '')
      + `/ws?token=${encodeURIComponent(this.config.authToken)}`;
    this.setupVisibilityHandler();
    try {
      await this.connectWs();
    } catch {
      // WebSocket failed (stale token, server down, etc.) — don't block app startup.
      // HTTP calls will detect auth issues; reconnect will retry in background.
      this.scheduleReconnect();
    }
  }

  private setupVisibilityHandler(): void {
    this.teardownVisibilityHandler();
    this.visibilityHandler = () => {
      if (document.visibilityState !== 'visible') return;
      if (!this.shouldReconnect) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.reconnectDelay = 1000; // reset backoff for visibility-triggered reconnect
        this.forceReconnect();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private teardownVisibilityHandler(): void {
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  private connectWs(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.wsUrl) return reject(new Error('No WebSocket URL'));
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          // Any message from the server counts as proof of liveness
          this.clearPingTimeout();
          const normalized = normalizeServerEvent(data);
          if (normalized) {
            const subs = this.listeners.get(normalized.event);
            if (subs) subs.forEach((cb) => cb(normalized.payload));
          }
        } catch (e) {
          console.warn('[WS] Failed to parse message:', e, msg.data);
        }
      };
      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectDelay = 1000; // reset backoff
        this.startPingInterval();
        this.onConnectionChange?.(true);
        resolve();
      };
      this.ws.onclose = () => {
        this.stopPingInterval();
        const wasConnected = this.connected;
        this.connected = false;
        if (wasConnected) {
          this.onConnectionChange?.(false);
        }
        this.scheduleReconnect();
      };
      this.ws.onerror = () => {
        if (!this.connected) reject(new Error('WebSocket connection failed'));
      };
    });
  }

  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // send failed — connection is dead
          this.forceReconnect();
          return;
        }
        this.pingTimeout = setTimeout(() => {
          // No message received within 5s of ping — assume stale
          console.warn('[WS] Ping timeout, forcing reconnect');
          this.forceReconnect();
        }, 5000);
      }
    }, 30000);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.clearPingTimeout();
  }

  private clearPingTimeout(): void {
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }
  }

  private forceReconnect(): void {
    this.stopPingInterval();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      // Detach handlers so the closing WS doesn't trigger scheduleReconnect
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) {
      this.onConnectionChange?.(false);
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    // Add ±20% jitter to prevent thundering herd
    const jitter = this.reconnectDelay * (0.8 + Math.random() * 0.4);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connectWs();
      } catch {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        this.scheduleReconnect();
      }
    }, jitter);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopPingInterval();
    this.teardownVisibilityHandler();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (this.authExpired) {
      throw new Error('Authentication expired. Please reconnect with a valid token.');
    }

    if (!this.config.baseUrl) {
      throw new Error('Not connected to a server');
    }

    const spec = COMMAND_MAP[command];
    if (!spec) throw new Error(`Unknown command: ${command}`);

    const path = typeof spec.path === 'function' ? spec.path(args ?? {}) : spec.path;
    const url = `${this.config.baseUrl}${path}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config.authToken}`,
    };

    const fetchOpts: RequestInit = { method: spec.method, headers };

    if (spec.argsMode === 'body' && args) {
      headers['Content-Type'] = 'application/json';
      fetchOpts.body = JSON.stringify(spec.transformArgs ? spec.transformArgs(args) : args);
    }

    const resp = await fetch(url, fetchOpts);

    if (!resp.ok) {
      if (resp.status === 401) {
        // Token is invalid or revoked — stop all activity and trigger logout
        this.authExpired = true;
        this.disconnect();
        localStorage.removeItem('atomic-server-config');
        window.dispatchEvent(new CustomEvent('atomic:auth-expired'));
        throw new Error('Authentication expired. Please reconnect with a valid token.');
      }
      const text = await resp.text();
      let errorMsg: string;
      try {
        const errJson = JSON.parse(text);
        errorMsg = errJson.error || text;
      } catch {
        errorMsg = text;
      }
      throw errorMsg;
    }

    // Some endpoints return no body (204 or empty)
    const contentType = resp.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      return undefined as T;
    }

    const data = await resp.json();
    return (spec.transformResponse ? spec.transformResponse(data) : data) as T;
  }

  subscribe<T>(event: string, callback: (payload: T) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const subs = this.listeners.get(event)!;
    subs.add(callback);
    return () => { subs.delete(callback); };
  }
}
