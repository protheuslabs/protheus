/**
 * WebSocket Heartbeat Patch for OpenClaw Control UI
 * 
 * This patch adds automatic ping/pong heartbeat to WebSocket connections
 * to prevent idle timeouts and code=1001 disconnects.
 * 
 * Usage:
 * 1. For browser: Load this script BEFORE the main app loads
 *    <script src="/client/patches/websocket-heartbeat.js"></script>
 * 
 * 2. For Node.js server: Import at startup
 *    require('./patches/websocket-heartbeat.js');
 * 
 * Configuration (environment variables):
 *   WS_HEARTBEAT_INTERVAL_MS=20000  (ping interval, default 20s)
 *   WS_HEARTBEAT_TIMEOUT_MS=60000   (pong timeout, default 60s)
 *   WS_DEBUG=1                      (enable debug logging)
 */

(function() {
  'use strict';
  
  // Configuration
  const HEARTBEAT_INTERVAL = parseInt(process?.env?.WS_HEARTBEAT_INTERVAL_MS) || 20000;
  const HEARTBEAT_TIMEOUT = parseInt(process?.env?.WS_HEARTBEAT_TIMEOUT_MS) || 60000;
  const DEBUG = process?.env?.WS_DEBUG === '1' || false;
  
  // Store original WebSocket
  const OriginalWebSocket = globalThis.WebSocket;
  
  if (!OriginalWebSocket) {
    console.warn('[WebSocket Patch] WebSocket not available in this environment');
    return;
  }
  
  // Track patched sockets
  const socketMeta = new WeakMap();
  
  /**
   * Patched WebSocket with heartbeat
   */
  class HeartbeatWebSocket extends OriginalWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      
      const socketId = Math.random().toString(36).slice(2, 10);
      const meta = {
        id: socketId,
        url: url,
        connected: false,
        lastPing: null,
        lastPong: null,
        pingInterval: null,
        timeoutTimer: null,
        closeInitiator: null // 'client', 'server', 'error', 'timeout'
      };
      socketMeta.set(this, meta);
      
      if (DEBUG) {
        console.log(`[WS:${socketId}] Created: ${url}`);
      }
      
      // Setup heartbeat on open
      this.addEventListener('open', () => {
        meta.connected = true;
        meta.lastPong = Date.now();
        
        if (DEBUG) {
          console.log(`[WS:${socketId}] Opened, starting heartbeat (${HEARTBEAT_INTERVAL}ms)`);
        }
        
        // Start ping interval
        meta.pingInterval = setInterval(() => {
          this._sendPing();
        }, HEARTBEAT_INTERVAL);
        
        // Check for pong timeout
        meta.timeoutTimer = setInterval(() => {
          const timeSinceLastPong = Date.now() - meta.lastPong;
          if (timeSinceLastPong > HEARTBEAT_TIMEOUT) {
            console.error(`[WS:${socketId}] Pong timeout! No response in ${timeSinceLastPong}ms`);
            meta.closeInitiator = 'timeout';
            this.close(1001, 'Heartbeat timeout');
          }
        }, HEARTBEAT_TIMEOUT / 2);
      });
      
      // Track pong messages
      this.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'pong') {
            meta.lastPong = Date.now();
            if (DEBUG) {
              console.log(`[WS:${socketId}] Pong received (latency: ${meta.lastPong - meta.lastPing}ms)`);
            }
          }
        } catch (e) {
          // Not a JSON message or not a pong, ignore
        }
      });
      
      // Track close events
      this.addEventListener('close', (event) => {
        meta.connected = false;
        
        if (!meta.closeInitiator) {
          // Determine close initiator
          if (event.wasClean) {
            meta.closeInitiator = event.code === 1000 ? 'client' : 'server';
          } else {
            meta.closeInitiator = 'error';
          }
        }
        
        // Cleanup
        if (meta.pingInterval) {
          clearInterval(meta.pingInterval);
          meta.pingInterval = null;
        }
        if (meta.timeoutTimer) {
          clearInterval(meta.timeoutTimer);
          meta.timeoutTimer = null;
        }
        
        console.log(`[WS:${socketId}] Closed: code=${event.code} reason="${event.reason}" initiator=${meta.closeInitiator}`);
      });
      
      // Track errors
      this.addEventListener('error', (event) => {
        console.error(`[WS:${socketId}] Error:`, event);
      });
    }
    
    _sendPing() {
      const meta = socketMeta.get(this);
      if (!meta || !meta.connected) return;
      
      meta.lastPing = Date.now();
      
      try {
        this.send(JSON.stringify({ type: 'ping', timestamp: meta.lastPing }));
        if (DEBUG) {
          console.log(`[WS:${meta.id}] Ping sent`);
        }
      } catch (err) {
        console.error(`[WS:${meta.id}] Failed to send ping:`, err);
      }
    }
    
    close(code, reason) {
      const meta = socketMeta.get(this);
      if (meta && !meta.closeInitiator) {
        meta.closeInitiator = 'client';
      }
      
      // Cleanup timers before close
      if (meta) {
        if (meta.pingInterval) {
          clearInterval(meta.pingInterval);
          meta.pingInterval = null;
        }
        if (meta.timeoutTimer) {
          clearInterval(meta.timeoutTimer);
          meta.timeoutTimer = null;
        }
      }
      
      return super.close(code, reason);
    }
  }
  
  // Copy static properties
  Object.setPrototypeOf(HeartbeatWebSocket, OriginalWebSocket);
  HeartbeatWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  HeartbeatWebSocket.OPEN = OriginalWebSocket.OPEN;
  HeartbeatWebSocket.CLOSING = OriginalWebSocket.CLOSING;
  HeartbeatWebSocket.CLOSED = OriginalWebSocket.CLOSED;
  
  // Replace global WebSocket
  globalThis.WebSocket = HeartbeatWebSocket;
  
  console.log('[WebSocket Patch] Heartbeat enabled:', {
    interval: HEARTBEAT_INTERVAL + 'ms',
    timeout: HEARTBEAT_TIMEOUT + 'ms',
    debug: DEBUG
  });
  
})();