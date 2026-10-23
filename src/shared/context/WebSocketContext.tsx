import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@/modules/auth';
import { IS_PLATFORM } from '@/shared/utils';
import { expireAuthSession, isAuthTokenExpired } from '@/shared/authToken';
import type { ServerEvent } from '@/shared/types';


type ServerEventListener = (event: ServerEvent) => void;

/** A command waiting to reach the server: sent again after a reconnect until a pong confirms it arrived. */
type OutgoingFrame = { frameId: string; payload: Record<string, unknown> };

/**
 * How long a ping may go unanswered before the socket counts as dead. A phone
 * waking from the background often holds a socket the server closed long ago
 * (half-open): `readyState` still says OPEN and `send` writes into nothing
 * until the OS gives up a minute or more later. Generous for a slow mobile
 * path; a false alarm only reconnects and resends, which the server dedupes.
 */
const PONG_TIMEOUT_MS = 8000;

const newFrameId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames cannot be coalesced or
   * dropped. Frames are deliberately not copied into React state; each
   * listener updates only the state owned by the feature that handles it.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  if (isAuthTokenExpired(token)) {
    expireAuthSession();
    return null;
  }
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Commands sent while no socket was open, in order; written as soon as one opens.
  const outboxRef = useRef<OutgoingFrame[]>([]);
  // Commands written to the current socket whose arrival no pong has confirmed yet, each with the ping sent after it.
  const unconfirmedRef = useRef<Array<OutgoingFrame & { pingId: number }>>([]);
  const pingSeqRef = useRef(0);
  // Ids of the pings the current socket has not answered yet, oldest first (the server answers in order).
  const outstandingPingsRef = useRef<number[]>([]);
  const pongTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // The latest `connect`, for the timers and listeners that outlive a render.
  const connectRef = useRef<() => void>(() => undefined);
  const { isLoading: isAuthLoading, token, user } = useAuth();

  const clearPongTimeout = useCallback(() => {
    if (pongTimeoutRef.current) {
      clearTimeout(pongTimeoutRef.current);
      pongTimeoutRef.current = null;
    }
  }, []);

  // A socket that went away may have taken unconfirmed commands with it: they go back to the front of the outbox.
  const requeueUnconfirmed = useCallback(() => {
    clearPongTimeout();
    outstandingPingsRef.current = [];
    if (unconfirmedRef.current.length > 0) {
      outboxRef.current = [...unconfirmedRef.current.map(({ frameId, payload }) => ({ frameId, payload })), ...outboxRef.current];
      unconfirmedRef.current = [];
    }
  }, [clearPongTimeout]);

  // Gives up on a socket that stopped answering and opens a new one at once.
  const dropDeadSocket = useCallback((socket: WebSocket) => {
    if (wsRef.current !== socket) return;
    console.warn('WebSocket stopped answering; reconnecting');
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try { socket.close(); } catch { /* already gone */ }
    wsRef.current = null;
    setIsConnected(false);
    requeueUnconfirmed();
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    if (!unmountedRef.current) connectRef.current();
  }, [requeueUnconfirmed]);

  // Asks the server for a pong; none within PONG_TIMEOUT_MS means the socket is dead. Returns the ping's id.
  const probe = useCallback((socket: WebSocket) => {
    const pingId = ++pingSeqRef.current;
    socket.send(JSON.stringify({ type: 'ping', id: pingId }));
    outstandingPingsRef.current.push(pingId);
    if (!pongTimeoutRef.current) {
      pongTimeoutRef.current = setTimeout(() => {
        pongTimeoutRef.current = null;
        dropDeadSocket(socket);
      }, PONG_TIMEOUT_MS);
    }
    return pingId;
  }, [dropDeadSocket]);

  // Frames arrive in order, so the pong for a ping confirms every command written before it.
  const handlePong = useCallback((socket: WebSocket, pongId: unknown) => {
    if (typeof pongId !== 'number') return;
    outstandingPingsRef.current = outstandingPingsRef.current.filter((id) => id > pongId);
    unconfirmedRef.current = unconfirmedRef.current.filter((frame) => frame.pingId > pongId);
    clearPongTimeout();
    if (pongId < pingSeqRef.current) {
      // later pings are still out: keep watching for their pongs
      pongTimeoutRef.current = setTimeout(() => {
        pongTimeoutRef.current = null;
        dropDeadSocket(socket);
      }, PONG_TIMEOUT_MS);
    }
  }, [clearPongTimeout, dropDeadSocket]);

  const writeFrame = useCallback((socket: WebSocket, frame: OutgoingFrame) => {
    socket.send(JSON.stringify({ ...frame.payload, frameId: frame.frameId }));
    unconfirmedRef.current.push({ ...frame, pingId: probe(socket) });
  }, [probe]);

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
  }, []);

  // Named function expression so the reconnect timer below can call itself
  // without reading the `connect` binding while it is still initializing.
  const connect = useCallback(function connect() {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    if (!IS_PLATFORM && (isAuthLoading || !user)) return;
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);
      // Store connecting sockets too, so a token refresh can close them before
      // their handshake completes with stale credentials.
      wsRef.current = websocket;

      websocket.onopen = () => {
        setIsConnected(true);
        // Commands sent while disconnected (or lost with the last socket) go first, in order.
        const queued = outboxRef.current;
        outboxRef.current = [];
        for (const frame of queued) writeFrame(websocket, frame);
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          const frame = data as { kind?: unknown; id?: unknown; code?: unknown; error?: unknown };
          if (frame.kind === 'pong') {
            handlePong(websocket, frame.id);
            return;
          }
          // A runtime still on the previous release (a deploy defers restarting one with live sessions) does not know
          // `ping` and says so — which equally proves the ping, and every frame before it, arrived. Without this the
          // socket counted as dead every 8 s and reconnected in a loop until that runtime restarted.
          if (frame.kind === 'protocol_error' && frame.code === 'UNKNOWN_MESSAGE_TYPE' && typeof frame.error === 'string' && frame.error.includes('"ping"')) {
            handlePong(websocket, outstandingPingsRef.current[0]);
            return;
          }
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        if (wsRef.current !== websocket) {
          return;
        }
        setIsConnected(false);
        wsRef.current = null;
        requeueUnconfirmed();

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [dispatch, handlePong, isAuthLoading, requeueUnconfirmed, token, user, writeFrame]); // reconnect with current authentication state

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // Declared after `connect` so the effect body does not reference it before
  // initialization. `connect` is memoized on [dispatch, isAuthLoading, token,
  // user] and `dispatch` is stable, so depending on it reconnects on exactly
  // the same transitions as the previous [isAuthLoading, token, user] list.
  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    if (!IS_PLATFORM && (isAuthLoading || !user)) {
      return undefined;
    }
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      const activeSocket = wsRef.current;
      if (activeSocket) {
        // Prevent the intentionally closed, old-token socket from scheduling
        // a reconnect after the refreshed-token effect has already started.
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onclose = null;
        activeSocket.onerror = null;
        activeSocket.close();
        wsRef.current = null;
      }
      requeueUnconfirmed();
    };
  }, [connect, isAuthLoading, requeueUnconfirmed, user]); // reconnect after authentication or token refresh

  // Coming back to the app (or back online) is when a socket is most likely dead without knowing it: check at once
  // rather than when the next command vanishes into it, and reconnect now instead of on a timer the OS held back.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'hidden' || unmountedRef.current) return;
      const socket = wsRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        probe(socket);
      } else if (!socket) {
        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
        connectRef.current();
      }
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    window.addEventListener('pageshow', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', check);
      window.removeEventListener('pageshow', check);
    };
  }, [probe]);

  useEffect(() => () => clearPongTimeout(), [clearPongTimeout]);

  // Commands are never dropped: without an open socket they wait in the outbox, and once written they are sent again
  // after a reconnect until a pong confirms them. `chat.subscribe` is the exception — every screen subscribes again
  // on each (re)connect, so a queued copy would only replay twice.
  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    const payload = message as Record<string, unknown>;
    if (payload?.type === 'chat.subscribe') {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      return;
    }
    const frame: OutgoingFrame = { frameId: newFrameId(), payload };
    if (socket && socket.readyState === WebSocket.OPEN) {
      writeFrame(socket, frame);
    } else {
      console.warn('WebSocket not connected; the command is sent when it reconnects');
      outboxRef.current.push(frame);
    }
  }, [writeFrame]);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    isConnected
  }), [sendMessage, subscribe, isConnected]);

  return value;
};

/** Mounted once by App; owns the single chat websocket that the chat, project-workspace and task-master modules subscribe to. */
export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
