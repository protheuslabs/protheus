#!/usr/bin/env node
/**
 * WebSocket Stability Test
 * 
 * Monitors WebSocket connection for disconnects over specified duration.
 * 
 * Usage:
 *   node websocket-stability-test.js [duration_minutes] [url]
 * 
 * Examples:
 *   node websocket-stability-test.js 2
 *   node websocket-stability-test.js 5 ws://127.0.0.1:18789/
 * 
 * Environment:
 *   WS_DEBUG=1                    Enable debug logging
 *   WS_HEARTBEAT_INTERVAL_MS=20000  Ping interval
 *   WS_HEARTBEAT_TIMEOUT_MS=60000   Pong timeout
 */

// Use ws module from workspace
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const DEFAULT_URL = 'ws://127.0.0.1:18789/';
const DEFAULT_DURATION_MINUTES = 2;

const durationMinutes = parseInt(process.argv[2]) || DEFAULT_DURATION_MINUTES;
const targetUrl = process.argv[3] || DEFAULT_URL;
const durationMs = durationMinutes * 60 * 1000;

const LOG_FILE = path.join(__dirname, '..', 'logs', 'websocket-stability-test.log');

// Ensure logs directory exists
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

let connectionLog = [];
let currentWs = null;
let reconnectAttempts = 0;
let isTestRunning = true;
let stats = {
  connects: 0,
  disconnects: 0,
  errors: 0,
  pingsSent: 0,
  pongsReceived: 0,
  messagesReceived: 0
};

function log(level, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}`;
  console.log(line);
  connectionLog.push(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function analyzeCloseCode(code, reason) {
  const codes = {
    1000: { name: 'Normal Closure', initiator: 'client', benign: true },
    1001: { name: 'Going Away', initiator: 'server', benign: false },
    1006: { name: 'Abnormal Closure', initiator: 'error', benign: false },
    1011: { name: 'Server Error', initiator: 'server', benign: false }
  };
  return codes[code] || { name: `Unknown (${code})`, initiator: 'unknown', benign: false };
}

class StabilityTestSocket {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.connectTime = null;
    this.heartbeatInterval = null;
    this.pongTimeout = null;
    this.lastPong = null;
    
    this.connect();
  }
  
  connect() {
    if (!isTestRunning) return;
    
    log('INFO', `Connecting to ${this.url}...`);
    
    try {
      this.ws = new WebSocket(this.url);
      this.connectTime = Date.now();
      
      this.ws.on('open', () => {
        stats.connects++;
        reconnectAttempts = 0;
        this.lastPong = Date.now();
        
        log('SUCCESS', `Connected! (#${stats.connects})`);
        
        // Start heartbeat
        this.startHeartbeat();
      });
      
      this.ws.on('message', (data) => {
        stats.messagesReceived++;
        
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'pong') {
            stats.pongsReceived++;
            this.lastPong = Date.now();
            log('DEBUG', `Pong received (rtt: ${this.lastPong - msg.timestamp}ms)`);
          }
        } catch (e) {
          // Non-JSON message
          log('DEBUG', `Message received: ${data.toString().slice(0, 100)}`);
        }
      });
      
      this.ws.on('close', (code, reason) => {
        stats.disconnects++;
        this.stopHeartbeat();
        
        const analysis = analyzeCloseCode(code, reason);
        const duration = this.connectTime ? (Date.now() - this.connectTime) / 1000 : 0;
        
        log('WARN', `Disconnected: code=${code} (${analysis.name}), reason="${reason}", ` +
                   `duration=${duration.toFixed(1)}s, initiator=${analysis.initiator}`);
        
        if (!analysis.benign && isTestRunning) {
          this.reconnect();
        }
      });
      
      this.ws.on('error', (err) => {
        stats.errors++;
        log('ERROR', `WebSocket error: ${err.message}`);
      });
      
    } catch (err) {
      log('ERROR', `Failed to create WebSocket: ${err.message}`);
      this.reconnect();
    }
  }
  
  startHeartbeat() {
    const interval = parseInt(process.env.WS_HEARTBEAT_INTERVAL_MS) || 20000;
    const timeout = parseInt(process.env.WS_HEARTBEAT_TIMEOUT_MS) || 60000;
    
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const ping = { type: 'ping', timestamp: Date.now() };
        this.ws.send(JSON.stringify(ping));
        stats.pingsSent++;
        log('DEBUG', 'Ping sent');
        
        // Check for pong timeout
        const timeSinceLastPong = Date.now() - this.lastPong;
        if (timeSinceLastPong > timeout) {
          log('ERROR', `Pong timeout! No response in ${timeSinceLastPong}ms`);
          this.ws.close(1001, 'Heartbeat timeout');
        }
      }
    }, interval);
    
    log('INFO', `Heartbeat started (interval: ${interval}ms, timeout: ${timeout}ms)`);
  }
  
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
  
  reconnect() {
    if (!isTestRunning) return;
    
    reconnectAttempts++;
    const delay = Math.min(
      1000 * Math.pow(1.5, reconnectAttempts - 1) + Math.random() * 500,
      5000
    );
    
    log('INFO', `Reconnecting in ${delay.toFixed(0)}ms (attempt #${reconnectAttempts})...`);
    
    setTimeout(() => this.connect(), delay);
  }
  
  close() {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000, 'Test ending');
    }
  }
}

// Print test header
console.log('═══════════════════════════════════════════════════════════');
console.log('     WEBSOCKET STABILITY TEST');
console.log('═══════════════════════════════════════════════════════════');
console.log(`Target URL:   ${targetUrl}`);
console.log(`Duration:     ${durationMinutes} minute(s)`);
console.log(`Log file:     ${LOG_FILE}`);
console.log(`Started at:   ${new Date().toISOString()}`);
console.log('═══════════════════════════════════════════════════════════\n');

// Clear old log
fs.writeFileSync(LOG_FILE, '');
log('INFO', 'Test starting...');

// Start connection
const testSocket = new StabilityTestSocket(targetUrl);

// Handle test end
setTimeout(() => {
  isTestRunning = false;
  testSocket.close();
  
  setTimeout(() => {
    // Print summary
    const uptime = connectionLog.filter(l => l.includes('Connected!')).length > 0 
      ? 'Multiple connections (see log)'
      : 'No successful connects';
    
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('     TEST SUMMARY');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Duration:        ${durationMinutes} minute(s)`);
    console.log(`Connects:        ${stats.connects}`);
    console.log(`Disconnects:     ${stats.disconnects}`);
    console.log(`Errors:          ${stats.errors}`);
    console.log(`Pings sent:      ${stats.pingsSent}`);
    console.log(`Pongs received:  ${stats.pongsReceived}`);
    console.log(`Messages:        ${stats.messagesReceived}`);
    console.log(`Log file:        ${LOG_FILE}`);
    console.log('═══════════════════════════════════════════════════════════');
    
    if (stats.disconnects === 0 && stats.connects > 0) {
      console.log('✅ STABLE: No disconnects during test period');
      process.exit(0);
    } else if (stats.disconnects <= 1) {
      console.log('⚠️  MOSTLY STABLE: 1 disconnect (may be initial connection setup)');
      process.exit(0);
    } else {
      console.log(`❌ UNSTABLE: ${stats.disconnects} disconnects detected`);
      process.exit(1);
    }
  }, 1000);
}, durationMs);

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log('\nInterrupted by user');
  isTestRunning = false;
  testSocket.close();
  process.exit(130);
});