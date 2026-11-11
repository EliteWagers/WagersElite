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
const send = (res, code, data, type='application/json; charset=utf-8') => { res.writeHead(code, {'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(type.startsWith('application/json') ? JSON.stringify(data) : data); };
async function jsonFetch(url, options={}) {
  const r = await fetch(url, { ...options, headers: { 'User-Agent':'EliteWagersResearch/3.0', ...(options.headers||{}) }, signal: AbortSignal.timeout(18000) });
  const raw = await r.text(); let data; try { data = JSON.parse(raw); } catch { data = { message: raw.slice(0,500) }; }
  if (!r.ok) throw new Error(data?.message || data?.error || `Upstream returned ${r.status}`);
  return data;
}
function flattenProps(events) {
  const rows=[];
  for (const ev of events) for (const book of ev.bookmakers||[]) for (const market of book.markets||[]) for (const outcome of market.outcomes||[]) {
    rows.push({ event: `${ev.away_team||''} @ ${ev.home_team||''}`, commence_time:ev.commence_time, bookmaker:book.title, market:market.key, player:outcome.description||outcome.player||'Unknown player', outcome:outcome.name, line:outcome.point??null, price:outcome.price??null, last_update:market.last_update||book.last_update||null });
  }
  return rows;
}
async function handle(req,res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method==='GET' && u.pathname==='/api/health') {
    return send(res,200,{ok:true,version:'3.0',providers:{theOddsApi:{enabled:!!process.env.THE_ODDS_API_KEY},openai:{enabled:!!process.env.OPENAI_API_KEY},espn:{enabled:true,unofficial:true}}});
  }
  if (req.method==='GET' && u.pathname==='/api/espn/scoreboard') {
    const league=(u.searchParams.get('league')||'nba').toLowerCase(), pair=leagueMap[league];
    if(!pair) return send(res,400,{error:'Unsupported ESPN league key'});
    const date=u.searchParams.get('date'); const key=`espn:${league}:${date||'today'}`; const hit=cacheGet(key,20000); if(hit) return send(res,200,{...hit,cached:true});
    const url=new URL(`https://site.api.espn.com/apis/site/v2/sports/${pair[0]}/${pair[1]}/scoreboard`); if(date && /^\d{8}$/.test(date))url.searchParams.set('dates',date);
    try { const d=await jsonFetch(url); const events=(d.events||[]).map(e=>({name:e.name,date:e.date,status:e.status?.type?.shortDetail||e.status?.type?.description||'Scheduled',competitions:(e.competitions||[]).map(c=>({venue:c.venue?.fullName,competitors:(c.competitors||[]).map(t=>({name:t.team?.displayName||t.team?.name||'Team',score:t.score,homeAway:t.homeAway})),odds:c.odds?.[0]?.details||null}))})); const out={events,provider:'ESPN public JSON (unofficial)',fetchedAt:new Date().toISOString()};cacheSet(key,out);return send(res,200,out); }
    catch(e){return send(res,502,{error:`ESPN feed unavailable: ${e.message}`});}
  }
  if (req.method==='GET' && u.pathname==='/api/espn/news') {
    const key='espn:news';const hit=cacheGet(key,60000);if(hit)return send(res,200,{...hit,cached:true});
    try {const d=await jsonFetch('https://site.api.espn.com/apis/site/v2/sports/news?limit=15');const articles=(d.articles||[]).map(a=>({headline:a.headline,description:a.description,published:a.published,link:a.links?.web?.href||a.links?.api?.news?.href||null}));const out={articles,provider:'ESPN public news (unofficial)',fetchedAt:new Date().toISOString()};cacheSet(key,out);return send(res,200,out)}catch(e){return send(res,502,{error:`ESPN news unavailable: ${e.message}`})}
  }
  if (req.method==='GET' && u.pathname==='/api/props') {
    const key=process.env.THE_ODDS_API_KEY;if(!key)return send(res,503,{error:'THE_ODDS_API_KEY is not configured. Add it to .env and restart the server.'});
    const sport=u.searchParams.get('sport')||'basketball_nba';if(!/^[a-z0-9_]+$/.test(sport))return send(res,400,{error:'Invalid sport key'});
    const marketParam=(u.searchParams.get('markets')||'').trim();
    const cacheKey=`oddsprops:${sport}:${marketParam}`;const hit=cacheGet(cacheKey,45000);if(hit)return send(res,200,{...hit,cached:true});
    try {
      const base=`https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sport)}`;
      const evs=await jsonFetch(`${base}/events?apiKey=${encodeURIComponent(key)}`);
      if(!Array.isArray(evs))throw new Error('Unexpected events response from provider');
      const selected=evs.slice(0,20);let scanned=0,all=[];const defaultMarkets={basketball_nba:'player_points,player_rebounds,player_assists,player_threes,player_blocks,player_steals,player_points_rebounds_assists',basketball_wnba:'player_points,player_rebounds,player_assists,player_threes',americanfootball_nfl:'player_pass_yds,player_pass_tds,player_rush_yds,player_receptions,player_reception_yds,player_anytime_td',baseball_mlb:'batter_hits,batter_total_bases,batter_rbis,batter_runs_scored,pitcher_strikeouts',icehockey_nhl:'player_points,player_goals,player_assists,player_shots_on_goal',soccer_usa_mls:'player_shots,player_shots_on_target,player_assists',soccer_epl:'player_shots,player_shots_on_target,player_assists'};const markets=(marketParam?marketParam.split(',').map(x=>x.trim()).filter(x=>/^[a-z0-9_]+$/.test(x)).join(','):(defaultMarkets[sport]||''));
      for(let i=0;i<selected.length;i+=4){const batch=selected.slice(i,i+4);const results=await Promise.all(batch.map(async ev=>{const url=new URL(`${base}/events/${encodeURIComponent(ev.id)}/odds`);url.searchParams.set('apiKey',key);url.searchParams.set('regions','us');url.searchParams.set('oddsFormat','american');if(markets)url.searchParams.set('markets',markets);try{return await jsonFetch(url)}catch(err){return {__error:err.message}}}));for(const r of results){scanned++;if(!r.__error)all.push(...flattenProps([r]));}}
      const out={props:all,eventsScanned:scanned,eventsAvailable:evs.length,provider:'The Odds API',fetchedAt:new Date().toISOString(),note:'Sportsbook prop lines are not PrizePicks projections. Coverage varies by sport, event, bookmaker and subscription.'};cacheSet(cacheKey,out);return send(res,200,out);
    } catch(e){return send(res,502,{error:`Player prop provider error: ${e.message}`})}
  }
  if(req.method==='POST' && u.pathname==='/api/ai/analyze'){
    if(!process.env.OPENAI_API_KEY)return send(res,503,{error:'OPENAI_API_KEY is not configured in .env.'});
    let body='';for await(const chunk of req){body+=chunk;if(body.length>60000)return send(res,413,{error:'Request too large'});}let parsed;try{parsed=JSON.parse(body)}catch{return send(res,400,{error:'Invalid JSON body'});}if(typeof parsed.prompt!=='string'||!parsed.prompt.trim())return send(res,400,{error:'A prompt is required'});
    try{const d=await jsonFetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Authorization':`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-6-luna',input:parsed.prompt})});let analysis=d.output_text||'';if(!analysis&&Array.isArray(d.output))analysis=d.output.flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('\n');return send(res,200,{analysis,model:d.model||process.env.OPENAI_MODEL||'gpt-6-luna',fetchedAt:new Date().toISOString()});}catch(e){return send(res,502,{error:`AI analysis failed: ${e.message}`})}
  }
  if(req.method==='GET' && (u.pathname==='/'||u.pathname==='/index.html')){const f=path.join(__dirname,'index.html');return send(res,200,fs.readFileSync(f,'utf8'),'text/html; charset=utf-8');}
  return send(res,404,{error:'Not found'});
}
const server=http.createServer((req,res)=>{handle(req,res).catch(e=>{console.error(e);if(!res.headersSent)send(res,500,{error:'Internal server error'})})});
server.listen(PORT,HOST,()=>console.log(`Elite Wagers running at http://${HOST}:${PORT}`));
