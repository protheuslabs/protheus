# WebSocket Stability Patch - Implementation Guide

## Overview

Fixes OpenClaw Control UI "missing chat until refresh" caused by WebSocket disconnects (code=1001) with:

1. **Server-side heartbeat**: Ping every 20s, kill socket if no pong within 60s
2. **Client auto-reconnect**: Exponential backoff (250ms → 5s max)
3. **Event replay**: Buffer last 500 events / 10 minutes, replay on reconnect
4. **Last event ID tracking**: Client stores last seen, requests catch-up

## Files

| File | Purpose |
|------|---------|
| `client/patches/websocket-server-patch.js` | Server-side heartbeat + event buffer |
| `client/patches/websocket-client-patch.js` | Client-side reconnect + catch-up |
| `client/logs/websocket-stability-example.log` | Example log output |

## Quick Start

### Option A: Apply to Gateway Server

1. **Include server patch** in your gateway startup:
   ```javascript
   // In your gateway server file
   const { patchWebSocketServer } = require('./client/patches/websocket-server-patch.js');
   
   const wss = new WebSocketServer({ port: 18789 });
   patchWebSocketServer(wss);
   ```

2. **Serve client patch** from your control-ui:
   ```html
   <!-- In control-ui/index.html, BEFORE main bundle -->
   <script src="/client/patches/websocket-client-patch.js"></script>
   <script type="module" src="./assets/index-B4LPvte9.js"></script>
   ```

3. **Set environment variables**:
   ```bash
   export WS_HEARTBEAT_INTERVAL_MS=20000
   export WS_HEARTBEAT_TIMEOUT_MS=60000
   export WS_EVENT_BUFFER_SIZE=500
   export WS_EVENT_BUFFER_AGE_MS=600000
   export WS_DEBUG=1  # Optional: enable debug logging
   ```

### Option B: Minimal Patch (Control-UI Only)

If you can't modify the server, inject the client patch via Tampermonkey or similar:

```javascript
// ==UserScript==
// @name OpenClaw WS Patch
// @match http://127.0.0.1:18789/*
// @run-at document-start
// ==/UserScript==

// Paste contents of websocket-client-patch.js here
```

## Configuration

### Environment Variables

```bash
# Server-side
WS_HEARTBEAT_INTERVAL_MS=20000     # Ping interval (default: 20s)
WS_HEARTBEAT_TIMEOUT_MS=60000      # Pong timeout (default: 60s)
WS_EVENT_BUFFER_SIZE=500           # Max events to buffer (default: 500)
WS_EVENT_BUFFER_AGE_MS=600000      # Max event age in ms (default: 10min)
WS_DEBUG=1                         # Enable debug logging

# Client-side (via URL or global config)
# Add ?ws_debug=1 to control-ui URL for client debug logging
```

### Tuning Guidelines

| Scenario | Interval | Timeout | Buffer | Age |
|----------|----------|---------|--------|-----|
| Local dev | 20s | 60s | 100 | 10min |
| Production | 20s | 60s | 500 | 10min |
| High volume | 10s | 30s | 1000 | 5min |
| Low volume | 30s | 90s | 100 | 30min |
| Unreliable network | 10s | 30s | 500 | 10min |

## Testing

### 5-Minute Stability Test

```bash
node tests/websocket-stability-test.js 5 ws://127.0.0.1:18789/
```

Expected output:
- Connects: ~3-5 (reconnects are normal)
- Disconnects: ~2-4 (handled gracefully)
- Events replayed: All messages visible without refresh
- Result: ✅ STABLE

### Manual Test

1. Open control UI
2. Send a message in chat
3. Minimize/background the tab for 60 seconds
4. Return to tab
5. **Expected**: No refresh needed, all messages visible

## How It Works

### Message Flow

```
Client                        Server
  |                             |
  |-- connect ---------------->|
  |                             |
  |<-- connected (socket_id) ---|
  |                             |
  |-- subscribe (last_id: N)->|
  |                             |
  |<-- replay events N+1..M --|
  |<-- caught_up ---------------|
  |                             |
  |-- ping ------------------->|  (every 20s)
  |<-- pong --------------------|  (response)
  |                             |
  |... time passes ...          |
  |                             |
  |<-- event (event_id: M+1) --|
  |                             |
  |-- [connection drops]         |
  |                             |
  |-- reconnect -------------->|
  |-- subscribe (last_id: M)->|
  |                             |
  |<-- replay events M+1..P --|
  |<-- caught_up ---------------|
  |                             |
```

### Close Initiator Logging

Servers log WHO closed the connection:

```
close_initiator=client   # Client called ws.close()
close_initiator=server   # Server sent close frame  
close_initiator=timeout  # Server killed idle socket
close_initiator=error    # Connection dropped (network)
```

## Debugging

Enable debug logging:

```bash
# Server
WS_DEBUG=1 node gateway.js

# Client (browser)
# Add ?ws_debug=1 to URL
http://127.0.0.1:18789/?ws_debug=1
```

Check browser console for:
- `[WS-CLIENT] [INFO] Reconnected` 
- `[WS-CLIENT] [INFO] Caught up to event X`
- `[WS-CLIENT] [INFO] N events replayed`

## Integration Points

### Existing Gateway Code

Find where `WebSocketServer` is created and insert patch:

```javascript
// Example integration point in Chrome extension handler
const { patchWebSocketServer } = require('./client/patches/websocket-server-patch.js');

const wssExtension = new WebSocketServer({ noServer: true });
patchWebSocketServer(wssExtension);

const wssCdp = new WebSocketServer({ noServer: true });
patchWebSocketServer(wssCdp);
```

### Control-UI Integration

The client patch wraps the native WebSocket and adds:
- Persistent `lastEventId` in sessionStorage
- Automatic subscription on connect
- Message ID tracking for replay
- Exponential backoff reconnect

## Limitations

1. **Server buffer size**: Maximum 500 events retained (configurable)
2. **Event age**: Events older than 10 minutes not buffered (configurable)
3. **Client ID storage**: `last_event_id` stored in sessionStorage (lost on new tab)

## Troubleshooting

### "resync_required" warnings

Client's `last_event_id` is too old (outside buffer). Server can't replay.

**Fix**: Increase buffer size or age:
```bash
WS_EVENT_BUFFER_SIZE=1000
WS_EVENT_BUFFER_AGE_MS=1800000  # 30 minutes
```

### Frequent 1006 errors (Abnormal Closure)

Network instability or proxy killing connections.

**Fix**: Reduce heartbeat interval to detect issues faster:
```bash
WS_HEARTBEAT_INTERVAL_MS=10000  # 10s
WS_HEARTBEAT_TIMEOUT_MS=30000   # 30s
```

### Messages still missing after reconnect

Check that server is assigning event IDs to messages.

**Fix**: Ensure your message broadcasting uses:
```javascript
const eventId = globalEventBuffer.add(messageData);
ws.send(JSON.stringify({ type: 'event', event_id: eventId, data: messageData }));
```