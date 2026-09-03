# Deploying artificialneko to Ubuntu 24.04

Site: **https://artificialneko.com** · API: **https://api.artificialneko.com**

Two PM2 processes over one MongoDB, from `/var/www/artificialneko`:

| Process | Port | Reachable from |
| --- | --- | --- |
| `artificialneko-api` (`server.js`) | 3000 | the internet, via nginx → `api.artificialneko.com` |
| `artificialneko-bot` (`bot.js`) | 3100 | **localhost only** — never proxied |

The bot holds the wallet key and `POST /run` pays real money out, so its port
stays off the internet. Do not collapse the two back into one process.

Everything below runs as **root**. One account, one pm2 daemon, no `sudo -u`
juggling — pm2 keeps a separate daemon per user, and mixing accounts is what
leaves `pm2 list` empty while the bot is actually running. Keep `.env` at mode
600 and the wallet key stays as protected as the server itself.

**Almost nothing needs deploying on-chain.** `V4Buyer` is shared and reusable —
it takes its pool as an argument, never touches holders, and its output goes
from the PoolManager straight to the wallet, so it appears in no token's
transfer graph. The **disperser is per-project**: it is the recorded sender of
every payout, so sharing one links the projects on any bubblemap. Deploy one at
go-live with `node scripts/deploy-disperser-v2.js --confirm`.

**Before you start:** point a DNS `A` record for `api.artificialneko.com` at the
server's public IP and let it propagate (`dig +short api.artificialneko.com`). Certbot
cannot issue a certificate until it resolves.

## 1. Base prep

```bash
apt update && apt upgrade -y
apt install -y curl git ufw ca-certificates gnupg
timedatectl set-timezone UTC
```

## 2. Firewall

Only SSH and web. Neither app port is exposed.

Allow the ports by NUMBER, not by the `'Nginx Full'` profile: that profile does
not exist until nginx is installed in step 8, so the rule fails silently here
and leaves ufw enabled with SSH as the only way in. Certbot then cannot be
reached for its challenge and fails with `Timeout during connect (likely
firewall problem)` — having correctly resolved the domain.

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status
```

On a cloud provider with its own firewall (DigitalOcean, AWS, Hetzner), open
80 and 443 there too. It sits in front of ufw, so traffic is dropped before the
server ever sees it and every check on the box still looks correct.

## 3. Node.js 22 LTS + npm

`package.json` requires Node >= 20 and the code uses the global `fetch`.
Ubuntu's own repo ships an older Node, so use NodeSource. npm comes with it.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
npm install -g pm2
node -v && npm -v && pm2 -v
```

## 4. MongoDB — pick ONE

The bot writes its payout ledger here and the API reads it. Either a hosted URI
or a local server; you do not need both.

### Option A: a hosted URI (Atlas or similar) — nothing to install

Skip straight to the next step and put the connection string in `.env` later:

```ini
MONGODB_URI=mongodb+srv://user:pass@cluster.xxxxx.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=artificialneko
```

**Allowlist the server's IP in the provider's network settings.** This is the
single most common reason a fresh deployment appears to hang: the driver waits
out its server-selection timeout on every connect, and PM2 restarts the process
into the same wait. Get the IP with `curl -s ifconfig.me`.

### Option B: a local mongod

```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
  | gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
  | tee /etc/apt/sources.list.d/mongodb-org-8.0.list
apt update && apt install -y mongodb-org
systemctl enable --now mongod
systemctl status mongod --no-pager
```

Then `MONGODB_URI=mongodb://127.0.0.1:27017`. It listens on localhost only,
which is what you want.

## 5. Clone into /var/www

```bash
mkdir -p /var/www/artificialneko
cd /var/www/artificialneko
git clone https://github.com/blockfile/artificialneko.git .
npm ci --omit=dev
```

Let the clone finish. Interrupting it leaves no `package-lock.json`, and the
next command fails with `npm ci can only install with an existing
package-lock.json` — which looks like a broken repo and is not.

## 6. Configure

```bash
cd /var/www/artificialneko
cp .env.example .env
nano .env
chmod 600 .env
```

