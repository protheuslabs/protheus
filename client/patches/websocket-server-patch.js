/**
 * WebSocket Stability Patch - Server Side
 * 
 * Implements heartbeat (ping/pong) and event replay for OpenClaw Gateway.
 * 
 * To apply: Include this file in your gateway startup or inject into
 * the WebSocketServer creation point.
 */

const { WebSocketServer } = require('ws');
const crypto = require('crypto');

// Configuration
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.WS_HEARTBEAT_INTERVAL_MS) || 20000;
const HEARTBEAT_TIMEOUT_MS = parseInt(process.env.WS_HEARTBEAT_TIMEOUT_MS) || 60000;
const EVENT_BUFFER_SIZE = parseInt(process.env.WS_EVENT_BUFFER_SIZE) || 500;
const EVENT_BUFFER_AGE_MS = parseInt(process.env.WS_EVENT_BUFFER_AGE_MS) || 10 * 60 * 1000; // 10 min
const DEBUG = process.env.WS_DEBUG === '1';

// Global event buffer for replay
class EventBuffer {
  constructor() {
    this.events = [];
    this.lastEventId = 0;
  }
  
  add(data) {
    this.lastEventId++;
    const event = {
      id: this.lastEventId,
      timestamp: Date.now(),
      data: data
    };
    this.events.push(event);
    this.prune();
    return event.id;
  }
  
  prune() {
    const cutoff = Date.now() - EVENT_BUFFER_AGE_MS;
    // Keep events within age limit and under max size
    this.events = this.events.filter(e => 
      e.timestamp > cutoff
    ).slice(-EVENT_BUFFER_SIZE);
  }
  
  // Get events since a specific ID
  getSince(lastId) {
    const idx = this.events.findIndex(e => e.id > lastId);
    if (idx === -1) return [];
    return this.events.slice(idx);
  }
  
  // Check if ID is too old (outside buffer)
  isIdTooOld(lastId) {
    if (this.events.length === 0) return false;
    return lastId < this.events[0].id;
  }
}

// Global event buffer instance
const globalEventBuffer = new EventBuffer();

/**
 * Patch a WebSocketServer to add heartbeat and event replay
 */
