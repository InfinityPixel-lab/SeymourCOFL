/**
 * CoflNet Auction Poller
 *
 * Features:
 * - Polls recent auctions from CoflNet
 * - Fetches detailed auction data
 * - Gets REAL item hex colors from auction data
 * - Prevents duplicate auctions with UUID tracking
 * - Saves auctions to backend database
 * - Auto-cleanup of UUID cache to prevent memory bloat
 *
 * Run:
 * node poller.js
 */

const axios = require('axios');
const https = require('https');
require('dotenv').config();

const colorsData = require('./data/colors.json');
const TARGET_COLORS = colorsData.TARGET_COLORS || {};
const FADE_DYES = colorsData.FADE_DYES || {};

/**
 * HTTPS AGENT - Handle SSL certificates
 */
const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

function hexToRgb(hex) {
    if (!hex) return null;
    const cleaned = hex.replace(/^#/, '').trim();
    if (cleaned.length !== 6) return null;
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    if ([r, g, b].some(c => Number.isNaN(c))) return null;
    return { r, g, b };
}

function rgbToXyz({ r, g, b }) {
    const srgb = [r, g, b].map(value => {
        const scaled = value / 255;
        return scaled > 0.04045
            ? Math.pow((scaled + 0.055) / 1.055, 2.4)
            : scaled / 12.92;
    });

    const [rs, gs, bs] = srgb;
    return {
        x: rs * 0.4124564 + gs * 0.3575761 + bs * 0.1804375,
        y: rs * 0.2126729 + gs * 0.7151522 + bs * 0.0721750,
        z: rs * 0.0193339 + gs * 0.1191920 + bs * 0.9503041
    };
}

function xyzToLab({ x, y, z }) {
    const refX = 0.95047;
    const refY = 1.00000;
    const refZ = 1.08883;

    const fx = x / refX;
    const fy = y / refY;
    const fz = z / refZ;

    const pivot = (value) =>
        value > 0.008856
            ? Math.cbrt(value)
            : (7.787 * value) + 16 / 116;

    const fxp = pivot(fx);
    const fyp = pivot(fy);
    const fzp = pivot(fz);

    return {
        l: (116 * fyp) - 16,
        a: 500 * (fxp - fyp),
        b: 200 * (fyp - fzp)
    };
}

function rgbToLab(rgb) {
    if (!rgb) return null;
    return xyzToLab(rgbToXyz(rgb));
}

function deltaE76(labA, labB) {
    return Math.sqrt(
        Math.pow(labA.l - labB.l, 2) +
        Math.pow(labA.a - labB.a, 2) +
        Math.pow(labA.b - labB.b, 2)
    );
}

const TARGET_COLOR_LABS = Object.entries(TARGET_COLORS).map(([name, hex]) => {
    const rgb = hexToRgb(hex);
    return {
        name,
        hex,
        lab: rgb ? rgbToLab(rgb) : null,
        isFade: false
    };
}).filter(item => item.lab !== null);

const FADE_DYE_LABS = Object.entries(FADE_DYES).map(([name, hex]) => {
    const rgb = hexToRgb(hex);
    return {
        name,
        hex,
        lab: rgb ? rgbToLab(rgb) : null,
        isFade: true
    };
}).filter(item => item.lab !== null);

const ALL_COLOR_LABS = [...TARGET_COLOR_LABS, ...FADE_DYE_LABS];

function determineTier(hexCode) {
    if (!hexCode) return 'UNKNOWN';
    const rgb = hexToRgb(hexCode);
    if (!rgb) return 'UNKNOWN';
    const lab = rgbToLab(rgb);
    let minDistance = Infinity;
    let isFade = false;

    for (const target of ALL_COLOR_LABS) {
        const distance = deltaE76(lab, target.lab);
        if (distance < minDistance) {
            minDistance = distance;
            isFade = target.isFade;
        }
    }

    let tier;
    if (minDistance < 2) tier = 'T1';
    else if (minDistance < 5) tier = 'T2';
    else tier = 'T3';

    return isFade ? `Fade ${tier}` : tier;
}

function determineClosestColor(hexCode) {
    if (!hexCode) return 'Unknown';
    const rgb = hexToRgb(hexCode);
    if (!rgb) return 'Unknown';
    const lab = rgbToLab(rgb);
    let minDistance = Infinity;
    let closestColor = 'Unknown';

    for (const target of ALL_COLOR_LABS) {
        const distance = deltaE76(lab, target.lab);
        if (distance < minDistance) {
            minDistance = distance;
            closestColor = target.name;
        }
    }

    return closestColor;
}

/**
 * CONFIG
 */
const CONFIG = {

    API_BASE: 'https://sky.coflnet.com/api',

    ITEMS: {
        'Cashmere Jacket': 'CASHMERE_JACKET',
        'Satin Trousers': 'SATIN_TROUSERS',
        'Velvet Top Hat': 'VELVET_TOP_HAT',
        'Oxford Shoes': 'OXFORD_SHOES'
    },

    BACKEND_URL:
        process.env.BACKEND_URL ||
        'http://localhost:3000/api',

    POLL_INTERVAL:
        parseInt(process.env.POLL_INTERVAL) || 20000,

    MAX_AUCTION_PAGES:
        parseInt(process.env.MAX_AUCTION_PAGES) || 5,

    TIMEOUT: 10000
};

/**
 * AUCTION TRACKING
 * 
 * Tracks active auctions per item
 * Helps detect when auctions are sold/removed
 */
const activeAuctions = new Map(); // itemName -> Set of UUIDs

/**
 * DUPLICATE PREVENTION
 *
 * Stores auction UUIDs already processed
 * Prevents saving same auction multiple times
 */
const processedAuctions = new Set();

/**
 * STATS
 */
let pollCount = 0;
let successCount = 0;
let duplicateCount = 0;
let errorCount = 0;

console.log(`
╔══════════════════════════════════════════════════════════╗
║            CoflNet Auction Poller v2.0                  ║
║      Tracking Real Auction Data with Hex Colors         ║
╚══════════════════════════════════════════════════════════╝
`);

console.log('📦 Tracking Items:\n');

Object.entries(CONFIG.ITEMS).forEach(([name, id]) => {
    console.log(`   • ${name} -> ${id}`);
});

console.log(`\n⚙️  Configuration:`);
console.log(`   Backend: ${CONFIG.BACKEND_URL}`);
console.log(`   Poll Interval: ${CONFIG.POLL_INTERVAL}ms`);
console.log(`\n🚀 Starting poller...\n`);

/**
 * FETCH RECENT AUCTIONS
 * 
 * API: https://sky.coflnet.com/api/auctions/tag/{ITEM_ID}/recent/overview
 * Returns: Array of recent auction summaries for the item
 */
async function fetchRecentAuctions(itemId) {
    const auctions = [];
    const seen = new Set();

    for (let page = 1; page <= CONFIG.MAX_AUCTION_PAGES; page++) {
        const url = `${CONFIG.API_BASE}/auctions/tag/${itemId}/recent/overview?page=${page}`;

        try {
            const response = await axios.get(url, {
                timeout: CONFIG.TIMEOUT,
                httpsAgent: httpsAgent,
                headers: {
                    accept: 'application/json'
                }
            });

            const pageData = response.data;
            if (!Array.isArray(pageData) || pageData.length === 0) {
                break;
            }

            let added = 0;
            for (const auction of pageData) {
                if (!auction || !auction.uuid || seen.has(auction.uuid)) continue;
                seen.add(auction.uuid);
                auctions.push(auction);
                added++;
            }

            if (added === 0 || pageData.length < 12) {
                break;
            }
        } catch (err) {
            if (page === 1) {
                throw new Error(`Failed to fetch auctions for ${itemId}: ${err.message}`);
            }
            break;
        }
    }

    return auctions;
}

/**
 * FETCH AUCTION DETAILS
 * 
 * API: https://sky.coflnet.com/api/auction/{UUID}
 * Returns: Full auction details including item NBT data with color
 */
async function fetchAuctionDetails(uuid) {

    const url =
        `${CONFIG.API_BASE}/auction/${uuid}`;

    try {
        const response = await axios.get(url, {
            timeout: CONFIG.TIMEOUT,
            httpsAgent: httpsAgent,
            headers: {
                accept: 'application/json'
            }
        });

        return response.data;
    } catch (err) {
        throw new Error(`Failed to fetch auction ${uuid}: ${err.message}`);
    }
}

/**
 * EXTRACT HEX COLOR
 * 
 * The real item color comes from nbtData.data.color
 * Format is "R:G:B" (e.g., "93:221:86")
 * Convert to hex format (e.g., "#5ddd56")
 */
function extractHexColor(details) {

    if (!details) return null;

    // Get color in R:G:B format
    const colorRGB = 
        details?.nbtData?.data?.color ||
        details?.flatNbt?.color ||
        details?.tag?.color ||
        details?.color ||
        null;

    if (!colorRGB) return null;

    // Convert "R:G:B" to "#RRGGBB"
    try {
        const [r, g, b] = colorRGB.split(':').map(v => parseInt(v, 10));
        if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
        
        const hex = '#' + [r, g, b]
            .map(x => x.toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase();
        
        return hex;
    } catch (err) {
        return null;
    }
}

/**
 * FETCH USERNAME FROM MOJANG API
 *
 * Resolves a UUID to a username using Mojang's session server.
 */
async function fetchUsername(uuid) {
    if (!uuid) return null;
    try {
        const response = await axios.get(
            `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`,
            { timeout: 5000 }
        );
        return response.data?.name || null;
    } catch (err) {
        return null;
    }
}

/**
 * EXTRACT BUYER
 *
 * Returns the last bidder username from the auction details.
 * Fetches username from Mojang API using the bidder UUID.
 */
async function extractBuyer(details) {
    const bids = details?.bids;
    if (Array.isArray(bids) && bids.length > 0) {
        const lastBid = bids[bids.length - 1];
        if (lastBid?.bidder) {
            const username = await fetchUsername(lastBid.bidder);
            if (username) return username;
        }
    }
    return null;
}

/**
 * SAVE TO BACKEND
 */
async function savePurchase(data) {

    try {

        const response = await axios.post(
            `${CONFIG.BACKEND_URL}/purchases`,
            data,
            {
                timeout: CONFIG.TIMEOUT,
                httpsAgent: httpsAgent
            }
        );

        return response.data;

    } catch (err) {

        // Handle duplicate at backend level
        if (err.response?.status === 409) {

            console.log(
                `   ↺ Backend duplicate: ${data.uuid}`
            );

            return null;
        }

        // Log detailed error info
        if (err.response?.status === 400) {
            console.log(
                `   ✗ Validation error: ${err.response.data?.error || 'Unknown error'}`
            );
            console.log(`   Details: ${JSON.stringify(err.response.data?.details || {})}`);
            console.log(`   Sent data: ${JSON.stringify(data)}`);
        }

        if (err.response?.status === 500) {
            console.log(
                `   ✗ Server error: ${err.response.data?.error || 'Unknown error'}`
            );
            console.log(`   Details: ${JSON.stringify(err.response.data?.details || {})}`);
        }

        throw err;
    }
}

/**
 * MARK AUCTION AS SOLD
 */
async function markAuctionSold(uuid) {

    try {

        const response = await axios.put(
            `${CONFIG.BACKEND_URL}/purchases/${uuid}/sold`,
            {},
            {
                timeout: CONFIG.TIMEOUT,
                httpsAgent: httpsAgent
            }
        );

        return response.data;

    } catch (err) {

        if (err.response?.status === 404) {
            // Auction not in database, ignore
            return null;
        }

        throw err;
    }
}

/**
 * MAIN POLLER
 * 
 * Runs every CONFIG.POLL_INTERVAL milliseconds
 * Fetches recent auctions, extracts hex colors, saves to database
 * Detects when auctions disappear and marks them as sold
 */
async function pollCoflNet() {

    pollCount++;

    const timestamp = new Date()
        .toISOString()
        .split('T')[1]
        .slice(0, 8);

    console.log(`[${timestamp}] Poll #${pollCount}`);

    for (const [itemName, itemId] of Object.entries(CONFIG.ITEMS)) {

        try {

            /**
             * FETCH RECENT AUCTIONS
             */

            const auctions =
                await fetchRecentAuctions(itemId);

            if (!Array.isArray(auctions)) {

                console.log(
                    `   ⚠ Invalid response for ${itemName}`
                );

                continue;
            }

            console.log(
                `   Found ${auctions.length} auctions for ${itemName}`
            );

            // Track current auction UUIDs
            const currentUUIDs = new Set();

            /**
             * LOOP THROUGH EACH AUCTION
             */

            for (const auction of auctions) {

                /**
                 * SKIP INVALID AUCTIONS
                 */

                if (!auction.uuid) {
                    continue;
                }

                // Track this UUID as currently active
                currentUUIDs.add(auction.uuid);

                /**
                 * DUPLICATE PREVENTION
                 * 
                 * If we've already processed this auction UUID,
                 * skip it (don't save again)
                 */

                if (processedAuctions.has(auction.uuid)) {

                    duplicateCount++;
                    continue;
                }

                /**
                 * CRITICAL: Mark as processed BEFORE detail fetch
                 * 
                 * This prevents race conditions where the same
                 * UUID gets fetched twice if polling is fast
                 */

                processedAuctions.add(auction.uuid);

                /**
                 * FETCH DETAILED AUCTION DATA
                 * 
                 * This contains the NBT data with the real hex color
                 */

                let details = null;

                try {

                    details =
                        await fetchAuctionDetails(
                            auction.uuid
                        );

                } catch (detailErr) {

                    console.log(
                        `   ⚠ Failed to get details for ${auction.uuid}`
                    );

                    continue;
                }

                /**
                 * EXTRACT REAL HEX COLOR
                 * 
                 * Each auction has a unique color code for the item
                 * This is NOT random - it comes from the game data
                 */

                const realHex =
                    extractHexColor(details);

                /**
                 * BUILD PAYLOAD FOR BACKEND
                 */

                const buyerName = await extractBuyer(details);

                const purchaseData = {

                    itemName,
                    itemId,

                    uuid: auction.uuid,

                    seller: auction.seller,
                    playerName: auction.playerName,
                    buyer: buyerName,

                    price: auction.price,
                    end: auction.end,
                    tier: determineTier(realHex),
                    closestColor: determineClosestColor(realHex),

                    hexCode: realHex,

                    source: 'coflnet-poller',

                    timestamp:
                        new Date().toISOString()
                };

                /**
                 * SAVE TO DATABASE
                 */

                try {
                    await savePurchase(
                        purchaseData
                    );

                    console.log(
                        `   ✓ ${itemName} | ${auction.playerName} | ${Math.round(auction.price).toLocaleString()} coins | ${realHex}`
                    );

                    successCount++;
                } catch (saveErr) {
                    console.log(
                        `   ✗ Save failed: ${saveErr.message}`
                    );
                    errorCount++;
                }
            }

            /**
             * DETECT SOLD AUCTIONS
             * 
             * Compare current auctions with what we had before
             * If an auction is no longer in the API, it's been sold
             */

            const previousUUIDs = activeAuctions.get(itemName) || new Set();
            const soldUUIDs = Array.from(previousUUIDs).filter(uuid => !currentUUIDs.has(uuid));

            if (soldUUIDs.length > 0) {
                console.log(
                    `   📊 ${soldUUIDs.length} ${itemName} auction(s) sold`
                );

                for (const uuid of soldUUIDs) {
                    try {
                        await markAuctionSold(uuid);
                    } catch (err) {
                        // Error already logged in markAuctionSold
                    }
                }
            }

            // Update active auctions for this item
            activeAuctions.set(itemName, currentUUIDs);

        } catch (err) {

            errorCount++;

            if (err.response) {

                console.log(
                    `   ✗ ${itemName}: HTTP ${err.response.status}`
                );

            } else {

                console.log(
                    `   ✗ ${itemName}: ${err.message}`
                );
            }
        }
    }

    console.log(`   📊 Saved: ${successCount} | Duplicates: ${duplicateCount} | Errors: ${errorCount}\n`);
}

/**
 * MEMORY CLEANUP
 * 
 * The processedAuctions Set grows over time.
 * Every 30 minutes, keep only the most recent 5000 UUIDs.
 * This prevents memory bloat on long-running processes.
 */
setInterval(() => {

    if (processedAuctions.size > 10000) {

        const recent =
            Array.from(processedAuctions).slice(-5000);

        processedAuctions.clear();

        recent.forEach(uuid => {
            processedAuctions.add(uuid);
        });

        console.log(
            `🧹 UUID cache cleaned (${processedAuctions.size} remaining)\n`
        );
    }

}, 1000 * 60 * 30);

/**
 * ERROR HANDLING
 */
process.on('uncaughtException', (err) => {

    console.error(
        '❌ Uncaught Exception:',
        err.message
    );

    process.exit(1);
});

process.on('unhandledRejection', (reason) => {

    console.error(
        '❌ Unhandled Rejection:',
        reason
    );
});

/**
 * GRACEFUL SHUTDOWN
 */
process.on('SIGINT', () => {

    console.log(`
╔══════════════════════════════════════════════════════════╗
║                  Poller Stopped                         ║
╚══════════════════════════════════════════════════════════╝

📊 Final Statistics:
   Total Polls: ${pollCount}
   Auctions Saved: ${successCount}
   Duplicates Filtered: ${duplicateCount}
   Errors: ${errorCount}
   Cached UUIDs: ${processedAuctions.size}
`);

    process.exit(0);
});

/**
 * START POLLING
 */
(async () => {

    // Run first poll immediately
    await pollCoflNet();

    // Then run on interval
    setInterval(
        pollCoflNet,
        CONFIG.POLL_INTERVAL
    );

})();