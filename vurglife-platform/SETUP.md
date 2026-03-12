# VurgLife Platform — Setup Guide

## Local Development

### 1. Install dependencies
```bash
cd G:\SipSam\PokerProject\vurglife-platform
npm install
```

### 2. Create your .env file
```bash
copy .env.example .env
```
Edit `.env` — at minimum change `JWT_SECRET` to any long random string.

### 3. Start the platform server
```bash
npm start
# or for auto-restart on changes:
npm run dev
```

### 4. Start the SipSam game server (separate terminal)
```bash
cd G:\SipSam\PokerProject\poker-server
node index.js
```

### 5. Open your browser
- Platform: http://localhost:3000
- SipSam direct: http://localhost:3000/sipsam

---

## File Structure
```
vurglife-platform/
├── server/
│   ├── index.js          ← Platform server (port 3000)
│   ├── db/
│   │   └── database.js   ← SQLite schema + all queries
│   ├── routes/
│   │   ├── auth.js        ← Register/Login/Reset
│   │   └── game.js        ← Tables/Ads/Rewards/Store
│   ├── middleware/
│   │   └── auth.js        ← JWT verification
│   └── utils/
│       └── email.js       ← Resend.com email sender
├── client/public/
│   ├── index.html         ← Landing + Login + Dashboard
│   └── images/
│       └── vurglife-logo.png
├── data/
│   └── vurglife.db        ← SQLite database (auto-created)
├── package.json
├── .env.example
└── SETUP.md
```

---

## Going Live on DigitalOcean

### Step 1 — Get a Droplet
1. Sign up at digitalocean.com
2. Create Droplet → Ubuntu 22.04 → Basic → $12/month (2GB RAM)
3. Add your SSH key during setup

### Step 2 — Domain
1. Buy `vurglife.com` at namecheap.com (~$12/year)
2. In Namecheap DNS settings, point A record to your Droplet IP
3. Add www CNAME → vurglife.com

### Step 3 — Server Setup (run on Droplet)
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 (keeps server running)
sudo npm install -g pm2

# Install Nginx
sudo apt install -y nginx

# Install Certbot (free SSL)
sudo apt install -y certbot python3-certbot-nginx
```

### Step 4 — Upload your code
```bash
# From your Windows machine (using Git)
git init
git add .
git commit -m "VurgLife v1"
git remote add origin https://github.com/YOUR_USERNAME/vurglife.git
git push -u origin main

# On Droplet
git clone https://github.com/YOUR_USERNAME/vurglife.git
cd vurglife/vurglife-platform
npm install
cp .env.example .env
nano .env   # Fill in production values
```

### Step 5 — Nginx config
```bash
sudo nano /etc/nginx/sites-available/vurglife
```
Paste:
```nginx
server {
    listen 80;
    server_name vurglife.com www.vurglife.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location /ws {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/vurglife /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### Step 6 — SSL
```bash
sudo certbot --nginx -d vurglife.com -d www.vurglife.com
```

### Step 7 — Start with PM2
```bash
pm2 start server/index.js --name vurglife-platform
pm2 start ../poker-server/index.js --name sipsam-game
pm2 save
pm2 startup
```

### Step 8 — Email
1. Sign up at resend.com (free)
2. Add vurglife.com as a domain, verify DNS
3. Copy API key to .env → RESEND_API_KEY

---

## Revenue Setup

### Google AdSense
1. Apply at adsense.google.com with vurglife.com
2. Requires ~3 months of traffic for approval
3. Once approved, replace ad placeholder divs in index.html with AdSense code

### Stripe (card payments)
1. Sign up at stripe.com
2. Get API keys → add to .env
3. I will build the payment flow once you're ready

### PayPal
1. Create developer account at developer.paypal.com
2. Get client ID and secret → add to .env

---

## Security Checklist Before Launch
- [ ] Change JWT_SECRET to a random 64-character string
- [ ] Set NODE_ENV=production in .env
- [ ] Enable HTTPS (Step 6 above)
- [ ] Set up database backups (DigitalOcean Managed DB or daily cron backup)
- [ ] Add rate limiting to auth endpoints
- [ ] Set up monitoring (DigitalOcean's built-in or UptimeRobot free tier)
