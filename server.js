const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// ENTRANT CONFIG — edit names and handicaps here
// ============================================================
const ENTRANTS = [
  { name: "James Chase",       handicap: 9  },
  { name: "Dustin Hatcher",    handicap: 8  },
  { name: "Stephen Culpepper", handicap: 9  },
  { name: "Braxton Smith",     handicap: 9  },
  { name: "Fleet Jernigan",    handicap: 11 },
  { name: "Jack Konstanzer",   handicap: 10 },
  { name: "Max Konstanzer",    handicap: 18 },
  { name: "Carter Baum",       handicap: 19 },
  { name: "Tommy Taylor",      handicap: 20 },
  { name: "Aaron Stroker",     handicap: 18 },
  { name: "Thomas Nader",      handicap: 15 },
  { name: "Nick Graham",       handicap: 16 },
];
// ============================================================

// --- Storage (JSON file) ---
const DATA_DIR  = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

function loadState() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const initial = { bets: [], results: null, status: 'open' };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveState(state) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // Atomic write: write to temp file then rename to avoid corruption
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// --- Pari-mutuel logic ---
function computeOdds(bets) {
  const winPool  = bets.filter(b => b.type === 'win').reduce((s, b) => s + b.amount, 0);
  const showPool = bets.filter(b => b.type === 'show').reduce((s, b) => s + b.amount, 0);

  const oddsMap = {};
  for (const { name } of ENTRANTS) {
    const winBets  = bets.filter(b => b.type === 'win'  && b.entrant === name).reduce((s, b) => s + b.amount, 0);
    const showBets = bets.filter(b => b.type === 'show' && b.entrant === name).reduce((s, b) => s + b.amount, 0);
    oddsMap[name] = {
      winBets,
      showBets,
      winPayout:  winBets  > 0 ? winPool  / winBets        : null,
      showPayout: showBets > 0 ? (showPool / 3) / showBets : null,
    };
  }
  return { winPool, showPool, oddsMap };
}

function computePayouts(bets, results) {
  if (!results || results.length < 3) return null;

  const [first, second, third] = results;
  const showPlaces = [first, second, third];

  const winPool  = bets.filter(b => b.type === 'win').reduce((s, b) => s + b.amount, 0);
  const showPool = bets.filter(b => b.type === 'show').reduce((s, b) => s + b.amount, 0);

  // --- Win pool ---
  const totalWinOnWinner = bets
    .filter(b => b.type === 'win' && b.entrant === first)
    .reduce((s, b) => s + b.amount, 0);
  // If nobody bet on the winner, refund all win bets.
  const winRefund = winPool > 0 && totalWinOnWinner === 0;

  // --- Show pool ---
  // Of the top-3 finishers, which ones actually received show bets?
  // Finishers with no show bets have their share redistributed to the covered places.
  const coveredShowPlaces = showPlaces.filter(entrant =>
    bets.some(b => b.type === 'show' && b.entrant === entrant)
  );
  // If none of the top-3 finishers received show bets, refund all show bets.
  const showRefund = showPool > 0 && coveredShowPlaces.length === 0;
  const showSharePerPlace = coveredShowPlaces.length > 0
    ? showPool / coveredShowPlaces.length
    : 0;

  return bets.map(bet => {
    let payout = 0;
    let refund  = false;

    if (bet.type === 'win') {
      if (winRefund) {
        // Nobody picked the winner — return everyone's stake
        payout = bet.amount;
        refund  = true;
      } else if (bet.entrant === first) {
        payout = (bet.amount / totalWinOnWinner) * winPool;
      }
    } else if (bet.type === 'show') {
      if (showRefund) {
        // None of top-3 were backed to show — return everyone's stake
        payout = bet.amount;
        refund  = true;
      } else if (coveredShowPlaces.includes(bet.entrant)) {
        const entrantShowTotal = bets
          .filter(b => b.type === 'show' && b.entrant === bet.entrant)
          .reduce((s, b) => s + b.amount, 0);
        payout = (bet.amount / entrantShowTotal) * showSharePerPlace;
      }
    }

    return { ...bet, payout: Math.round(payout * 100) / 100, refund };
  });
}

// --- Express ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
  const state = loadState();
  const { winPool, showPool, oddsMap } = computeOdds(state.bets);
  res.json({
    entrants: ENTRANTS,
    bets:     state.bets,
    status:   state.status,
    results:  state.results,
    winPool,
    showPool,
    oddsMap,
    payouts:  state.results ? computePayouts(state.bets, state.results) : null,
  });
});

app.post('/api/bet', (req, res) => {
  const state = loadState();
  if (state.status !== 'open') return res.status(400).json({ error: 'Betting is currently closed.' });

  let { bettor, entrant, type, amount } = req.body;

  if (!bettor?.trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!['win', 'show'].includes(type)) return res.status(400).json({ error: 'Invalid bet type.' });
  if (!ENTRANTS.find(e => e.name === entrant)) return res.status(400).json({ error: 'Invalid entrant.' });

  amount = parseFloat(amount);
  if (isNaN(amount) || amount < 1) return res.status(400).json({ error: 'Minimum bet is $1.' });

  const bet = {
    id:        crypto.randomUUID(),
    bettor:    bettor.trim(),
    entrant,
    type,
    amount,
    timestamp: new Date().toISOString(),
  };

  state.bets.push(bet);
  saveState(state);
  res.json({ success: true, bet });
});

app.post('/api/results', (req, res) => {
  const { first, second, third } = req.body;
  if (!first || !second || !third) return res.status(400).json({ error: 'Must provide 1st, 2nd, and 3rd place.' });
  if (new Set([first, second, third]).size !== 3) return res.status(400).json({ error: 'All 3 places must be different players.' });
  if (![first, second, third].every(n => ENTRANTS.find(e => e.name === n)))
    return res.status(400).json({ error: 'One or more player names not recognized.' });

  const state = loadState();
  state.results = [first, second, third];
  state.status  = 'final';
  saveState(state);
  res.json({ success: true });
});

app.post('/api/admin/status', (req, res) => {
  const { status } = req.body;
  if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const state = loadState();
  state.status = status;
  saveState(state);
  res.json({ success: true });
});

app.post('/api/admin/reset', (req, res) => {
  const state = loadState();
  state.bets    = [];
  state.results = null;
  state.status  = 'open';
  saveState(state);
  res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nGolf Betting App running at http://localhost:${PORT}\n`);
});
