# WebSocket Proxy Configuration Guide

## Problem: WS Code=1001 Disconnects

If you're seeing WebSocket disconnects with code 1001, this usually indicates:
- Idle timeout by proxy/server
- Missing ping/pong heartbeat
- Connection reset by peer

## Required Headers for Proxies

When running OpenClaw behind a reverse proxy (nginx, Apache, etc.), ensure these headers are set:

### Nginx Configuration

```nginx
# Upstream definition
upstream openclaw {
    server 127.0.0.1:18789;
    
    # Enable keepalive
    keepalive 32;
}

server {
    listen 80;
    server_name openclaw.local;
    
    # WebSocket upgrade headers
    location / {
        proxy_pass http://openclaw;
        proxy_http_version 1.1;
        
        # Required WebSocket headers
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Timeouts (must be longer than heartbeat interval)
        proxy_read_timeout 86400s;     # 24 hours
        proxy_send_timeout 86400s;
        proxy_connect_timeout 60s;
        
        # Buffer settings
        proxy_buffering off;
    }
}
```

### Apache Configuration

```apache
<VirtualHost *:80>
    ServerName openclaw.local
    
    # WebSocket proxy
    ProxyPass / ws://127.0.0.1:18789/
    ProxyPassReverse / ws://127.0.0.1:18789/
    
    # Enable WebSocket support
    RewriteEngine on
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteRule ^/?(.*) "ws://127.0.0.1:18789/$1" [P,L]
    
    # Timeouts
    ProxyTimeout 86400
    
    # Headers
    RequestHeader set Upgrade websocket
    RequestHeader set Connection upgrade
</VirtualHost>
```

### Caddy Configuration

```caddyfile
openclaw.local {
    reverse_proxy 127.0.0.1:18789 {
        # Enable WebSocket support (automatic in Caddy 2)
        
        # Timeouts
        transport http {
            read_timeout 24h
            write_timeout 24h
        }
    }
}
```

## Client-Side Reconnection Logic

Implement exponential backoff in your client:

```javascript
class ReconnectingWebSocket {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 5000; // Max 5s
    this.shouldReconnect = true;
    
    this.connect();
  }
  
  connect() {
    this.ws = new WebSocket(this.url);
    
    this.ws.onopen = () => {
      console.log('Connected');
      this.reconnectAttempts = 0;
    };
    
    this.ws.onclose = (event) => {
      console.log(`Closed: code=${event.code}, wasClean=${event.wasClean}`);
      
      // Don't reconnect on clean close (1000) or going away (1001)
      if (!this.shouldReconnect || event.code === 1000) {
        return;
      }
      
      // Exponential backoff with jitter
      const delay = Math.min(
        1000 * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000,
        this.maxReconnectDelay
      );
      
      console.log(`Reconnecting in ${delay}ms...`);
      setTimeout(() => this.connect(), delay);
      this.reconnectAttempts++;
    };
    
    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }
  
  close() {
    this.shouldReconnect = false;
    this.ws.close(1000, 'Client closing');
  }
}
```

## Environment Variables

```bash
# WebSocket Heartbeat (client-side patch)
WS_HEARTBEAT_INTERVAL_MS=20000  # Ping every 20s
WS_HEARTBEAT_TIMEOUT_MS=60000   # Wait 60s for pong
WS_DEBUG=1                      # Enable debug logging

# Server-side (if supported)
WS_PING_INTERVAL=20000          # Server ping interval
WS_IDLE_TIMEOUT=300000          # Connection timeout
```

## WebSocket Close Codes

| Code | Name | Meaning |
|------|------|---------|
| 1000 | Normal Closure | Clean, intentional close |
| 1001 | Going Away | Server/client going down or idle timeout |
| 1006 | Abnormal Closure | Connection dropped unexpectedly |
| 1011 | Server Error | Server encountered error |

## Diagnostic Commands

```bash
# Check if WebSocket endpoint responds
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
  http://127.0.0.1:18789/

# Monitor WebSocket with wscat
npm install -g wscat
wscat -c ws://127.0.0.1:18789/
```

## Production Mode

To run OpenClaw Gateway in production mode:

```bash
# Disable hot reload, enable optimizations
NODE_ENV=production openclaw gateway start

# Or set in shell
export NODE_ENV=production
openclaw gateway start
```

In production mode:
- Hot module reload is disabled
- More aggressive connection keepalive
- Reduced logging overhead