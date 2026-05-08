const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database setup
const dbPath = path.join(__dirname, 'purchases.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Database error:', err);
    } else {
        console.log('Connected to SQLite database');
        initializeDatabase();
    }
});

// Initialize database tables
function initializeDatabase() {
    db.run(`
        CREATE TABLE IF NOT EXISTS purchases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uuid TEXT UNIQUE NOT NULL,
            itemName TEXT NOT NULL,
            itemId TEXT,
            hexCode TEXT NOT NULL,
            price REAL NOT NULL,
            playerName TEXT,
            seller TEXT,
            buyer TEXT,
            tier TEXT,
            end DATETIME,
            source TEXT,
            status TEXT DEFAULT 'ACTIVE',
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            soldAt DATETIME
        )
    `, (err) => {
        if (err) console.error('Error creating purchases table:', err);
        else console.log('Purchases table initialized');
    });

    const addColumnIfMissing = (columnName, columnDef) => {
        db.all(`PRAGMA table_info(purchases)`, [], (err, rows) => {
            if (err) {
                console.error('Error reading purchases table info:', err);
                return;
            }

            if (!rows.some(row => row.name === columnName)) {
                db.run(`ALTER TABLE purchases ADD COLUMN ${columnName} ${columnDef}`, (alterErr) => {
                    if (alterErr) {
                        console.error(`Error adding column ${columnName}:`, alterErr);
                    } else {
                        console.log(`Added missing purchases column: ${columnName}`);
                    }
                });
            }
        });
    };

    addColumnIfMissing('buyer', 'TEXT');
    addColumnIfMissing('tier', 'TEXT');
    addColumnIfMissing('closestColor', 'TEXT');
    addColumnIfMissing('status', "TEXT DEFAULT 'ACTIVE'");
    addColumnIfMissing('soldAt', 'DATETIME');

    db.run(`
        CREATE TABLE IF NOT EXISTS stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            itemName TEXT UNIQUE NOT NULL,
            hexCode TEXT NOT NULL,
            totalPurchases INTEGER DEFAULT 0,
            averagePrice REAL DEFAULT 0,
            minPrice REAL DEFAULT 0,
            maxPrice REAL DEFAULT 0,
            lastUpdate DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) console.error('Error creating stats table:', err);
        else console.log('Stats table initialized');
    });

    // Create indexes for faster queries
    db.run(`CREATE INDEX IF NOT EXISTS idx_item ON purchases(itemName)`, (err) => {
        if (err) console.error('Error creating index:', err);
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_timestamp ON purchases(timestamp)`, (err) => {
        if (err) console.error('Error creating index:', err);
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_hex ON purchases(hexCode)`, (err) => {
        if (err) console.error('Error creating hexCode index:', err);
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_buyer ON purchases(buyer)`, (err) => {
        if (err) console.error('Error creating buyer index:', err);
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_seller ON purchases(seller)`, (err) => {
        if (err) console.error('Error creating seller index:', err);
    });
}

// ============================================
// API Routes
// ============================================

// Mark auction as sold
app.put('/api/purchases/:uuid/sold', (req, res) => {
    const uuid = req.params.uuid;

    const query = `
        UPDATE purchases
        SET status = 'SOLD', soldAt = CURRENT_TIMESTAMP
        WHERE uuid = ?
    `;

    db.run(query, [uuid], function(err) {
        if (err) {
            res.status(500).json({ error: 'Failed to update purchase', details: err.message });
        } else if (this.changes === 0) {
            res.status(404).json({ error: 'Auction not found' });
        } else {
            res.json({
                uuid,
                status: 'SOLD',
                soldAt: new Date().toISOString(),
                message: 'Auction marked as sold'
            });
        }
    });
});

// Get all active auctions
app.get('/api/purchases', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 10000);
    const offset = parseInt(req.query.offset) || 0;
    const item = req.query.item;

    let query = 'SELECT * FROM purchases';
    let params = [];

    if (item) {
        query += ' WHERE itemName = ?';
        params.push(item);
    }

    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: 'Database error', details: err.message });
        } else {
            res.json({
                purchases: rows || [],
                count: rows ? rows.length : 0,
                limit,
                offset
            });
        }
    });
});

// Get statistics for all items
app.get('/api/stats', (req, res) => {
    const query = `
        SELECT 
            itemName,
            COUNT(*) as totalPurchases,
            AVG(price) as averagePrice,
            MIN(price) as minPrice,
            MAX(price) as maxPrice,
            MAX(timestamp) as lastUpdate,
            (SELECT hexCode FROM purchases p2 WHERE p2.itemName = purchases.itemName ORDER BY p2.timestamp DESC LIMIT 1) as hexCode
        FROM purchases
        GROUP BY itemName
        ORDER BY itemName
    `;

    db.all(query, [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: 'Database error', details: err.message });
        } else {
            const stats = {};
            rows.forEach(row => {
                stats[row.itemName] = {
                    hexCode: row.hexCode,
                    totalPurchases: row.totalPurchases,
                    averagePrice: Math.round(row.averagePrice),
                    minPrice: Math.round(row.minPrice),
                    maxPrice: Math.round(row.maxPrice),
                    lastUpdate: row.lastUpdate
                };
            });
            res.json(stats);
        }
    });
});

// Get statistics for a specific item
app.get('/api/stats/:item', (req, res) => {
    const item = req.params.item;

    const query = `
        SELECT 
            COUNT(*) as totalPurchases,
            AVG(price) as averagePrice,
            MIN(price) as minPrice,
            MAX(price) as maxPrice,
            MAX(timestamp) as lastUpdate,
            (SELECT hexCode FROM purchases WHERE itemName = ? ORDER BY timestamp DESC LIMIT 1) as hexCode
        FROM purchases
        WHERE itemName = ?
    `;

    db.get(query, [item, item], (err, row) => {
        if (err) {
            res.status(500).json({ error: 'Database error', details: err.message });
        } else if (!row || row.totalPurchases === 0) {
            res.status(404).json({ error: 'No data for this item' });
        } else {
            res.json({
                item: item,
                hexCode: row.hexCode,
                totalPurchases: row.totalPurchases,
                averagePrice: Math.round(row.averagePrice),
                minPrice: Math.round(row.minPrice),
                maxPrice: Math.round(row.maxPrice),
                lastUpdate: row.lastUpdate
            });
        }
    });
});

// Add a new purchase (called by external API poller)
app.post('/api/purchases', (req, res) => {
    const { itemName, itemId, hexCode, price, seller, playerName, buyer, tier, closestColor, end, source, uuid } = req.body;

    // Validate input
    if (!uuid || !itemName || price === undefined) {
        return res.status(400).json({ 
            error: 'Missing required fields: uuid, itemName, price' 
        });
    }

    // Use fallback hex code if not provided
    const finalHexCode = hexCode || '#000000';

    const query = `
        INSERT INTO purchases (uuid, itemName, itemId, hexCode, price, playerName, seller, buyer, tier, closestColor, end, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [uuid, itemName, itemId || null, finalHexCode, price, playerName || null, seller || null, buyer || null, tier || null, closestColor || null, end || null, source || null], function(err) {
        if (err) {
            // Handle duplicate UUID
            if (err.message.includes('UNIQUE')) {
                res.status(409).json({ error: 'Auction already recorded', details: err.message });
            } else {
                res.status(500).json({ error: 'Failed to insert purchase', details: err.message });
            }
        } else {
            res.status(201).json({
                id: this.lastID,
                uuid,
                itemName,
                hexCode: finalHexCode,
                price,
                timestamp: new Date().toISOString(),
                message: 'Purchase recorded'
            });
        }
    });
});

// Bulk add purchases
app.post('/api/purchases/bulk', (req, res) => {
    const { purchases } = req.body;

    if (!Array.isArray(purchases)) {
        return res.status(400).json({ error: 'Expected array of purchases' });
    }

    let inserted = 0;
    let errors = [];

    const insertOne = (index) => {
        if (index >= purchases.length) {
            res.json({
                inserted,
                failed: errors.length,
                errors: errors,
                message: `Inserted ${inserted} purchases`
            });
            return;
        }

        const p = purchases[index];
        const query = `
            INSERT INTO purchases (uuid, itemName, itemId, hexCode, price, playerName, seller, buyer, tier, closestColor, end, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query,
            [p.uuid, p.itemName, p.itemId, p.hexCode, p.price, p.playerName || null, p.seller || null, p.buyer || null, p.tier || null, p.closestColor || null, p.end || null, p.source || null],
            function(err) {
                if (err) {
                    errors.push({ index, item: p.itemName, error: err.message });
                } else {
                    inserted++;
                }
                insertOne(index + 1);
            }
        );
    };

    insertOne(0);
});

// Get purchases for a time range
app.get('/api/purchases/range', (req, res) => {
    const startDate = req.query.start;
    const endDate = req.query.end;

    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'Missing start and end dates' });
    }

    const query = `
        SELECT * FROM purchases
        WHERE timestamp BETWEEN ? AND ?
        ORDER BY timestamp DESC
    `;

    db.all(query, [startDate, endDate], (err, rows) => {
        if (err) {
            res.status(500).json({ error: 'Database error', details: err.message });
        } else {
            res.json({
                purchases: rows || [],
                count: rows ? rows.length : 0,
                range: { start: startDate, end: endDate }
            });
        }
    });
});

// Export data as CSV
app.get('/api/export/csv', (req, res) => {
    const query = `SELECT uuid, itemName, itemId, hexCode, price, playerName, seller, buyer, tier, end, source, timestamp FROM purchases ORDER BY timestamp DESC`;

    db.all(query, [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: 'Database error' });
        } else {
            let csv = 'UUID,Item,Item ID,Hex Code,Price,Player,Seller,Buyer,Tier,End,Source,Timestamp\n';
            rows.forEach(row => {
                csv += `"${row.uuid}","${row.itemName}","${row.itemId}","${row.hexCode}",${row.price},"${row.playerName}","${row.seller}","${row.buyer}","${row.tier}","${row.end}","${row.source}","${row.timestamp}"\n`;
            });

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="purchases.csv"');
            res.send(csv);
        }
    });
});

// Search purchases by hex code
app.get('/api/purchases/search/hex', (req, res) => {
    const hex = req.query.hex;
    const item = req.query.item;
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);

    if (!hex) {
        return res.status(400).json({ error: 'Missing hex parameter' });
    }

    let query = 'SELECT * FROM purchases WHERE hexCode = ?';
    let params = [hex.toUpperCase()];

    if (item) {
        query += ' AND itemName = ?';
        params.push(item);
    }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: 'Database error', details: err.message });
        } else {
            res.json({
                hex: hex.toUpperCase(),
                item: item || null,
                purchases: rows || [],
                count: rows ? rows.length : 0
            });
        }
    });
});

// Search purchases by username (buyer or seller)
app.get('/api/purchases/search/user', (req, res) => {
    const username = req.query.username;
    const role = req.query.role; // 'buyer', 'seller', or 'both'
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);

    if (!username) {
        return res.status(400).json({ error: 'Missing username parameter' });
    }

    let query;
    let params = [];

    if (role === 'buyer') {
        query = 'SELECT * FROM purchases WHERE buyer LIKE ?';
        params.push(`%${username}%`);
    } else if (role === 'seller') {
        query = 'SELECT * FROM purchases WHERE seller LIKE ? OR playerName LIKE ?';
        params.push(`%${username}%`, `%${username}%`);
    } else {
        // both - search in buyer, seller, and playerName
        query = 'SELECT * FROM purchases WHERE buyer LIKE ? OR seller LIKE ? OR playerName LIKE ?';
        params.push(`%${username}%`, `%${username}%`, `%${username}%`);
    }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: 'Database error', details: err.message });
        } else {
            res.json({
                username,
                role: role || 'both',
                purchases: rows || [],
                count: rows ? rows.length : 0
            });
        }
    });
});

// Get statistics grouped by hex code for an item
app.get('/api/stats/:item/hex', (req, res) => {
    const item = req.params.item;

    const query = `
        SELECT
            hexCode,
            COUNT(*) as count,
            AVG(price) as avgPrice,
            MIN(price) as minPrice,
            MAX(price) as maxPrice,
            tier,
            MAX(timestamp) as lastSeen
        FROM purchases
        WHERE itemName = ?
        GROUP BY hexCode
        ORDER BY count DESC
    `;

    db.all(query, [item], (err, rows) => {
        if (err) {
            res.status(500).json({ error: 'Database error', details: err.message });
        } else if (!rows || rows.length === 0) {
            res.status(404).json({ error: 'No data for this item' });
        } else {
            res.json({
                item,
                hexStats: rows.map(row => ({
                    hexCode: row.hexCode,
                    tier: row.tier,
                    count: row.count,
                    avgPrice: Math.round(row.avgPrice),
                    minPrice: Math.round(row.minPrice),
                    maxPrice: Math.round(row.maxPrice),
                    lastSeen: row.lastSeen
                }))
            });
        }
    });
});

// Get buyer/seller statistics
app.get('/api/stats/users/:username', (req, res) => {
    const username = req.params.username;

    const buyerQuery = `
        SELECT
            itemName,
            COUNT(*) as purchases,
            AVG(price) as avgPrice,
            SUM(price) as totalSpent,
            MAX(timestamp) as lastPurchase
        FROM purchases
        WHERE buyer = ?
        GROUP BY itemName
    `;

    const sellerQuery = `
        SELECT
            itemName,
            COUNT(*) as sales,
            AVG(price) as avgPrice,
            SUM(price) as totalEarned,
            MAX(timestamp) as lastSale
        FROM purchases
        WHERE playerName = ? OR seller = ?
        GROUP BY itemName
    `;

    db.all(buyerQuery, [username], (err, buyerRows) => {
        if (err) {
            return res.status(500).json({ error: 'Database error', details: err.message });
        }

        db.all(sellerQuery, [username, username], (err2, sellerRows) => {
            if (err2) {
                return res.status(500).json({ error: 'Database error', details: err2.message });
            }

            res.json({
                username,
                buying: buyerRows || [],
                selling: sellerRows || [],
                totalPurchases: (buyerRows || []).reduce((sum, r) => sum + r.purchases, 0),
                totalSales: (sellerRows || []).reduce((sum, r) => sum + r.sales, 0),
                totalSpent: (buyerRows || []).reduce((sum, r) => sum + r.totalSpent, 0),
                totalEarned: (sellerRows || []).reduce((sum, r) => sum + r.totalEarned, 0)
            });
        });
    });
});

// Get daily tier statistics (T1, T2, T3, Fade T1, Fade T2, Fade T3 counts for today)
app.get('/api/stats/tiers/daily', (req, res) => {
    const today = new Date().toISOString().split('T')[0];

    const query = `
        SELECT
            tier,
            COUNT(*) as count
        FROM purchases
        WHERE DATE(timestamp) = DATE('now', 'localtime')
          AND tier IN ('T1', 'T2', 'T3', 'Fade T1', 'Fade T2', 'Fade T3')
        GROUP BY tier
    `;

    db.all(query, [], (err, tierRows) => {
        if (err) {
            return res.status(500).json({ error: 'Database error', details: err.message });
        }

        const result = {
            date: today,
            T1: 0,
            T2: 0,
            T3: 0,
            fadeT1: 0,
            fadeT2: 0,
            fadeT3: 0,
            total: 0
        };

        tierRows.forEach(row => {
            const key = row.tier === 'Fade T1' ? 'fadeT1' :
                        row.tier === 'Fade T2' ? 'fadeT2' :
                        row.tier === 'Fade T3' ? 'fadeT3' :
                        row.tier;
            if (result[key] !== undefined) {
                result[key] = row.count;
                result.total += row.count;
            }
        });

        res.json(result);
    });
});

// Get total tier statistics (all-time counts)
app.get('/api/stats/tiers/total', (req, res) => {
    const query = `
        SELECT
            tier,
            COUNT(*) as count
        FROM purchases
        WHERE tier IN ('T1', 'T2', 'T3', 'Fade T1', 'Fade T2', 'Fade T3')
        GROUP BY tier
    `;

    db.all(query, [], (err, tierRows) => {
        if (err) {
            return res.status(500).json({ error: 'Database error', details: err.message });
        }

        const result = {
            T1: 0,
            T2: 0,
            T3: 0,
            fadeT1: 0,
            fadeT2: 0,
            fadeT3: 0,
            total: 0
        };

        tierRows.forEach(row => {
            const key = row.tier === 'Fade T1' ? 'fadeT1' :
                        row.tier === 'Fade T2' ? 'fadeT2' :
                        row.tier === 'Fade T3' ? 'fadeT3' :
                        row.tier;
            if (result[key] !== undefined) {
                result[key] = row.count;
                result.total += row.count;
            }
        });

        res.json(result);
    });
});

// Get summary statistics
app.get('/api/summary', (req, res) => {
    db.all(`
        SELECT 
            COUNT(*) as totalRecords,
            COUNT(DISTINCT itemName) as uniqueItems,
            SUM(price) as totalSpent,
            MIN(price) as minPrice,
            MAX(price) as maxPrice,
            AVG(price) as avgPrice,
            MIN(timestamp) as firstRecord,
            MAX(timestamp) as lastRecord
        FROM purchases
    `, [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: 'Database error', details: err.message });
        } else {
            const row = rows[0];
            res.json({
                totalRecords: row.totalRecords || 0,
                uniqueItems: row.uniqueItems || 0,
                totalSpent: Math.round(row.totalSpent || 0),
                minPrice: Math.round(row.minPrice || 0),
                maxPrice: Math.round(row.maxPrice || 0),
                avgPrice: Math.round(row.avgPrice || 0),
                firstRecord: row.firstRecord || null,
                lastRecord: row.lastRecord || null
            });
        }
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`\n🚀 CoflNet Monitor Server running on http://localhost:${PORT}`);
    console.log(`📊 API endpoints:`);
    console.log(`   GET  /api/purchases - Get all purchases`);
    console.log(`   GET  /api/purchases/search/hex?hex=HEXCODE - Search by color`);
    console.log(`   GET  /api/purchases/search/user?username=NAME - Search by user`);
    console.log(`   GET  /api/stats - Get statistics for all items`);
    console.log(`   GET  /api/stats/:item/hex - Get hex color stats for item`);
    console.log(`   GET  /api/stats/users/:username - Get user trading stats`);
    console.log(`   GET  /api/stats/tiers/daily - Get daily T1/T2/T3 tier counts`);
    console.log(`   GET  /api/stats/tiers/total - Get all-time T1/T2/T3 tier counts`);
    console.log(`   POST /api/purchases - Add a new purchase`);
    console.log(`   GET  /api/summary - Get overall summary\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nClosing database...');
    db.close((err) => {
        if (err) {
            console.error('Database error on shutdown:', err);
        } else {
            console.log('Database closed. Goodbye!');
        }
        process.exit(0);
    });
});

module.exports = app;