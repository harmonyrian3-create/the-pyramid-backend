const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const VOTES_FILE = path.join(DATA_DIR, 'votes.json');
const RANKS_FILE = path.join(DATA_DIR, 'ranks.json');

// Make sure the folder exists, but DO NOT create default users.
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Helper functions
function readUsers() { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
function writeUsers(users) { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function readVotes() { return JSON.parse(fs.readFileSync(VOTES_FILE, 'utf8')); }
function writeVotes(votes) { fs.writeFileSync(VOTES_FILE, JSON.stringify(votes, null, 2)); }
function readRanks() { return JSON.parse(fs.readFileSync(RANKS_FILE, 'utf8')); }
function writeRanks(ranks) { fs.writeFileSync(RANKS_FILE, JSON.stringify(ranks, null, 2)); }

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
function calculateRanks() {
    const users = readUsers();
    const votesData = readVotes();
    const eligibleUsers = users.filter(u => !u.isS_Rank);

    const voteCounts = {};
    eligibleUsers.forEach(u => { voteCounts[u.id] = 0; });

    Object.values(votesData.ballots).forEach(picks => {
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
        } else if (user.isProtected) {
            const currentRank = user.rank || 'C';
            if (currentRank === 'F') {
                ranks[user.id] = 'D';
            } else {
                ranks[user.id] = currentRank;
            }
        } else {
            const tierIndex = Math.min(
                Math.floor(currentRankIndex / Math.ceil(sorted.filter(u => u.votes > 0).length / 4)),
                rankLetters.length - 1
            );
            ranks[user.id] = rankLetters[Math.max(0, tierIndex)];
        }
    });

    const fRankUser = sorted.find(u => u.votes === 0 && !u.isProtected);

    return { ranks, fRank: fRankUser ? fRankUser.id : null };
}

// ============================================
// ROUTES
// ============================================

app.post('/api/login', async (req, res) => {
    const { username, password, inviteCode } = req.body;
    const users = readUsers();
    const user = users.find(u => u.username === username && u.inviteCode === inviteCode);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const validPassword = bcrypt.compareSync(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Invalid password' });

    const token = jwt.sign(
        { id: user.id, username: user.username, isS_Rank: user.isS_Rank || false },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );

    res.json({
        token,
        user: {
            id: user.id, username: user.username, rank: user.rank,
            isS_Rank: user.isS_Rank || false, isProtected: user.isProtected || false
        }
    });
});

app.get('/api/users', verifyToken, (req, res) => {
    if (!req.isS_Rank) return res.status(403).json({ error: 'Only S-Rank' });
    const users = readUsers();
    res.json(users.map(u => ({
        id: u.id, username: u.username, rank: u.rank,
        isProtected: u.isProtected || false, isS_Rank: u.isS_Rank || false
    })));
});

app.get('/api/users/public', verifyToken, (req, res) => {
    const users = readUsers();
    res.json(users.filter(u => !u.isS_Rank).map(u => ({
        id: u.id, username: u.username, rank: u.rank,
        isProtected: u.isProtected || false
    })));
});

app.post('/api/votes/cast', verifyToken, (req, res) => {
    const { picks } = req.body;
    const votesData = readVotes();
    
    if (!votesData.voteOpen) return res.status(403).json({ error: 'Voting is closed' });
    if (!Array.isArray(picks) || picks.length === 0) return res.status(400).json({ error: 'Submit at least 1 pick' });
    if (picks.length > 5) return res.status(400).json({ error: 'Maximum 5 picks' });

    const userId = req.userId;
    const users = readUsers();
    const cleanedPicks = [];

    for (const id of picks) {
        if (id === userId) return res.status(400).json({ error: 'Cannot vote for yourself' });
        const target = users.find(u => u.id === id);
        if (!target) return res.status(404).json({ error: 'Invalid pick' });
        if (target.isS_Rank) return res.status(403).json({ error: 'Cannot vote for S-Rank' });
        if (cleanedPicks.includes(id)) continue;
        cleanedPicks.push(id);
    }

    votesData.ballots[userId] = cleanedPicks;
    writeVotes(votesData);

    res.json({ message: 'Ballot submitted', names: cleanedPicks.map(id => users.find(u => u.id === id)?.username || '?') });
});

app.get('/api/votes/results', verifyToken, (req, res) => {
    const votesData = readVotes();
    const users = readUsers();
    const currentMonth = new Date().toISOString().slice(0, 7);

    if (votesData.currentMonth !== currentMonth) {
        return res.json({ month: currentMonth, results: [], totalBallots: 0, myPicks: [] });
    }

    const voteCounts = {};
    Object.values(votesData.ballots).forEach(picks => {
        picks.forEach(id => { voteCounts[id] = (voteCounts[id] || 0) + 1; });
    });

    const eligibleUsers = users.filter(u => !u.isS_Rank);
    const results = eligibleUsers.map(u => ({
        id: u.id, username: u.username, rank: u.rank,
        votes: voteCounts[u.id] || 0, isProtected: u.isProtected || false
    })).sort((a, b) => b.votes - a.votes);

    res.json({
        month: currentMonth, results, totalBallots: Object.keys(votesData.ballots).length,
        myPicks: votesData.ballots[req.userId] || [], voteOpen: votesData.voteOpen
    });
});

app.get('/api/ranks', verifyToken, (req, res) => {
    const rankData = readRanks();
    const users = readUsers();
    const userRanks = {};
    users.forEach(u => {
        if (!u.isS_Rank) userRanks[u.id] = rankData.ranks[u.id] || u.rank || 'D';
    });
    res.json({ month: rankData.currentMonth, ranks: userRanks, fRank: rankData.fRank, lastUpdated: rankData.lastUpdated });
});

app.post('/api/ranks/finalize', verifyToken, (req, res) => {
    if (!req.isS_Rank) return res.status(403).json({ error: 'Only S-Rank' });

    const { ranks, fRank } = calculateRanks();
    const users = readUsers();

    users.forEach(u => {
        if (!u.isS_Rank && ranks[u.id]) u.rank = ranks[u.id];
    });
    writeUsers(users);

    const rankData = readRanks();
    rankData.currentMonth = new Date().toISOString().slice(0, 7);
    rankData.ranks = ranks;
    rankData.fRank = fRank;
    rankData.lastUpdated = new Date().toISOString();
    writeRanks(rankData);

    const votesData = readVotes();
    votesData.currentMonth = new Date().toISOString().slice(0, 7);
    votesData.ballots = {};
    writeVotes(votesData);

    const fRankUser = fRank ? users.find(u => u.id === fRank) : null;
    res.json({ message: 'Ranks finalized', fRank: fRankUser ? { username: fRankUser.username } : null });
});

app.post('/api/votes/toggle', verifyToken, (req, res) => {
    if (!req.isS_Rank) return res.status(403).json({ error: 'Only S-Rank' });
    const votesData = readVotes();
    votesData.voteOpen = req.body.open;
    writeVotes(votesData);
    res.json({ message: req.body.open ? 'Voting opened' : 'Voting closed', voteOpen: votesData.voteOpen });
});

app.post('/api/votes/veto', verifyToken, (req, res) => {
    if (!req.isS_Rank) return res.status(403).json({ error: 'Only S-Rank' });
    const votesData = readVotes();
    const targetUserId = req.body.targetUserId;

    Object.keys(votesData.ballots).forEach(voterId => {
        votesData.ballots[voterId] = votesData.ballots[voterId].filter(id => id !== targetUserId);
    });
    writeVotes(votesData);

    const users = readUsers();
    const user = users.find(u => u.id === targetUserId);
    res.json({ message: `Veto: votes for ${user ? user.username : 'target'} cleared` });
});

app.post('/api/users/protect', verifyToken, (req, res) => {
    if (!req.isS_Rank) return res.status(403).json({ error: 'Only S-Rank' });
    const { userId, protect } = req.body;
    const users = readUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.isProtected = protect;
    if (protect && user.rank === 'F') user.rank = 'D';
    writeUsers(users);

    if (protect) {
        const rankData = readRanks();
        if (rankData.fRank === userId) {
            rankData.fRank = null;
            rankData.ranks[userId] = 'D';
            writeRanks(rankData);
        }
    }

    res.json({ message: protect ? 'User protected' : 'Protection removed' });
});

app.post('/api/users/add', verifyToken, (req, res) => {
    if (!req.isS_Rank) return res.status(403).json({ error: 'Only S-Rank' });
    const { username } = req.body;
    const users = readUsers();

    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Username exists' });

    const newUser = {
        id: uuidv4(), username, password: bcrypt.hashSync('rank', 10),
        isS_Rank: false, isProtected: false, rank: 'D',
        createdAt: new Date().toISOString(),
        inviteCode: `PYRAMID_${uuidv4().slice(0, 8).toUpperCase()}`
    };

    users.push(newUser);
    writeUsers(users);
    res.json({ message: 'User added', user: { username: newUser.username, rank: newUser.rank, inviteCode: newUser.inviteCode } });
});

app.post('/api/users/remove', verifyToken, (req, res) => {
    if (!req.isS_Rank) return res.status(403).json({ error: 'Only S-Rank' });
    const { userId } = req.body;
    const users = readUsers();
    const idx = users.findIndex(u => u.id === userId && !u.isS_Rank);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });

    const removed = users.splice(idx, 1)[0];
    writeUsers(users);
    res.json({ message: `${removed.username} removed` });
});

app.listen(PORT, () => {
    console.log('🏛️ THE PYRAMID LIVE on http://localhost:' + PORT);
    console.log('⚠️  AUTO-GENERATOR DISABLED. MAKE SURE DATA FILES EXIST.');
});