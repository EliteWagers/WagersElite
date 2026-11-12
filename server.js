// Elite Wagers local API gateway. Node 18+; no third-party dependencies.
// Secrets remain server-side in .env and are never sent to the browser.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

function loadEnv(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const cache = new Map();
const cacheGet = (k, ttl) => { const x = cache.get(k); return x && Date.now() - x.at < ttl ? x.value : null; };
const cacheSet = (k, value) => cache.set(k, { at: Date.now(), value });

const leagueMap = {
  nba:['basketball','nba'], wnba:['basketball','wnba'], nfl:['football','nfl'], cfb:['football','college-football'],
  cbb:['basketball','mens-college-basketball'], cbbw:['basketball','womens-college-basketball'], mlb:['baseball','mlb'], nhl:['hockey','nhl'],
  mls:['soccer','usa.1'], epl:['soccer','eng.1'], laliga:['soccer','esp.1'], bundesliga:['soccer','ger.1'], seriea:['soccer','ita.1'],
  ligue1:['soccer','fra.1'], ucl:['soccer','uefa.champions'], atp:['tennis','atp'], wta:['tennis','wta'], golf:['golf','pga'], ufc:['mma','ufc'], f1:['racing','f1']
};

const oddsApiSportMap = {
  nba: 'basketball_nba',
  wnba: 'basketball_wnba',
  nfl: 'americanfootball_nfl',
  mlb: 'baseball_mlb',
  nhl: 'icehockey_nhl',
  mls: 'soccer_usa_mls',
  epl: 'soccer_epl',
  cbb: 'basketball_ncaab',
  cfb: 'americanfootball_ncaaf',
  atp: 'tennis_atp',
  wta: 'tennis_wta'
};

const demoBoards = {
  nba: {
    source: 'demo-data',
    moneylines: [
      {team:'Boston Celtics', opponent:'New York Knicks', odds:-130, fairProbability:0.564, modelProbability:0.56, edge:0.004, confidence:'moderate'},
      {team:'Dallas Mavericks', opponent:'Denver Nuggets', odds:+120, fairProbability:0.446, modelProbability:0.42, edge:0.026, confidence:'strong'},
      {team:'Minnesota Timberwolves', opponent:'Miami Heat', odds:-110, fairProbability:0.52, modelProbability:0.49, edge:0.03, confidence:'strong'}
    ],
    props: [
      {player:'Jalen Brunson', team:'New York Knicks', prop:'Points', line:27.5, odds:-110, projected:29.1, modelProbability:0.56, edge:0.06, confidence:'strong'},
      {player:'Anthony Edwards', team:'Minnesota Timberwolves', prop:'Points', line:26.5, odds:-105, projected:28.2, modelProbability:0.58, edge:0.08, confidence:'strong'},
      {player:'Jayson Tatum', team:'Boston Celtics', prop:'Points', line:30.5, odds:-115, projected:31.2, modelProbability:0.52, edge:0.02, confidence:'moderate'}
    ]
  },
  nfl: {
    source: 'demo-data',
    moneylines: [
      {team:'Kansas City Chiefs', opponent:'Baltimore Ravens', odds:-110, fairProbability:0.523, modelProbability:0.51, edge:0.013, confidence:'moderate'},
      {team:'Philadelphia Eagles', opponent:'Washington Commanders', odds:+105, fairProbability:0.486, modelProbability:0.45, edge:0.036, confidence:'strong'},
      {team:'Green Bay Packers', opponent:'Chicago Bears', odds:-125, fairProbability:0.555, modelProbability:0.54, edge:0.015, confidence:'moderate'}
    ],
    props: [
      {player:'Patrick Mahomes', team:'Kansas City Chiefs', prop:'Passing yards', line:285.5, odds:-110, projected:292, modelProbability:0.53, edge:0.03, confidence:'moderate'},
      {player:'Saquon Barkley', team:'Philadelphia Eagles', prop:'Rushing yards', line:92.5, odds:-110, projected:101, modelProbability:0.57, edge:0.07, confidence:'strong'},
      {player:'Amon-Ra St. Brown', team:'Detroit Lions', prop:'Receiving yards', line:78.5, odds:-105, projected:84, modelProbability:0.54, edge:0.04, confidence:'moderate'}
    ]
  },
  mlb: {
    source: 'demo-data',
    moneylines: [
      {team:'Los Angeles Dodgers', opponent:'San Francisco Giants', odds:-135, fairProbability:0.577, modelProbability:0.55, edge:0.027, confidence:'moderate'},
      {team:'Atlanta Braves', opponent:'New York Mets', odds:+115, fairProbability:0.468, modelProbability:0.43, edge:0.038, confidence:'strong'},
      {team:'Houston Astros', opponent:'Texas Rangers', odds:-105, fairProbability:0.512, modelProbability:0.49, edge:0.022, confidence:'moderate'}
    ],
    props: [
      {player:'Shohei Ohtani', team:'Los Angeles Dodgers', prop:'Hits', line:1.5, odds:-120, projected:1.8, modelProbability:0.55, edge:0.05, confidence:'strong'},
      {player:'Mookie Betts', team:'Los Angeles Dodgers', prop:'Total bases', line:1.5, odds:-105, projected:1.9, modelProbability:0.53, edge:0.03, confidence:'moderate'},
      {player:'Kyle Tucker', team:'Chicago Cubs', prop:'Hits', line:1.5, odds:+100, projected:1.7, modelProbability:0.52, edge:0.02, confidence:'moderate'}
    ]
  }
};

function americanToProbability(americanOdds) {
  const o = Number(americanOdds);
  if (!Number.isFinite(o) || o === 0) return 0;
  return o > 0 ? 100 / (o + 100) : (-o) / ((-o) + 100);
}

function probabilityFromOdds(odds) {
  if (!Array.isArray(odds) || odds.length < 2) return 0;
  const p1 = americanToProbability(odds[0]);
  const p2 = americanToProbability(odds[1]);
  return (p1 / (p1 + p2)) || 0;
}

function computeNoVigOdds(oddsA, oddsB) {
  const a = americanToProbability(oddsA);
  const b = americanToProbability(oddsB);
  const total = a + b;
  if (!total) return { fairA: 0, fairB: 0 };
  return { fairA: a / total, fairB: b / total };
}

function moneylineFromOdds(oddsA, oddsB) {
  const { fairA, fairB } = computeNoVigOdds(oddsA, oddsB);
  return {
    fairProbability: fairA,
    fairProbabilityOther: fairB,
    impliedA: americanToProbability(oddsA),
    impliedB: americanToProbability(oddsB)
  };
}

function buildDemoBoard(sport = 'nba') {
  const board = demoBoards[sport] || demoBoards.nba;
  const moneylines = (board.moneylines || []).map((m) => ({
    ...m,
    type: 'moneyline',
    market: `${m.team} vs ${m.opponent}`,
    fairProbability: Number(m.fairProbability || 0.5),
    edge: Number(m.edge || 0),
    implied: americanToProbability(m.odds)
  }));

  const props = (board.props || []).map((p) => ({
    ...p,
    type: 'player-prop',
    market: `${p.prop} ${p.line}`,
    edge: Number(p.edge || 0),
    implied: americanToProbability(p.odds),
    fairProbability: Number(p.modelProbability || 0.5)
  }));

  return { sport, source: board.source || 'demo-data', moneylines, props, generatedAt: new Date().toISOString() };
}

async function fetchOddsApiBoard(sport = 'nba') {
  const key = process.env.THE_ODDS_API_KEY;
  if (!key) return null;
  const sportsKey = oddsApiSportMap[sport] || oddsApiSportMap.nba;
  const url = `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sportsKey)}/events?apiKey=${encodeURIComponent(key)}&daysFrom=1`;
  const events = await jsonFetch(url);
  const items = Array.isArray(events) ? events.slice(0, 10) : [];
  const moneylines = [];
  const props = [];

  for (const event of items) {
    const home = event.home_team || 'Home';
    const away = event.away_team || 'Away';
    const oddsUrl = `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sportsKey)}/events/${encodeURIComponent(event.id)}/odds?apiKey=${encodeURIComponent(key)}&regions=us&markets=h2h,player_props`;
    const oddsData = await jsonFetch(oddsUrl);
    const books = Array.isArray(oddsData) ? oddsData : [];
    const book = books.find((b) => Array.isArray(b.bookmakers) && b.bookmakers.length) || {};
    const bookmakers = book.bookmakers || [];

    for (const bookmaker of bookmakers) {
      const h2h = (bookmaker.markets || []).find((m) => m.key === 'h2h');
      if (h2h && h2h.outcomes?.length >= 2) {
        const awayOutcome = h2h.outcomes.find((o) => o.name === away) || h2h.outcomes[0];
        const homeOutcome = h2h.outcomes.find((o) => o.name === home) || h2h.outcomes[1] || h2h.outcomes[0];
        const oddsA = Number(awayOutcome?.price || 0);
        const oddsB = Number(homeOutcome?.price || 0);
        const probabilities = moneylineFromOdds(oddsA, oddsB);
        moneylines.push({
          team: away,
          opponent: home,
          odds: oddsA,
          fairProbability: probabilities.fairProbability,
          modelProbability: 0.5,
          edge: 0,
          confidence: 'live',
          source: bookmaker.title || 'The Odds API'
        });
        moneylines.push({
          team: home,
          opponent: away,
          odds: oddsB,
          fairProbability: probabilities.fairProbabilityOther,
          modelProbability: 0.5,
          edge: 0,
          confidence: 'live',
          source: bookmaker.title || 'The Odds API'
        });
      }

      const playerMarket = (bookmaker.markets || []).find((m) => ['player_points', 'player_rebounds', 'player_assists', 'player_rush_yds', 'player_pass_yds', 'player_rec_yds', 'player_hits', 'player_total_bases'].includes(m.key));
      if (playerMarket && Array.isArray(playerMarket.outcomes)) {
        for (const outcome of playerMarket.outcomes.slice(0, 3)) {
          const propName = playerMarket.key.replace(/player_|_/g, ' ');
          props.push({
            player: outcome.description || outcome.name || 'Player',
            team: outcome.team || 'Unknown',
            prop: propName,
            line: Number(outcome.point || 0),
            odds: Number(outcome.price || -110),
            projected: Number(outcome.point || 0),
            modelProbability: 0.5,
            edge: 0,
            confidence: 'live',
            source: bookmaker.title || 'The Odds API'
          });
        }
      }
    }
  }

  return { sport, source: 'the-odds-api', moneylines: moneylines.slice(0, 20), props: props.slice(0, 20), generatedAt: new Date().toISOString() };
}

const send = (res, code, data, type='application/json; charset=utf-8') => {
  res.writeHead(code, {'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
};

async function jsonFetch(url, options = {}) {
  const r = await fetch(url, { ...options, headers: { 'User-Agent': 'EliteWagersResearch/3.0', ...(options.headers || {}) }, signal: AbortSignal.timeout(18000) });
  const raw = await r.text();
  let data; try { data = JSON.parse(raw); } catch { data = { message: raw.slice(0, 500) }; }
  if (!r.ok) throw new Error(data?.message || data?.error || `Upstream returned ${r.status}`);
  return data;
}

function flattenProps(events) {
  const rows = [];
  for (const ev of events) {
    for (const book of ev.bookmakers || []) {
      for (const market of book.markets || []) {
        for (const outcome of market.outcomes || []) {
          rows.push({ event: `${ev.away_team || ''} @ ${ev.home_team || ''}`, commence_time: ev.commence_time, bookmaker: book.title, market: market.key, player: outcome.description || outcome.player || 'Unknown player', price: outcome.price, point: outcome.point || null });
        }
      }
    }
  }
  return rows;
}

async function handle(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && u.pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      version: '3.1.0',
      providers: {
        theOddsApi: { enabled: !!process.env.THE_ODDS_API_KEY },
        openai: { enabled: !!process.env.OPENAI_API_KEY },
        espn: { enabled: true, unofficial: true },
        marketBoard: { enabled: true }
      }
    });
  }

  if (req.method === 'GET' && u.pathname === '/api/espn/scoreboard') {
    const league = (u.searchParams.get('league') || 'nba').toLowerCase();
    const pair = leagueMap[league];
    if (!pair) return send(res, 400, { error: 'Unsupported ESPN league key' });
    const date = u.searchParams.get('date');
    const key = `espn:${league}:${date || 'today'}`;
    const hit = cacheGet(key, 20000);
    if (hit) return send(res, 200, { ...hit, cached: true });

    const url = new URL(`https://site.api.espn.com/apis/site/v2/sports/${pair[0]}/${pair[1]}/scoreboard`);
    if (date && /^\d{8}$/.test(date)) url.searchParams.set('dates', date);

    try {
      const d = await jsonFetch(url);
      const events = (d.events || []).map((e) => ({
        name: e.name,
        date: e.date,
        status: e.status?.type?.shortDetail || e.status?.type?.description || 'Scheduled',
        competitions: (e.competitions || []).map((c) => ({
          home: c.homeTeam?.team?.displayName || 'Home',
          away: c.awayTeam?.team?.displayName || 'Away',
          homeScore: c.score?.home ?? '',
          awayScore: c.score?.away ?? '',
          venue: c.venue?.fullName || '',
          status: c.status?.type?.detail || c.status?.type?.shortDetail || 'Scheduled'
        }))
      }));
      const out = { league, events, fetchedAt: new Date().toISOString() };
      cacheSet(key, out);
      return send(res, 200, out);
    } catch (e) {
      return send(res, 502, { error: `ESPN feed unavailable: ${e.message}` });
    }
  }

  if (req.method === 'GET' && u.pathname === '/api/espn/news') {
    const key = 'espn:news';
    const hit = cacheGet(key, 60000);
    if (hit) return send(res, 200, { ...hit, cached: true });
    try {
      const d = await jsonFetch('https://site.api.espn.com/apis/site/v2/sports/news?limit=15');
      const articles = (d.articles || []).map((a) => ({
        headline: a.headline,
        description: a.description,
        published: a.published,
        url: a.links?.web?.href || a.link || ''
      }));
      const out = { articles, fetchedAt: new Date().toISOString() };
      cacheSet(key, out);
      return send(res, 200, out);
    } catch (e) {
      return send(res, 502, { error: `ESPN news unavailable: ${e.message}` });
    }
  }

  if (req.method === 'GET' && u.pathname === '/api/props') {
    const key = process.env.THE_ODDS_API_KEY;
    if (!key) return send(res, 503, { error: 'THE_ODDS_API_KEY is not configured. Add it to .env and restart the server.' });
    const sport = u.searchParams.get('sport') || 'basketball_nba';
    if (!/^[a-z0-9_]+$/.test(sport)) return send(res, 400, { error: 'Invalid sport key' });
    const marketParam = (u.searchParams.get('markets') || '').trim();
    const cacheKey = `oddsprops:${sport}:${marketParam}`;
    const hit = cacheGet(cacheKey, 45000);
    if (hit) return send(res, 200, { ...hit, cached: true });

    try {
      const base = `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sport)}`;
      const evs = await jsonFetch(`${base}/events?apiKey=${encodeURIComponent(key)}`);
      if (!Array.isArray(evs)) throw new Error('Unexpected events response from provider');
      const selected = evs.slice(0, 20);
      let scanned = 0;
      const all = [];
      const defaultMarkets = {
        basketball_nba: 'player_points,player_rebounds,player_assists,player_threes,player_blocks,player_steals,player_points_rebounds_assists',
        americanfootball_nfl: 'player_pass_yds,player_rush_yds,player_rec_yds,player_pass_tds',
        baseball_mlb: 'player_hits,player_total_bases,player_rbi',
        icehockey_nhl: 'player_points,player_goals',
        soccer_epl: 'player_goals,player_assists'
      };
      const markets = (marketParam || defaultMarkets[sport] || 'player_points').split(',').filter(Boolean);

      for (let i = 0; i < selected.length; i += 4) {
        const batch = selected.slice(i, i + 4);
        const results = await Promise.all(batch.map(async (ev) => {
          const oddsUrl = new URL(`${base}/events/${encodeURIComponent(ev.id)}/odds`);
          oddsUrl.searchParams.set('apiKey', key);
          oddsUrl.searchParams.set('regions', 'us');
          oddsUrl.searchParams.set('markets', markets.join(','));
          return await jsonFetch(oddsUrl);
        }));
        for (const resp of results) {
          const rows = flattenProps(resp || []);
          all.push(...rows);
          scanned += 1;
        }
      }

      const out = {
        props: all,
        eventsScanned: scanned,
        eventsAvailable: evs.length,
        provider: 'The Odds API',
        fetchedAt: new Date().toISOString(),
        note: 'Sportsbook prop lines are not PrizePicks projections. Compare them with your own model and lineups.'
      };
      cacheSet(cacheKey, out);
      return send(res, 200, out);
    } catch (e) {
      return send(res, 502, { error: `Player prop provider error: ${e.message}` });
    }
  }

  if (req.method === 'GET' && u.pathname === '/api/market/board') {
    const sport = (u.searchParams.get('sport') || 'nba').toLowerCase();
    const market = (u.searchParams.get('market') || 'all').toLowerCase();
    const fallback = buildDemoBoard(sport);
    const live = await fetchOddsApiBoard(sport).catch(() => null);
    const board = live || fallback;
    const filtered = {
      ...board,
      generatedAt: new Date().toISOString(),
      moneylines: board.moneylines || [],
      props: board.props || []
    };

    if (market === 'moneyline') filtered.props = [];
    if (market === 'player-prop' || market === 'props') filtered.moneylines = [];

    return send(res, 200, filtered);
  }

  if (req.method === 'POST' && u.pathname === '/api/ai/analyze') {
    if (!process.env.OPENAI_API_KEY) return send(res, 503, { error: 'OPENAI_API_KEY is not configured in .env.' });
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 60000) return send(res, 413, { error: 'Request too large' });
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch { return send(res, 400, { error: 'Invalid JSON body.' }); }

    try {
      const d = await jsonFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          input: `You are a sports betting research analyst. Review this data and explain the probability edge, risk, missing context, and actionability. \n\n${JSON.stringify(parsed, null, 2)}`
        })
      });
      return send(res, 200, { analysis: d.output_text || d.answer || JSON.stringify(d) });
    } catch (e) {
      return send(res, 502, { error: `OpenAI analysis failed: ${e.message}` });
    }
  }

  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    const f = path.join(__dirname, 'index.html');
    return send(res, 200, fs.readFileSync(f, 'utf8'), 'text/html; charset=utf-8');
  }

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Internal server error' });
  });
});

server.listen(PORT, HOST, () => console.log(`Elite Wagers running at http://${HOST}:${PORT}`));
