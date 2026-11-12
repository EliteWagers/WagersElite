// Elite Wagers local API gateway. Node 18+; no third-party dependencies.
// Provider credentials remain server-side.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

function loadEnv(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const cache = new Map();
const cacheGet = (key, ttl) => { const entry = cache.get(key); return entry && Date.now() - entry.at < ttl ? entry.value : null; };
const cacheSet = (key, value) => cache.set(key, { at: Date.now(), value });

const leagueMap = {
  nba:['basketball','nba','basketball_nba'], wnba:['basketball','wnba','basketball_wnba'],
  nfl:['football','nfl','americanfootball_nfl'], cfb:['football','college-football','americanfootball_ncaaf'],
  cbb:['basketball','mens-college-basketball','basketball_ncaab'], cbbw:['basketball','womens-college-basketball','basketball_wncaab'],
  mlb:['baseball','mlb','baseball_mlb'], nhl:['hockey','nhl','icehockey_nhl'],
  mls:['soccer','usa.1','soccer_usa_mls'], epl:['soccer','eng.1','soccer_epl'],
  laliga:['soccer','esp.1','soccer_spain_la_liga'], bundesliga:['soccer','ger.1','soccer_germany_bundesliga'],
  seriea:['soccer','ita.1','soccer_italy_serie_a'], ligue1:['soccer','fra.1','soccer_france_ligue_one'],
  ucl:['soccer','uefa.champions','soccer_uefa_champs_league'], atp:['tennis','atp','tennis_atp'],
  wta:['tennis','wta','tennis_wta'], golf:['golf','pga','golf_masters_tournament'], ufc:['mma','ufc','mma_mixed_martial_arts'], f1:['racing','f1','']
};

const send = (res, code, data, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, {'Content-Type':type, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
};
async function jsonFetch(url, options = {}) {
  const response = await fetch(url, { ...options, headers: {'User-Agent':'EliteWagersResearch/3.1', ...(options.headers || {})}, signal:AbortSignal.timeout(18000) });
  const raw = await response.text();
  let data; try { data = JSON.parse(raw); } catch { data = {message:raw.slice(0,500)}; }
  if (!response.ok) throw new Error(data?.message || data?.error || `Upstream returned ${response.status}`);
  return data;
}
function americanProbability(odds) {
  const value = Number(odds);
  if (!Number.isFinite(value) || value === 0) return null;
  return value < 0 ? -value / (-value + 100) : 100 / (value + 100);
}
function normalizedTeam(name) { return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle-1] + sorted[middle]) / 2;
}

// Returns consensus no-vig win probabilities and best-price edge by event.
// Edge is best-book implied probability minus consensus fair probability; it is not a model edge.
async function getMoneylineEstimates(league) {
  const key = process.env.THE_ODDS_API_KEY;
  const mapping = leagueMap[league];
  if (!key || !mapping?.[2]) return new Map();
  const cacheKey = `moneyline:${league}`;
  const cached = cacheGet(cacheKey, 45000);
  if (cached) return cached;
  const url = new URL(`https://api.the-odds-api.com/v4/sports/${encodeURIComponent(mapping[2])}/odds`);
  url.searchParams.set('apiKey', key);
  url.searchParams.set('regions', 'us');
  url.searchParams.set('markets', 'h2h');
  url.searchParams.set('oddsFormat', 'american');
  const events = await jsonFetch(url);
  const estimates = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const home = event.home_team;
    const away = event.away_team;
    const homeFair = [];
    const awayFair = [];
    const homePrices = [];
    const awayPrices = [];
    for (const book of event.bookmakers || []) {
      const market = (book.markets || []).find(item => item.key === 'h2h');
      const homeOutcome = market?.outcomes?.find(item => item.name === home);
      const awayOutcome = market?.outcomes?.find(item => item.name === away);
      if (!homeOutcome || !awayOutcome) continue;
      const hp = americanProbability(homeOutcome.price);
      const ap = americanProbability(awayOutcome.price);
      if (hp === null || ap === null || hp + ap === 0) continue;
      homeFair.push(hp / (hp + ap));
      awayFair.push(ap / (hp + ap));
      homePrices.push({price:Number(homeOutcome.price), book:book.title || 'Sportsbook'});
      awayPrices.push({price:Number(awayOutcome.price), book:book.title || 'Sportsbook'});
    }
    const homeProbability = median(homeFair);
    const awayProbability = median(awayFair);
    if (homeProbability === null || awayProbability === null) continue;
    const bestHome = homePrices.sort((a,b) => americanProbability(b.price) - americanProbability(a.price))[0];
    const bestAway = awayPrices.sort((a,b) => americanProbability(b.price) - americanProbability(a.price))[0];
    estimates.set(`${normalizedTeam(home)}|${normalizedTeam(away)}`, {
      homeWinProbability:homeProbability,
      awayWinProbability:awayProbability,
      homeBestOdds:bestHome?.price ?? null,
      awayBestOdds:bestAway?.price ?? null,
      homeBestBook:bestHome?.book || null,
      awayBestBook:bestAway?.book || null,
      homePriceEdge:bestHome ? americanProbability(bestHome.price) - homeProbability : null,
      awayPriceEdge:bestAway ? americanProbability(bestAway.price) - awayProbability : null,
      probabilitySource:'The Odds API consensus no-vig moneyline',
      edgeDefinition:'Best-book implied probability minus consensus no-vig probability; not a prediction-model edge.'
    });
  }
  cacheSet(cacheKey, estimates);
  return estimates;
}

