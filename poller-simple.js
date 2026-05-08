/**
 * CoflNet API Poller Service - Alternative Version
 * Uses native Node.js HTTPS module (no certificate issues)
 * 
 * Run with: node poller-simple.js
 */

const https = require('https');
const http = require('http');
const querystring = require('querystring');
require('dotenv').config();

// Configuration
const CONFIG = {
    COFLNET_API: 'https://api.coflnet.com/api/auctions/price/',
    ITEMS: {
        'Cashmere Jacket': '#9045cd',
        'Satin Trousers': '#5ebf6b',
        'Velvet Top Hat': '#d4a574',
        'Oxford Shoes': '#8b7355'
    },
    BACKEND_URL: process.env.BACKEND_URL || 'http://localhost:3000/api',
    POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL) || 5000,
    TIMEOUT: 10000
};

// State tracking
let pollCount = 0;
let successCount = 0;
let errorCount = 0;
let cachedPrices = {};

console.log(`
╔════════════════════════════════════════════════════════════╗
║    CoflNet Purchase Monitor - API Poller (Simple)          ║
╚════════════════════════════════════════════════════════════╝

⚙️  Configuration:
   Backend URL: ${CONFIG.BACKEND_URL}
   Poll Interval: ${CONFIG.POLL_INTERVAL}ms
   Items to track: ${Object.keys(CONFIG.ITEMS).length}

Items being monitored:
`);

Object.entries(CONFIG.ITEMS).forEach(([item, hex]) => {
    console.log(`   • ${item} (${hex})`);
});

console.log(`\nStarting poller... Press Ctrl+C to stop\n`);

// Simple HTTPS GET request
function httpsGet(url, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error('Request timeout'));
        }, timeout);

        https.get(url, { rejectUnauthorized: false }, (res) => {
            clearTimeout(timeoutId);
            let data = '';

            res.on('data', chunk => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json);
                } catch (e) {
                    reject(new Error('Invalid JSON response'));
                }
            });
        }).on('error', (err) => {
            clearTimeout(timeoutId);
            reject(err);
        });
    });
}

// Simple HTTP POST request
function httpPost(url, data, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const isHttps = url.startsWith('https');
        const module = isHttps ? https : http;
        const urlObj = new URL(url);
        
        const postData = JSON.stringify(data);

        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            rejectUnauthorized: false,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const timeoutId = setTimeout(() => {
            reject(new Error('Request timeout'));
        }, timeout);

        const req = module.request(options, (res) => {
            let responseData = '';

            res.on('data', chunk => {
                responseData += chunk;
            });

            res.on('end', () => {
                clearTimeout(timeoutId);
                try {
                    const json = JSON.parse(responseData);
                    resolve(json);
                } catch (e) {
                    resolve({ success: true, statusCode: res.statusCode });
                }
            });
        });

        req.on('error', (err) => {
            clearTimeout(timeoutId);
            reject(err);
        });

        req.write(postData);
        req.end();
    });
}

// Main polling function
async function pollCoflNet() {
    pollCount++;
    const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);
    
    console.log(`[${timestamp}] Poll #${pollCount} starting...`);
    
    for (const [itemName, hexCode] of Object.entries(CONFIG.ITEMS)) {
        try {
            const url = `${CONFIG.COFLNET_API}${encodeURIComponent(itemName)}`;
            const response = await httpsGet(url, CONFIG.TIMEOUT);

            if (response && response.sell && response.sell.pricePerUnit) {
                const price = response.sell.pricePerUnit;
                
                // Check if price changed
                const cacheKey = itemName;
                if (cachedPrices[cacheKey] !== price) {
                    cachedPrices[cacheKey] = price;
                    
                    // Save to backend
                    try {
                        await savePurchase(itemName, hexCode, price);
                        console.log(`   ✓ ${itemName}: ${price.toLocaleString()} coins`);
                        successCount++;
                    } catch (saveErr) {
                        console.log(`   ⚠ ${itemName}: Saved locally but failed to POST to backend`);
                    }
                } else {
                    console.log(`   ~ ${itemName}: ${price.toLocaleString()} (no change)`);
                }
            } else {
                console.log(`   ⚠ ${itemName}: No price data in response`);
            }

        } catch (error) {
            errorCount++;
            console.log(`   ✗ ${itemName}: ${error.message}`);
        }
    }
    
    console.log(`   Stats: ${successCount} successful, ${errorCount} errors\n`);
}

// Save purchase to backend
async function savePurchase(itemName, hexCode, price) {
    const payload = {
        itemName: itemName,
        hexCode: hexCode,
        price: price,
        source: 'coflnet-poller',
        timestamp: new Date().toISOString()
    };

    await httpPost(`${CONFIG.BACKEND_URL}/purchases`, payload, CONFIG.TIMEOUT);
}

// Error handling
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                     Poller Stopped                         ║
╚════════════════════════════════════════════════════════════╝

📊 Final Statistics:
   Total Polls: ${pollCount}
   Successful Saves: ${successCount}
   Errors: ${errorCount}
`);
    process.exit(0);
});

// Start polling
pollCoflNet();
setInterval(pollCoflNet, CONFIG.POLL_INTERVAL);
