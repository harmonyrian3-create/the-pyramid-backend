const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ============================================
// NEON DATABASE CONNECTION
// ============================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
    if (err) console.error('❌ NEON CONNECTION ERROR:', err.stack);
    else { console.log('✅ Connected to Neon Postgres'); release(); }
});

function verifyToken(req, res, next) {
    const auth = req.headers['authorization'];
    if (!auth) return res.status(401).json({ error: 'No token provided' });

    try {
        const parts = auth.split(' ');
        const raw = parts.length === 2 ? parts[1] : parts[0];
        const decoded = jwt.verify(raw, process.env.JWT_SECRET);
        req.userId = decoded.id;
        req.isS_Rank = decoded.isS_Rank;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ============================================
// CALCULATE RANKS
// ============================================
async function calculateRanks() {
    const usersRes = await pool.query('SELECT * FROM users');
    const users = usersRes.rows;
    
    const month = new Date().toISOString().slice(0, 7);
    const votesRes = await pool.query('SELECT * FROM votes WHERE month = $1', [month]);
    const votesData = votesRes.rows[0] || { ballots: {} };
    
    const eligibleUsers = users.filter(u => !u.iss_rank);

    const voteCounts = {};
    eligibleUsers.forEach(u => { voteCounts[u.id] = 0; });

    Object.values(votesData.ballots || {}).forEach(picks => {
        picks.forEach(id => {
            if (voteCounts[id] !== undefined) voteCounts[id]++;
        });
    });

    const sorted = eligibleUsers
        .map(u => ({ ...u, votes: voteCounts[u.id] || 0 }))
        .sort((a, b) => b.votes - a.votes);

    const ranks = {};
    let currentRankIndex = 0;
    let prevVotes = -1;
    const rankLetters = ['A', 'B', 'C', 'D'];

    sorted.forEach((user, index) => {
        if (user.votes !== prevVotes) {
            currentRankIndex = index;
            prevVotes = user.votes;
        }

        if (user.votes === 0) {
            ranks[user.id] = 'F';
        } else if (user.isprotected) {
            const currentRank = (user.rank === 'UNRANKED') ? 'C' : (user.rank || 'C');
            ranks[user.id] = (currentRank === 'F') ? 'D' : currentRank;
        } else {
            const tierIndex = Math.min(
                Math.floor(currentRankIndex / Math.ceil(sorted.filter(u => u.votes > 0).length / 4)),
                rankLetters.length - 1
            );
            ranks[user.id] = rankLetters[Math.max(0, tierIndex)];
        }
    });

    const fRankUser = sorted.find(u => u.votes === 0 && !u.isprotected);
    return { ranks, fRank: fRankUser ? fRankUser.id : null };
}

// ============================================
// ROUTES
// ============================================

app.post('/api/login', async (req, res) => {
    const { username, password, inviteCode } = req.body;
    
    const usersRes = await pool.query('SELECT * FROM users WHERE username = $1 AND invitecode = $2', [username, inviteCode]);
    const user = usersRes.rows[0];
    
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const validPassword = bcrypt.compareSync(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Invalid password' });

    const token = jwt.sign(
        { id: user.id, username: user.username, isS_Rank: user.iss_rank || false },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );

    res.json({
        token,
        user: {
            id: user.id, username: user.username, rank: user.rank,
            isS_Rank: user.iss_rank || false, isProtected: user.isprotected || false
        }
    });
});

app.get('/api/users', verifyToken, async (req, res) => {
    if (!req.isS_Rank) return res.status(403).json({ error: 'Only S-Rank' });
    const usersRes = await pool.query('SELECT * FROM users');
    const users = usersRes.rows;
    
    res.json(users.map(u => ({
        id: u.id, username: u.username, rank: u.rank,
        isProtected: u.isprotected || false, isS_Rank: u.iss_rank || false
    })));
});

app.get('/api/users/public', verifyToken, async (req, res) => {
    const usersRes = await pool.query('SELECT * FROM users WHERE iss_rank = false');
    const users = usersRes.rows;
    
    res.json(users.map(u => ({
        id: u.id, username: u.username, rank: u.rank,
        isProtected: u.isprotected || false
    })));
});

app.post('/api/votes/cast', verifyToken, async (req, res) => {
    const { picks } = req.body;
    const month = new Date().toISOString().slice(0, 7);
    
    const votesRes = await pool.query('SELECT * FROM votes WHERE month = $1', [month]);
    const votesData = votesRes.rows[0] || { ballots: {}, voteopen: true };
    
    if (!votesData.voteopen) return res.status(403).json({ error: 'Voting is closed' });
    if (!Array.isArray(picks) || picks.length === 0) return res.status(400).json({ error: 'Submit at least 1 pick' });
    if (picks.length > 5) return res.status(400).json({ error: 'Maximum 5 picks' });

    const userId = req.userId;
    const usersRes = await pool.query('SELECT * FROM users');
    const users = usersRes.rows;
    
    const cleanedPicks = [];

    for (const id of picks) {
        if (id === userId) return res.status(400).json({ error: 'Cannot vote for yourself' });
        const target = users.find(u => u.id === id);
        if (!target) return res.status(404).json({ error: 'Invalid pick' });
        if (target.iss_rank) return res.status(403).json({ error: 'Cannot vote for S-Rank' });
        if (cleanedPicks.includes(id)) continue;
        cleanedPicks.push(id);
    }

    const ballots = votesData.ballots || {};
    ballots[userId] = cleanedPicks;

    if (votesRes.rows.length > 0) {
        await pool.query('UPDATE votes SET ballots = $1 WHERE month = $2', [ballots, month]);
    } else {
        await pool.query('INSERT INTO votes (month, ballots, voteopen) VALUES ($1, $2, true)', [month, ballots]);
    }

    res.json({ message: 'Ballot submitted', names: cleanedPicks.map(id => users.find(u => u.id === id)?.username || '?') });
});

app.get('/api/votes/results', verifyToken, async (req, res) => {
    const month = new Date().toISOString().slice(0, 7);
    const votesRes = await pool.query('SELECT * FROM votes WHERE month = $1', [month]);
    const votesData = votesRes.rows[0] || { ballots: {}, voteopen: true };

    const usersRes = await pool.query('SELECT * FROM users');
    const users = usersRes.rows;

    const voteCounts = {};
    Object.values(votesData.ballots || {}).forEach(picks => {
        picks.forEach(id => { voteCounts[id] = (voteCounts[id] || 0) + 1; });
    });

    const eligibleUsers = users.filter(u => !u.iss_rank);
    const results = eligibleUsers.map(u => ({
        id: u.id, username: u.username, rank: u.rank,
        votes: voteCounts[u.id] || 0, isProtected: u.isprotected || false
    })).sort((a, b) => b.votes - a.votes);

    res.json({
        month, results, totalBallots: Object.keys(votesData.ballots || {}).length,
        myPicks: votesData.ballots?.[req.userId] || [], voteOpen: votesData.voteopen
    });
});

app.get('/api/ranks', verifyToken, async (req, res) => {
    const month = new Date().toISOString().slice(0, 7);
    const ranksRes = await pool.query('SELECT * FROM ranks WHERE month = $1', [month]);
    const rankData = ranksRes.rows[0] || { ranks: {}, frank: null };

    const usersRes = await pool.query('SELECT * FROM users');
    const users = usersRes.rows;

    const userRanks = {};
    users.forEach(u => {
        if (!u.iss_rank) userRanks[u.id] = rankData.ranks[u.id] || u.rank || 'UNRANKED';
    });

    res.json({ month, ranks: userRanks, fRank: rankData.frank });
});

app.post('/api/ranks/finalize', verifyToken, async (req, res) => {
    if (!req.isS_Rank) return res.status(403).json({ error: 'Only S-Rank' });

    const { ranks, fRank } = await calculateRanks();
    const month = new Date().toISOString().slice(0, 7);

    for (const [userId, rank] of Object.entries(ranks)) {
        await pool.query('UPDATE users SET rank = $1 WHERE id = $2', [rank, userId]);
    }

    const ranksRes = await pool.query('SELECT * FROM ranks WHERE month = $1', [month]);
    if (ranksRes.rows.length > 0) {
        await pool.query('UPDATE ranks SET ranks = $1, frank = $2 WHERE month = $3', [ranks, fRank, month]);
    } else {
        await pool.query('INSERT INTO ranks (month, ranks, frank) VALUES ($1, $2, $3)', [month, ranks, fRank]);
    }

    await pool.query('UPDATE votes SET ballots = $1 WHERE month = $2', [{}, month]);

    const usersRes = await pool.query('SELECT * FROM users');
    const users = usersRes.rows;
    const fRankUser = fRank ? users.find(u => u.id === fRank) : null;
    
    res.json({ message: 'Ranks finalized', fRank: fRankUser ? { username: fRankUser.username } : null });
});

app.post('/api/votes/toggle', verifyToken, async (req, res) => {
    if (!req.isS_Rank) return res.status(403).json({ error: 'Only S-Rank' });
    const month = new Date().toISOString().slice(0, 7);
    
    const votesRes = await pool.query('SELECT * FROM votes WHERE month = $1', [month]);
    if (votesRes.rows.length > 0) {
        await pool.query('UPDATE votes SET voteopen = $1 WHERE month = $2', [req.body.open, month]);
    } else {
        await pool.query('INSERT INTO votes (month, ballots, voteopen) VALUES ($1, $2, $3)', [month, {}, req.body.open]);
    }
    
    res.json({ message: req.body.open ? 'Voting opened' : 'Voting closed', voteOpen: req.body.open });
});

app.post('/api/votes/veto', verifyToken, async (req, res) => {
    if (!req.isS_Rank) return res.status(403).json({ error: 'Only S-Rank' });
    const month = new Date().toISOString().slice(0, 7);
    const targetUserId = req.body.targetUserId;

    const votesRes = await pool.query('SELECT * FROM votes WHERE month = $1', [month]);
    if (votesRes.rows.length > 0) {
        const ballots = votesRes.rows[0].ballots || {};
        Object.keys(ballots).forEach(voterId => {
            ballots[voterId] = ballots[voterId].filter(id => id !== targetUserId);
        });
        await pool.query('UPDATE votes SET ballots = $1 WHERE month = $2', [ballots, month]);
    }

    const usersRes = await pool.query('SELECT * FROM users WHERE id = $1', [targetUserId]);
    const user = usersRes.rows[0];
    res.json({ message: `Veto: votes for ${user ? user.username : 'target'} cleared` });
});

app.post('/api/users/protect', verifyToken, async (req, res) => {
    if (!req.isS_Rank) return res.status(403).json({ error: 'Only S-Rank' });
    const { userId, protect } = req.body;

    await pool.query('UPDATE users SET isprotected = $1, rank = CASE WHEN $2 = true AND rank = \'F\' THEN \'D\' ELSE rank END WHERE id = $3', [protect, protect, userId]);

    if (protect) {
        const month = new Date().toISOString().slice(0, 7);
        const ranksRes = await pool.query('SELECT * FROM ranks WHERE month = $1', [month]);
        if (ranksRes.rows.length > 0) {
            const rankData = ranksRes.rows[0];
            if (rankData.frank === userId) {
                const newRanks = rankData.ranks;
                newRanks[userId] = 'D';
                await pool.query('UPDATE ranks SET ranks = $1, frank = null WHERE month = $2', [newRanks, month]);
            }
        }
    }

    res.json({ message: protect ? 'User protected' : 'Protection removed' });
});

// 🛠️ 4-DIGIT TOKEN GENERATOR
app.post('/api/users/add', verifyToken, async (req, res) => {
    if (!req.isS_Rank) return res.status(403).json({ error: 'Only S-Rank' });
    const { username } = req.body;

    const existing = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Username exists' });

    const newId = crypto.randomUUID();
    // THIS IS THE 4-DIGIT TOKEN LOGIC
    const newInvite = `PYRAMID_${Math.floor(1000 + Math.random() * 9000)}`;
    const hashedPassword = bcrypt.hashSync('rank', 10);

    await pool.query(
        'INSERT INTO users (id, username, password, iss_rank, isprotected, rank, invitecode) VALUES ($1, $2, $3, false, false, $4, $5)',
        [newId, username, hashedPassword, 'UNRANKED', newInvite]
    );

    res.json({ message: 'User added', user: { username, rank: 'UNRANKED', inviteCode: newInvite } });
});

app.post('/api/users/remove', verifyToken, async (req, res) => {
    if (!req.isS_Rank) return res.status(403).json({ error: 'Only S-Rank' });
    const { userId } = req.body;

    const userRes = await pool.query('SELECT * FROM users WHERE id = $1 AND iss_rank = false', [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ message: `${userRes.rows[0].username} removed` });
});

app.listen(PORT, () => {
    console.log('🏛️ THE PYRAMID LIVE on http://localhost:' + PORT);
    console.log('🔥 PYRAMID GAME SYSTEM ACTIVE (NEON DB)');
});