function flattenProps(events) {
  const rows=[];
  for (const event of events || []) for (const book of event.bookmakers || []) for (const market of book.markets || []) for (const outcome of market.outcomes || []) {
    rows.push({event:`${event.away_team || ''} @ ${event.home_team || ''}`, commence_time:event.commence_time, bookmaker:book.title, market:market.key, player:outcome.description || outcome.player || 'Unknown player', price:outcome.price, point:outcome.point || null});
  }
  return rows;
}

async function handle(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && u.pathname === '/api/health') {
    return send(res,200,{ok:true,version:'3.2.0',providers:{theOddsApi:{enabled:!!process.env.THE_ODDS_API_KEY},openai:{enabled:!!process.env.OPENAI_API_KEY},espn:{enabled:true,unofficial:true}}});
  }

  if (req.method === 'GET' && u.pathname === '/api/espn/scoreboard') {
    const league = (u.searchParams.get('league') || 'nba').toLowerCase();
    const mapping = leagueMap[league];
    if (!mapping) return send(res,400,{error:'Unsupported ESPN league key'});
    const date = u.searchParams.get('date');
    const cacheKey = `espn:${league}:${date || 'today'}`;
    const hit = cacheGet(cacheKey,20000);
    if (hit) return send(res,200,{...hit,cached:true});
    const url = new URL(`https://site.api.espn.com/apis/site/v2/sports/${mapping[0]}/${mapping[1]}/scoreboard`);
    if (date && /^\d{8}$/.test(date)) url.searchParams.set('dates',date);
    try {
      const [data, estimates] = await Promise.all([jsonFetch(url), getMoneylineEstimates(league).catch(() => new Map())]);
      const events = (data.events || []).map(event => ({
        name:event.name,
        date:event.date,
        status:event.status?.type?.shortDetail || event.status?.type?.description || 'Scheduled',
        competitions:(event.competitions || []).map(competition => {
          const home = competition.competitors?.find(team => team.homeAway === 'home');
          const away = competition.competitors?.find(team => team.homeAway === 'away');
          const homeName = home?.team?.displayName || home?.team?.name || 'Home';
          const awayName = away?.team?.displayName || away?.team?.name || 'Away';
          const estimate = estimates.get(`${normalizedTeam(homeName)}|${normalizedTeam(awayName)}`)
            || [...estimates.entries()].find(([key]) => key === `${normalizedTeam(homeName)}|${normalizedTeam(awayName)}`)?.[1];
          return {
            home:homeName, away:awayName,
            homeScore:home?.score ?? '', awayScore:away?.score ?? '',
            venue:competition.venue?.fullName || '',
            status:competition.status?.type?.detail || competition.status?.type?.shortDetail || 'Scheduled',
            ...(estimate || {})
          };
        })
      }));
      const out={league,events,fetchedAt:new Date().toISOString(),probabilityNote:process.env.THE_ODDS_API_KEY ? 'Win probabilities are consensus no-vig market estimates. Price edge compares the best available price to that consensus; neither is a guaranteed prediction.' : 'Add THE_ODDS_API_KEY to show market-based win probabilities.'};
      cacheSet(cacheKey,out);
      return send(res,200,out);
    } catch (error) { return send(res,502,{error:`ESPN feed unavailable: ${error.message}`}); }
  }

  if (req.method === 'GET' && u.pathname === '/api/espn/news') {
    const key='espn:news'; const hit=cacheGet(key,60000);
    if (hit) return send(res,200,{...hit,cached:true});
    try {
      const data=await jsonFetch('https://site.api.espn.com/apis/site/v2/sports/news?limit=15');
      const articles=(data.articles || []).map(article=>({headline:article.headline,description:article.description,published:article.published,url:article.links?.web?.href || article.link || ''}));
      const out={articles,fetchedAt:new Date().toISOString()}; cacheSet(key,out); return send(res,200,out);
    } catch(error) { return send(res,502,{error:`ESPN news unavailable: ${error.message}`}); }
  }

  if (req.method === 'GET' && u.pathname === '/api/props') {
    const key=process.env.THE_ODDS_API_KEY;
    if (!key) return send(res,503,{error:'THE_ODDS_API_KEY is not configured. Add it to .env and restart the server.'});
    const sport=u.searchParams.get('sport') || 'basketball_nba';
    if (!/^[a-z0-9_]+$/.test(sport)) return send(res,400,{error:'Invalid sport key'});
    const markets=(u.searchParams.get('markets') || 'player_points,player_rebounds,player_assists').trim();
    const cacheKey=`oddsprops:${sport}:${markets}`; const hit=cacheGet(cacheKey,45000);
    if (hit) return send(res,200,{...hit,cached:true});
    try {
      const base=`https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sport)}`;
      const events=await jsonFetch(`${base}/events?apiKey=${encodeURIComponent(key)}`);
      if (!Array.isArray(events)) throw new Error('Unexpected events response from provider');
      const rows=[];
      for (let i=0;i<Math.min(events.length,12);i+=4) {
        const batch=events.slice(i,i+4);
        const responses=await Promise.all(batch.map(event=>{
          const oddsUrl=new URL(`${base}/events/${encodeURIComponent(event.id)}/odds`);
          oddsUrl.searchParams.set('apiKey',key); oddsUrl.searchParams.set('regions','us'); oddsUrl.searchParams.set('markets',markets);
          return jsonFetch(oddsUrl);
        }));
        responses.forEach(response=>rows.push(...flattenProps([response])));
      }
      const out={props:rows,eventsScanned:Math.min(events.length,12),eventsAvailable:events.length,provider:'The Odds API',fetchedAt:new Date().toISOString(),note:'Sportsbook prop lines are not PrizePicks projections.'};
      cacheSet(cacheKey,out); return send(res,200,out);
    } catch(error) { return send(res,502,{error:`Player prop provider error: ${error.message}`}); }
  }

  if (req.method === 'GET' && u.pathname === '/api/market/board') {
    return send(res,503,{error:'Opportunity projections are not configured. Use the live scoreboard for market-implied win probabilities and best-price edges.'});
  }

  if (req.method === 'POST' && u.pathname === '/api/ai/analyze') {
    if (!process.env.OPENAI_API_KEY) return send(res,503,{error:'OPENAI_API_KEY is not configured in .env.'});
    let body=''; for await (const chunk of req) { body+=chunk; if (body.length>60000) return send(res,413,{error:'Request too large'}); }
    let parsed; try { parsed=JSON.parse(body); } catch { return send(res,400,{error:'Invalid JSON body.'}); }
    try {
      const data=await jsonFetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o-mini',input:`Carefully analyze the supplied sports research data. Do not invent current facts, guarantee outcomes, or claim a bet is a lock. Explain uncertainty and missing context.\n\n${JSON.stringify(parsed,null,2)}`})});
      return send(res,200,{analysis:data.output_text || data.answer || JSON.stringify(data)});
    } catch(error) { return send(res,502,{error:`OpenAI analysis failed: ${error.message}`}); }
  }

  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    return send(res,200,fs.readFileSync(path.join(__dirname,'index.html'),'utf8'),'text/html; charset=utf-8');
  }
  return send(res,404,{error:'Not found'});
}

const server=http.createServer((req,res)=>{handle(req,res).catch(error=>{console.error(error);if(!res.headersSent)send(res,500,{error:'Internal server error'});});});
server.listen(PORT,HOST,()=>console.log(`Elite Wagers running at http://${HOST}:${PORT}`));