Values for this deployment:

```ini
PORT=3000
BOT_PORT=3100

TOKEN_ADDRESS=                 # blank until NEKO launches
WALLET_PRIVATE_KEY=            # the creator wallet — set at go-live, not now
DRY_RUN=true

# The QUOTE asset: what pons pays creator fees in.
QUOTE_TOKEN_ADDRESS=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
QUOTE_SYMBOL=NVDA

# The REWARD asset: what holders are paid. The SAME token the fees arrive in,
# so the cycle's buy step is a no-op — there is nothing to swap. Point this at a
# different token and the buy leg switches on by itself.
REWARD_TOKEN_ADDRESS=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
REWARD_SYMBOL=NVDA

# The swap router is shared and safe to share: it never touches holders, and
# its output goes straight from the PoolManager to the wallet, so it does not
# appear in any token's transfer graph.
V4_BUYER_ADDRESS=0x5FCe84D38DD7707AC58bf8277859b384aa2158E8

# The DISPERSER is per-project. It is the sender of every payout, so it is the
# address bubblemap tools draw the fanout from - sharing one across projects
# links them. Deploy your own at go-live:
#     node scripts/deploy-disperser-v2.js --confirm
DISPERSE_ADDRESS=

REWARD_PCT=90
BURN_PCT=0        # buyback+burn is BUILT but deliberately not funded
GAS_PCT=10
MIN_HOLD=100000

TRIGGER_MODE=accumulation
CLAIM_EVERY_USD=100
# How often the chain is read and the site's fee gauge written. Never pays.
POLL_SCHEDULE=* * * * *
# When a distribution may actually happen. Any cron string: */30 for every half
# hour, */20 for every twenty minutes. A payout needs BOTH this schedule coming
# round AND the fees clearing CLAIM_EVERY_USD.
TRIGGER_SCHEDULE=0 * * * *

MONGODB_URI=                   # from step 4
MONGODB_DB=artificialneko
API_KEY=                       # any long random string; guards the bot's /run
CORS_ORIGINS=https://artificialneko.com,https://www.artificialneko.com
```

Generate the API key rather than inventing one:

```bash
sed -i "s|^API_KEY=.*|API_KEY=$(openssl rand -hex 32)|" .env
```

**Do not put an address in `QUOTE_TOKEN_ADDRESS` from anywhere but this file.**
At least five impostor NVDA tokens exist on this chain, several sharing the real
one's name and symbol. The bot verifies the bytecode at startup and refuses to
run against a fake, but it is easier not to paste one.

## 7. PM2 — one command for both

The repo ships `ecosystem.config.js`, so both processes start together.

```bash
cd /var/www/artificialneko
pm2 start ecosystem.config.js
pm2 save
pm2 status
```

Two more are worth running **once**, then never again:

```bash
pm2 startup systemd         # prints ONE line — run it, then `pm2 save`
pm2 install pm2-logrotate   # keeps logs from filling the disk
```

Check both are alive — note `--nostream`, or the command tails forever:

```bash
pm2 status
pm2 logs --nostream --lines 30
curl http://127.0.0.1:3000/health
```

## 8. nginx

```bash
apt install -y nginx
```

This proxies **only** port 3000. The bot's 3100 is deliberately absent.

```bash
tee /etc/nginx/sites-available/api.artificialneko.com > /dev/null <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name api.artificialneko.com;

    access_log /var/log/nginx/artificialneko.access.log;
    error_log  /var/log/nginx/artificialneko.error.log;

    client_max_body_size 1m;

    # The PUBLIC API only. Never add a location for the bot's port (3100):
    # POST /run there pays real money out and is meant to be SSH-only.
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
NGINX

ln -s /etc/nginx/sites-available/api.artificialneko.com /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
curl http://api.artificialneko.com/health
```

## 9. Certbot / HTTPS

The site is HTTPS, so the API must be — a browser on `https://artificialneko.com`
refuses to fetch `http://api.artificialneko.com` as mixed content.

