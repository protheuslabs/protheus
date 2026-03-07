/**
 * WebSocket Stability Patch - Client Side (Control-UI)
 * 
 * Implements reconnect with exponential backoff and event replay catch-up.
 * 
 * To apply: Include this file BEFORE control-ui bundle loads.
 * 
 * <script src="/client/patches/websocket-client-patch.js"></script>
 * <script type="module" src="./assets/index-B4LPvte9.js"></script>
 */

(function() {
  'use strict';
  
  // Configuration
  const RECONNECT_BASE_DELAY = 250;    // ms
  const RECONNECT_MAX_DELAY = 5000;    // ms
  const MAX_RECONNECT_ATTEMPTS = 100;  // high limit
  const EVENT_BUFFER_WARNING = 400;    // warn when approaching buffer limit
  
  const DEBUG = location.search.includes('ws_debug=1');
  
  // Track last event ID for replay
  let lastEventId = parseInt(sessionStorage.getItem('ws_last_event_id')) || 0;
  let eventSeqCounter = 0;
  
  // Store original WebSocket
  const OriginalWebSocket = window.WebSocket;
  
  /**
   * Resilient WebSocket with automatic reconnect and event replay
   */
  class ResilientWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.ws = null;
      this.reconnectAttempts = 0;
      this.shouldReconnect = true;
      this.eventBuffer = [];
      this.connectedResolvers = [];
      
      // Connect immediately
      this.connect();
      
      // Return a proxy that behaves like native WebSocket
      return this.createProxy();
    }
    
    connect() {
      if (!this.shouldReconnect) return;
      
      log('INFO', `Connecting to ${this.url}...`);
      
      try {
        this.ws = new OriginalWebSocket(this.url, this.protocols);
        this.connectTime = Date.now();
        
        this.ws.addEventListener('open', (e) => {
          log('SUCCESS', 'Connected');
          this.reconnectAttempts = 0;
          
          // Resolve pending connected promises
          while (this.connectedResolvers.length > 0) {
            const resolve = this.connectedResolvers.shift();
            resolve();
          }
          
          // Subscribe to chat stream with last_event_id
          this.subscribe();
          
          // Re-dispatch open event
          this.dispatchEvent(new Event('open'));
        });
        
        this.ws.addEventListener('message', (e) => {
          try {
            const msg = JSON.parse(e.data);
            
            // Handle server-side events
            switch (msg.type) {
              case 'ping':
                // Respond with pong
                this.send(JSON.stringify({
                  type: 'pong',
                  timestamp: msg.timestamp
                }));
                return;
                
              case 'connected':
                log('INFO', `Server assigned socket: ${msg.socket_id}`);
                return;
                
              case 'caught_up':
                log('INFO', `Caught up to event ${msg.current_event_id}`);
                return;
                
              case 'resync_required':
                log('WARN', 'Events too old, need to resync via HTTP');
                this.triggerResync();
                return;
                
              case 'event':
                // Update last_event_id
                if (msg.event_id > lastEventId) {
                  lastEventId = msg.event_id;
                  sessionStorage.setItem('ws_last_event_id', lastEventId);
                }
                // Re-dispatch as regular message
                this.dispatchEvent(e);
                return;
            }
          } catch (err) {
            // Not JSON, pass through
          }
          
          // Track event IDs from messages that have them
          try {
            const data = JSON.parse(e.data);
            if (data.event_id) {
              lastEventId = Math.max(lastEventId, data.event_id);
              sessionStorage.setItem('ws_last_event_id', lastEventId);
            }
          } catch (err) {
            // Ignore
          }
          
          // Re-dispatch message event
          this.dispatchEvent(e);
        });
        
        this.ws.addEventListener('close', (e) => {
          log('WARN', `Closed: code=${e.code}, reason="${e.reason}", clean=${e.wasClean}`);
          
          // Don't reconnect on clean close (1000)
          if (e.code === 1000) {
            this.shouldReconnect = false;
            log('INFO', 'Clean close, no reconnect');
          } else {
            this.reconnect();
          }
          
          // Re-dispatch close event
          this.dispatchEvent(e);
        });
        
        this.ws.addEventListener('error', (e) => {
          log('ERROR', 'WebSocket error', e);
          this.dispatchEvent(e);
        });
        
      } catch (err) {
        log('ERROR', 'Failed to create WebSocket', err);
        this.reconnect();
      }
    }
    
    subscribe() {
      log('INFO', `Subscribing with last_event_id=${lastEventId}`);
      this.send(JSON.stringify({
        type: 'subscribe',
        last_event_id: lastEventId,
        timestamp: Date.now()
      }));
    }
    
    reconnect() {
      if (!this.shouldReconnect) return;
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        log('ERROR', 'Max reconnect attempts reached');
        return;
      }
      
      this.reconnectAttempts++;
      
      // Exponential backoff: 250ms → 500ms → 1s → 2s → 5s (max)
      const delay = Math.min(
        RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts - 1),
        RECONNECT_MAX_DELAY
      ) + Math.random() * 200; // Add jitter
      
      log('INFO', `Reconnecting in ${delay.toFixed(0)}ms (attempt #${this.reconnectAttempts})...`);
      
      setTimeout(() => this.connect(), delay);
    }
    
    triggerResync() {
      // Fetch latest state via HTTP
      log('INFO', 'Fetching resync via HTTP...');
      
      fetch('/api/chat/latest?since=' + lastEventId)
        .then(r => r.json())
        .then(data => {
          log('INFO', `Resync got ${data.events?.length || 0} events`);
          if (data.events) {
            for (const event of data.events) {
              if (event.id > lastEventId) {
                lastEventId = event.id;
                sessionStorage.setItem('ws_last_event_id', lastEventId);
              }
              // Dispatch as synthetic message
              const syntheticEvent = new MessageEvent('message', {
                data: JSON.stringify(event.data),
                origin: location.origin
              });
              this.dispatchEvent(syntheticEvent);
            }
          }
        })
        .catch(err => {
          log('ERROR', 'Resync failed', err);
        });
    }
    
    createProxy() {
      const self = this;
      const eventTarget = document.createElement('div');
      
      return new Proxy({}, {
        get(target, prop) {
          // EventTarget methods
          if (['addEventListener', 'removeEventListener', 'dispatchEvent'].includes(prop)) {
            return (...args) => eventTarget[prop](...args);
          }
          
          // Passthrough to current WebSocket
          if (self.ws && prop in self.ws) {
            const val = self.ws[prop];
            return typeof val === 'function' ? val.bind(self.ws) : val;
          }
          
          // Our own properties
          if (prop in self) {
            const val = self[prop];
            return typeof val === 'function' ? val.bind(self) : val;
          }
          
          // Ready state is dynamic
          if (prop === 'readyState') {
            return self.ws?.readyState ?? OriginalWebSocket.CLOSED;
          }
          
          return undefined;
        },
        set(target, prop, value) {
          if (self.ws) {
            self.ws[prop] = value;
          }
          return true;
        }
      });
    }
    
    close(code = 1000, reason) {
      this.shouldReconnect = false;
      if (this.ws) {
        this.ws.close(code, reason);
      }
    }
    
    send(data) {
      if (this.ws?.readyState === OriginalWebSocket.OPEN) {
        this.ws.send(data);
      } else {
        log('WARN', 'Tried to send on non-open socket');
      }
    }
  }
  
  // Logging
  function log(level, message, data) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [WS-CLIENT] [${level}] ${message}`;
    if (DEBUG || level !== 'DEBUG') {
      console.log(line, data || '');
    }
  }
  
  // Replace global WebSocket
  window.WebSocket = ResilientWebSocket;
  
  // Store original on window for debugging
  window.OriginalWebSocket = OriginalWebSocket;
  
  console.log('[WebSocket Client Patch] Loaded with:', {
    reconnect_base: RECONNECT_BASE_DELAY,
    reconnect_max: RECONNECT_MAX_DELAY,
    last_event_id: lastEventId,
    debug: DEBUG
  });
  
})();