require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({
    origin: 'https://chat.openai.com',
    methods: ['GET', 'POST'],
    credentials: true
}));

// Database configuration
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        require: true,
    }
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('Database connection error:', err);
    } else {
        console.log('Database connected successfully');
    }
});

// Initialize database
async function initializeDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tokens (
                id INTEGER PRIMARY KEY,
                access_token TEXT,
                refresh_token TEXT,
                expires_at BIGINT
            );
        `);
        console.log('Tokens table initialized');
    } catch (error) {
        console.error('Error initializing database:', error);
        throw error;
    }
}

// Token management functions
const saveTokens = async (tokenData) => {
    const query = `
        INSERT INTO tokens (id, access_token, refresh_token, expires_at)
        VALUES (1, $1, $2, $3)
        ON CONFLICT (id) DO UPDATE 
        SET access_token = $1, 
            refresh_token = $2, 
            expires_at = $3
        RETURNING *;
    `;

    const values = [
        tokenData.access_token,
        tokenData.refresh_token,
        tokenData.expires_at
    ];

    try {
        const result = await pool.query(query, values);
        console.log('Tokens saved successfully');
        return result.rows[0];
    } catch (error) {
        console.error('Error saving tokens:', error);
        throw error;
    }
};

const getTokens = async () => {
    try {
        const result = await pool.query('SELECT * FROM tokens WHERE id = 1');
        return result.rows[0] || null;
    } catch (error) {
        console.error('Error getting tokens:', error);
        throw error;
    }
};

// Refresh token function
const refreshToken = async () => {
    try {
        const tokens = await getTokens();
        if (!tokens?.refresh_token) {
            throw new Error('No refresh token available');
        }

        const response = await axios.post('https://api.dexcom.com/v2/oauth2/token', null, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            params: {
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                refresh_token: tokens.refresh_token,
                grant_type: 'refresh_token'
            }
        });

        const newTokens = {
            access_token: response.data.access_token,
            refresh_token: response.data.refresh_token,
            expires_at: Date.now() + response.data.expires_in * 1000
        };

        return await saveTokens(newTokens);
    } catch (error) {
        console.error('Error refreshing token:', error);
        throw error;
    }
};

// Auth callback endpoint
app.post('/auth/callback', async (req, res) => {
    const { code } = req.body;
    try {
        const response = await axios.post('https://api.dexcom.com/v2/oauth2/token', null, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            params: {
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: process.env.REDIRECT_URI
            }
        });

        const tokens = {
            access_token: response.data.access_token,
            refresh_token: response.data.refresh_token,
            expires_at: Date.now() + response.data.expires_in * 1000
        };

        await saveTokens(tokens);
        res.status(200).json({ message: 'Authorization successful' });
    } catch (error) {
        console.error('Token exchange failed:', error.response?.data || error.message);
        res.status(500).json({ error: 'Token exchange failed' });
    }
});

// Glucose endpoint
app.get('/glucose', async (req, res) => {
    const { startDate, endDate } = req.query;
    try {
        let tokens = await getTokens();

        if (!tokens?.access_token) {
            return res.status(401).json({ error: 'Not authorized. Please complete OAuth flow first.' });
        }

        if (Date.now() > tokens.expires_at) {
            tokens = await refreshToken();
        }

        const response = await axios.get('https://api.dexcom.com/v2/users/self/egvs', {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
            params: { startDate, endDate }
        });

        res.json(response.data.records);
    } catch (error) {
        console.error('Failed to fetch glucose data:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Failed to fetch glucose data',
            details: error.response?.data || error.message
        });
    }
});

// Auth refresh endpoint
app.post('/auth/refresh', async (req, res) => {
    const { refresh_token } = req.body;
    try {
        const tokens = await refreshToken();
        res.json({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_in: Math.floor((tokens.expires_at - Date.now()) / 1000)
        });
    } catch (error) {
        console.error('Token refresh failed:', error);
        res.status(500).json({ error: 'Token refresh failed' });
    }
});

// Trends endpoint
app.get('/trends', async (req, res) => {
    const { startDate, endDate } = req.query;
    try {
        let tokens = await getTokens();
        if (!tokens?.access_token) {
            return res.status(401).json({ error: 'Not authorized' });
        }

        if (Date.now() > tokens.expires_at) {
            tokens = await refreshToken();
        }

        const response = await axios.get('https://api.dexcom.com/v2/users/self/egvs', {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
            params: { startDate, endDate }
        });

        const readings = response.data.records;
        const values = readings.map(r => r.value);

        const analysis = {
            average: values.reduce((a, b) => a + b, 0) / values.length,
            highest: Math.max(...values),
            lowest: Math.min(...values),
            count: values.length
        };

        res.json(analysis);
    } catch (error) {
        console.error('Failed to analyze trends:', error);
        res.status(500).json({ error: 'Failed to analyze trends' });
    }
});

// Charts endpoint
app.get('/charts', async (req, res) => {
    const { startDate, endDate } = req.query;
    try {
        let tokens = await getTokens();
        if (!tokens?.access_token) {
            return res.status(401).json({ error: 'Not authorized' });
        }

        if (Date.now() > tokens.expires_at) {
            tokens = await refreshToken();
        }

        const response = await axios.get('https://api.dexcom.com/v2/users/self/egvs', {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
            params: { startDate, endDate }
        });

        const readings = response.data.records;
        const chartJSNodeCanvas = new ChartJSNodeCanvas({ width: 800, height: 400 });

        const configuration = {
            type: 'line',
            data: {
                labels: readings.map(r => new Date(r.systemTime).toLocaleTimeString()),
                datasets: [{
                    label: 'Glucose Readings',
                    data: readings.map(r => r.value),
                    borderColor: 'rgb(75, 192, 192)',
                    tension: 0.1
                }]
            }
        };

        const image = await chartJSNodeCanvas.renderToBuffer(configuration);
        res.set('Content-Type', 'image/png');
        res.send(image);
    } catch (error) {
        console.error('Failed to generate chart:', error);
        res.status(500).json({ error: 'Failed to generate chart' });
    }
});

// Initialize database and start server
const PORT = process.env.PORT || 3000;
initializeDatabase()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    })
    .catch(error => {
        console.error('Failed to initialize server:', error);
        process.exit(1);
    });

