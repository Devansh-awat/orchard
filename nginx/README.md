# Nginx Proxy for Orchard

This nginx proxy forwards requests to the frontend and backend services.

## Setup

### 1. Add orchard.local to your hosts file

Add the following line to your `/etc/hosts` file:

```
127.0.0.1 orchard.local
```

On macOS/Linux, you can do this with:

```bash
sudo sh -c 'echo "127.0.0.1 orchard.local" >> /etc/hosts'
```

### 2. Restart your development servers

**IMPORTANT:** You need to restart your dev servers for them to listen on `0.0.0.0` (accessible from Docker).

Stop any running dev servers (Ctrl+C), then start them again:

```bash
# In the project root
pnpm dev
```

Or start them individually:

```bash
# Terminal 1 - Frontend (port 3000)
pnpm dev:lif

# Terminal 2 - Backend (port 3001)
pnpm dev:server
```

The servers are now configured to listen on `0.0.0.0:3000` and `0.0.0.0:3001` (accessible from Docker).

### 3. Start the nginx proxy

```bash
# In the project root
docker-compose up -d
```

To rebuild and start (if you've made changes):

```bash
docker-compose up -d --build
```

### 4. Access the application

- Frontend: http://orchard.local
- Backend API: http://orchard.local/api

### Stop the proxy

```bash
docker-compose down
```

### View logs

```bash
docker-compose logs -f nginx
```

## Troubleshooting

If you get a 502 Bad Gateway error:

1. Make sure your dev servers are running (`pnpm dev`)
2. Verify they're listening on `0.0.0.0`:
   ```bash
   lsof -iTCP:3000 -sTCP:LISTEN -n -P
   lsof -iTCP:3001 -sTCP:LISTEN -n -P
   ```
   You should see `*:3000` and `*:3001` (not `[::1]:3000`)

3. Test connectivity from the nginx container:
   ```bash
   docker-compose exec nginx wget -O- http://host.docker.internal:3000
   ```

## Configuration

The nginx configuration is in [nginx.conf](./nginx.conf). It proxies:
- `/` → Frontend (host.docker.internal:3000)
- `/api` → Backend (host.docker.internal:3001)