```bash
snap install core && snap refresh core
snap install --classic certbot
ln -sf /snap/bin/certbot /usr/bin/certbot

certbot --nginx -d api.artificialneko.com --redirect \
  -m you@example.com --agree-tos --no-eff-email

certbot renew --dry-run
systemctl list-timers | grep certbot
```

## 10. Verify

```bash
curl https://api.artificialneko.com/health
curl https://api.artificialneko.com/token
curl https://api.artificialneko.com/stats
curl "https://api.artificialneko.com/rewards?limit=5"

# CORS — must echo the site's origin back
curl -s -H "Origin: https://artificialneko.com" -D- -o /dev/null \
  https://api.artificialneko.com/stats | grep -i access-control-allow-origin

# The bot must NOT be reachable from outside
curl -m 5 http://api.artificialneko.com:3100/status   # must fail or time out
```

A 403 on the CORS check means the origin is missing from `CORS_ORIGINS` — the
usual reason the site shows placeholder data against a working API.

`/rewards` must return a **`data`** array and a **`meter`** object. The site's
normaliser reads `json.data ?? json.rewards ?? json` and throws on anything that
is not an array, so a missing `data` renders as "Unexpected rewards payload
shape" against a perfectly healthy API.

Then point the site at it (`VITE_API_BASE_URL=https://api.artificialneko.com`,
`VITE_USE_MOCK=false`) and redeploy the frontend.

## 11. Dry run

Everything above runs with `DRY_RUN=true`, which simulates every on-chain call
against an in-memory fee vault. No key, no RPC and no funds are involved.

**A cycle still needs a `TOKEN_ADDRESS`, though.** With it blank the cycle
refuses immediately:

```json
{"status":"failed","error":"TOKEN_ADDRESS (NEKO) is required"}
```

That is correct — it will not pretend to work on a token that does not exist.
To rehearse the flow before launch, point it at any address: DRY_RUN simulates
the launch record too, so it need not be a real token.

```bash
cd /var/www/artificialneko
export API_KEY=$(grep -E '^API_KEY=' .env | cut -d= -f2-)

# a placeholder, purely to exercise the cycle
sed -i 's/^TOKEN_ADDRESS=.*/TOKEN_ADDRESS=0x0000000000000000000000000000000000000001/' .env
pm2 restart artificialneko-bot --update-env

# WAIT for the port. `pm2 restart` returns as soon as it signals the process,
# but the bot connects to MongoDB BEFORE it listens on 3100 — on a hosted URI
# that is a remote round trip, so a curl on the next line gets "connection
# refused" from a bot that is starting perfectly normally.
until curl -sf -H "x-api-key: $API_KEY" http://127.0.0.1:3100/status >/dev/null; do sleep 1; done

curl -H "x-api-key: $API_KEY" -X POST http://127.0.0.1:3100/run
```

A rehearsed cycle claims NVDA, sells a slice for gas, airdrops NVDA to holders,
then buys NEKO with the burn share and destroys it. The `reward-swap` step is
recorded but does nothing while the reward token IS the quote token: there is
nothing to swap, so it reports the claim straight through with no signature.
A `reward-swap` with a transaction hash means `REWARD_TOKEN_ADDRESS` points at
something other than NVDA and the buy leg has switched itself on.

`POST /run` ignores both the trigger schedule and `CLAIM_EVERY_USD` — it runs a
full cycle against whatever is in the escrow, however little that is. That is
what makes it useful for a rehearsal, and what makes it a live payout button
once `DRY_RUN=false`.

Put the blank back when you are done:

```bash
sed -i 's/^TOKEN_ADDRESS=.*/TOKEN_ADDRESS=/' .env
pm2 restart artificialneko-bot --update-env
```

## 12. Going live (after launch)

```bash
cd /var/www/artificialneko
nano .env      # set TOKEN_ADDRESS and WALLET_PRIVATE_KEY
npm run check  # the feeRecip. line MUST show ✓
```

Fund the wallet with **ETH for gas** — the bot's income is NVDA and cannot pay
for its own first transaction. Then:

```bash
pm2 restart artificialneko-bot --update-env   # still DRY_RUN=true
curl -H "x-api-key: $API_KEY" -X POST http://127.0.0.1:3100/run
# read the cycle, then:
nano .env      # DRY_RUN=false
pm2 restart artificialneko-bot --update-env
pm2 logs artificialneko-bot
```