function patchWebSocketServer(wss) {
  wss.on('connection', (ws, req) => {
    const socketId = crypto.randomUUID().slice(0, 8);
    const startTime = Date.now();
    
    // Socket state
    ws._socketId = socketId;
    ws._lastPing = Date.now();
    ws._lastPong = Date.now();
    ws._subscribed = false;
    ws._lastEventId = 0;
    
    log('INFO', socketId, 'Client connected', {
      ip: req.socket.remoteAddress,
      url: req.url
    });
    
    // Send welcome with current event position
    ws.send(JSON.stringify({
      type: 'connected',
      socket_id: socketId,
      current_event_id: globalEventBuffer.lastEventId,
      server_time: Date.now()
    }));
    
    // Setup heartbeat
    ws._heartbeatInterval = setInterval(() => {
      if (ws.readyState !== 1) return; // OPEN
      
      // Check for pong timeout
      const timeSinceLastPong = Date.now() - ws._lastPong;
      if (timeSinceLastPong > HEARTBEAT_TIMEOUT_MS) {
        closeWithLog(ws, 'server', 1001, 'heartbeat_timeout', {
          duration_ms: Date.now() - startTime,
          last_ping_ms: Date.now() - ws._lastPing,
          last_pong_ms: timeSinceLastPong
        });
        return;
      }
      
      // Send ping
      ws._lastPing = Date.now();
      try {
        ws.send(JSON.stringify({ type: 'ping', timestamp: ws._lastPing }));
        if (DEBUG) {
          log('DEBUG', socketId, 'Ping sent');
        }
      } catch (err) {
        log('WARN', socketId, 'Failed to send ping', err.message);
      }
    }, HEARTBEAT_INTERVAL_MS);
    
    // Handle messages
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        
        // Handle pong
        if (msg.type === 'pong') {
          ws._lastPong = Date.now();
          if (DEBUG) {
            const rtt = ws._lastPong - (msg.timestamp || ws._lastPong);
            log('DEBUG', socketId, `Pong received (rtt: ${rtt}ms)`);
          }
          return;
        }
        
        // Handle subscription request
        if (msg.type === 'subscribe') {
          ws._subscribed = true;
          ws._lastEventId = msg.last_event_id || 0;
          
          log('INFO', socketId, 'Client subscribed', {
            last_event_id: ws._lastEventId
          });
          
          // Check if last_event_id is too old
          if (ws._lastEventId > 0 && globalEventBuffer.isIdTooOld(ws._lastEventId)) {
            log('WARN', socketId, 'Last event ID too old, sending resync_required');
            ws.send(JSON.stringify({
              type: 'resync_required',
              current_event_id: globalEventBuffer.lastEventId,
              message: 'Buffered events exceeded, fetch latest via HTTP'
            }));
          } else {
            // Replay missed events
            const missedEvents = globalEventBuffer.getSince(ws._lastEventId);
            if (missedEvents.length > 0) {
              log('INFO', socketId, `Replaying ${missedEvents.length} missed events`);
              for (const event of missedEvents) {
                ws.send(JSON.stringify({
                  type: 'event',
                  event_id: event.id,
                  event_time: event.timestamp,
                  data: event.data
                }));
              }
            }
            
            // Send caught up
            ws.send(JSON.stringify({
              type: 'caught_up',
              current_event_id: globalEventBuffer.lastEventId
            }));
          }
          return;
        }
        
        // Handle other messages here...
        if (DEBUG) {
          log('DEBUG', socketId, 'Message received', msg.type);
        }
        
      } catch (err) {
        log('WARN', socketId, 'Failed to parse message', err.message);
      }
    });
    
    // Handle close
    ws.on('close', (code, reason) => {
      logClose(ws, 'client', code, reason?.toString() || '',
        Date.now() - startTime);
      cleanup(ws);
    });
    
    // Handle error
    ws.on('error', (err) => {
      log('ERROR', socketId, 'Socket error', err.message);
    });
    
    // Cleanup on socket end
    ws.on('end', () => cleanup(ws));
  });
  
  log('INFO', 'server', 'WebSocket server patched', {
    heartbeat_interval: HEARTBEAT_INTERVAL_MS,
    heartbeat_timeout: HEARTBEAT_TIMEOUT_MS,
    buffer_size: EVENT_BUFFER_SIZE,
    buffer_age: EVENT_BUFFER_AGE_MS
  });
}

function cleanup(ws) {
  if (ws._heartbeatInterval) {
    clearInterval(ws._heartbeatInterval);
    ws._heartbeatInterval = null;
  }
}

function closeWithLog(ws, initiator, code, reason, extra = {}) {
  const socketId = ws._socketId || 'unknown';
  log('INFO', socketId, `Closing socket`, {
    close_initiator: initiator,
    code,
    reason,
    ...extra
  });
  cleanup(ws);
  try {
    ws.close(code, reason);
  } catch (err) {
    // Ignore close errors
  }
}

function logClose(ws, initiator, code, reason, durationMs) {
  const socketId = ws._socketId || 'unknown';
  const lastPing = ws._lastPing ? Date.now() - ws._lastPing : null;
  const lastPong = ws._lastPong ? Date.now() - ws._lastPong : null;
  
  log('INFO', socketId, 'Socket closed', {
    close_initiator: initiator,
    code,
    reason: reason || '(no reason)',
    duration_ms: durationMs,
    last_ping_ms: lastPing,
    last_pong_ms: lastPong
  });
}

function log(level, socketId, message, data = null) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] [${socketId}] ${message}` +
    (data ? ` ${JSON.stringify(data)}` : '');
  console.log(line);
}

// Export for use
module.exports = {
  patchWebSocketServer,
  globalEventBuffer,
  EventBuffer
};