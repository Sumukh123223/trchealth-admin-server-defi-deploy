🖥️ BACKEND SERVER - Your Server Code

This folder contains your backend server that runs on Railway/server.

KEY FILES:
==========

📄 server.js
   - Main server file
   - Multi-tenant system
   - All API endpoints
   - DO NOT EDIT unless you know what you're doing

📄 tenants.json
   - Tenant configurations
   - Add/remove domains here
   - Each domain's wallet & Telegram bot
   - ⭐ THIS IS WHERE YOU MANAGE CUSTOMERS

📄 package.json
   - Dependencies
   - Node.js packages

📄 .gitignore
   - Git ignore rules
   - Keeps sensitive files out of Git

📄 railway.json
   - Railway deployment config
   - (if using Railway)

📄 env.example
   - Environment variables example
   - Copy to .env and fill in values

HOW TO USE:
===========

1. Deploy to Railway/server
2. Set environment variables (ADMIN_KEY, etc.)
3. Edit tenants.json to add customers
4. Server automatically loads configs

MANAGING CUSTOMERS:
==================

Edit tenants.json:
{
  "customer-domain.com": {
    "tronPrivateKey": "...",
    "tronAddress": "...",
    "telegramBotToken": "...",
    "telegramChatId": "...",
    "autoSendAmount": 13,
    "minimumBalance": 11,
    "enabled": true
  }
}

That's it! Server auto-reloads configs.