Stop the schedule at any time without touching the public API:

```bash
curl -H "x-api-key: $API_KEY" -X POST http://127.0.0.1:3100/pause
```

## Redeploying

```bash
cd /var/www/artificialneko
git pull
npm ci --omit=dev
pm2 restart artificialneko-api artificialneko-bot --update-env
```

## Operational watch-list

- **Wallet ETH.** Gas is not self-funding at the start — income is NVDA, and it
  reaches ETH only via Uniswap v3 to WETH and an unwrap. Watch
  `wallet.ethBalance` against `gasReserveEth` in `GET /status`; below the
  reserve, cycles refuse to start rather than claiming and failing to pay out.
- **`feeRecipientOk`.** If this flips to `false`, the launch is paying someone
  else. The usual cause is pons's "route creator fees to holders" toggle being
  switched on, which reassigns the recipient to a distributor contract —
  permanently, and it takes every creator fee with it.
- **The `reward-swap` line.** It is the leg with no production history. A cycle
  that claims and then buys nothing pays nobody, so it is the first thing to
  read in a quiet cycle.
- **`MIN_HOLD`.** 100,000 NEKO, matching what the site advertises. Lowering it
  toward 1 pays dust to nearly every wallet and multiplies per-cycle gas.
- **A quiet twenty minutes is not a symptom.** Distributions land on
  `TRIGGER_SCHEDULE` (default hourly, on the hour), not whenever the tank fills.
  A gauge sitting at 100% between trigger ticks is the design, not a stall — the
  scheduler logs `waiting for the next trigger window` when that is what is
  happening. `GET /status` reports both schedules under `trigger`.

## Troubleshooting

**Everything hangs / PM2 keeps restarting.** Almost always the database. The
driver waits out its server-selection timeout, the process exits, PM2 restarts
it, and it waits again. Check with:

```bash
pm2 logs --nostream --lines 40
pm2 status                   # a climbing ↺ restart count is the tell
```

On a hosted URI, the usual cause is the server's IP not being allowlisted in the
provider's network settings — see step 4. On a local mongod,
`systemctl status mongod`.

**`refusing to start: … does not have the bytecode`.** `QUOTE_TOKEN_ADDRESS`
points at an impostor NVDA. The genuine one is
`0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC`; the fakes are identifiable by a
total supply of exactly 1e9.

**`pm2 list` is empty but the bot is running.** Two pm2 daemons — something was
started under a different account. Everything here runs as root; check with
`whoami` before any pm2 command.

**`npm ci` says it needs an existing package-lock.json.** The clone did not
finish. Re-run it and let it complete.

**`pm2 logs` never returns.** That is not a hang; it tails. Ctrl+C, and use
`pm2 logs --nostream --lines 50` for a one-shot read.

**`npm run check` prints PRE-LAUNCH and stops.** Correct with `TOKEN_ADDRESS`
blank — there is nothing on chain to inspect yet.

**`/stats` shows zeros through a DRY_RUN cycle.** Also correct. Simulated
payouts carry a fabricated signature and are deliberately excluded from the
public numbers, so visitors are never shown invented rewards.

**The site shows placeholder data against a working API.** Almost always CORS:
`CORS_ORIGINS` must contain the exact origin including the scheme. Confirm with
the `Origin:` curl in step 10 — a 403 there is the answer.

**The site shows "Unexpected rewards payload shape".** `/rewards` is not
returning a `data` array. Check step 10.

**Certbot: `Timeout during connect (likely firewall problem)`.** Port 80 is not
reachable from the internet. The domain resolving correctly — certbot names the
right IP — rules out DNS. Check in this order:

```bash
ufw status verbose                    # 80/tcp and 443/tcp must be ALLOW
ss -tlnp | grep -E ':80|:443'         # nginx must be listening
systemctl status nginx --no-pager
```

If ufw and nginx both look right, the block is the cloud provider's own
firewall, which sits in front of ufw. Open 80 and 443 in its panel.
