// Elite Wagers local API gateway. Node 18+; no third-party dependencies.
// Keep provider credentials on the server in environment variables or .env.
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

const leagues = {
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
const send = (res, code, data, type='application/json; charset=utf-8') => {
  res.writeHead(code, {'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
};
async function jsonFetch(url, options={}) {
  const response = await fetch(url, {...options, headers:{'User-Agent':'EliteWagersResearch/3.3',...(options.headers||{})}, signal:AbortSignal.timeout(18000)});
  const raw = await response.text();
  let data; try { data=JSON.parse(raw); } catch { data={message:raw.slice(0,500)}; }
  if (!response.ok) throw new Error(data?.message || data?.error || `Upstream returned ${response.status}`);
  return data;
}
function americanProbability(odds) {
  const value=Number(odds);
  if (!Number.isFinite(value) || value===0) return null;
  return value<0 ? -value/(-value+100) : 100/(value+100);
}
function normalizeTeam(value) { return String(value||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function median(values) {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if (!sorted.length) return null;
  const middle=Math.floor(sorted.length/2);
  return sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;
}
function eventTeamMatch(a,b) {
  const x=normalizeTeam(a), y=normalizeTeam(b);
  return x===y || (x.length>5 && y.length>5 && (x.includes(y)||y.includes(x)));
}

async function getMoneylines(league) {
  const key=process.env.THE_ODDS_API_KEY, mapping=leagues[league];
  if (!key || !mapping?.[2]) return new Map();
  const cacheKey=`moneylines:${league}`, cached=cacheGet(cacheKey,45000);
  if (cached) return cached;
  const url=new URL(`https://api.the-odds-api.com/v4/sports/${encodeURIComponent(mapping[2])}/odds`);
  url.searchParams.set('apiKey',key); url.searchParams.set('regions','us'); url.searchParams.set('markets','h2h'); url.searchParams.set('oddsFormat','american');
  const events=await jsonFetch(url), map=new Map();
  for (const event of Array.isArray(events)?events:[]) {
    const homeFair=[],awayFair=[],homePrices=[],awayPrices=[];
    for (const book of event.bookmakers||[]) {
      const market=(book.markets||[]).find(item=>item.key==='h2h');
      const home=market?.outcomes?.find(item=>item.name===event.home_team), away=market?.outcomes?.find(item=>item.name===event.away_team);
      if (!home||!away) continue;
      const hp=americanProbability(home.price), ap=americanProbability(away.price);
      if (hp===null||ap===null||hp+ap===0) continue;
      homeFair.push(hp/(hp+ap)); awayFair.push(ap/(hp+ap));
      homePrices.push({price:Number(home.price),book:book.title||'Sportsbook'});
      awayPrices.push({price:Number(away.price),book:book.title||'Sportsbook'});
    }
    const homeProbability=median(homeFair), awayProbability=median(awayFair);
    if (homeProbability===null||awayProbability===null) continue;
    // Best price is the price with the lowest break-even probability (best payout).
    const bestHome=homePrices.sort((a,b)=>americanProbability(a.price)-americanProbability(b.price))[0];
    const bestAway=awayPrices.sort((a,b)=>americanProbability(a.price)-americanProbability(b.price))[0];
    map.set(`${normalizeTeam(event.home_team)}|${normalizeTeam(event.away_team)}`,{
      homeWinProbability:homeProbability,awayWinProbability:awayProbability,
      homeBestOdds:bestHome?.price??null,awayBestOdds:bestAway?.price??null,
      homeBestBook:bestHome?.book||null,awayBestBook:bestAway?.book||null,
      homePriceEdge:bestHome?homeProbability-americanProbability(bestHome.price):null,
      awayPriceEdge:bestAway?awayProbability-americanProbability(bestAway.price):null,
      probabilitySource:'Consensus no-vig market odds'
    });
  }
  cacheSet(cacheKey,map); return map;
}
function flattenProps(events) {
  const rows=[];
  for (const event of events||[]) for (const book of event.bookmakers||[]) for (const market of book.markets||[]) for (const outcome of market.outcomes||[]) {
    rows.push({event:`${event.away_team||''} @ ${event.home_team||''}`,commence_time:event.commence_time,bookmaker:book.title,market:market.key,player:outcome.description||outcome.player||'Unknown player',price:outcome.price,point:outcome.point??null});
  }
  return rows;
}

const SCORES_UI = `<style>
#live .score-app{--score-bg:#080d20;--score-card:#111a33;--score-line:#26314f;--score-muted:#9aafd0;--score-cyan:#32e7ed;background:var(--score-bg);border-radius:24px;padding:clamp(16px,3vw,30px);margin-top:12px;color:#f5f7ff}
.score-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.score-head h2{font-size:clamp(2rem,5vw,3rem);margin:0}.score-brand{display:flex;align-items:center;gap:13px}.score-logo{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;background:#ff741f;font-weight:900;font-size:23px}.score-sports{display:flex;gap:9px;overflow-x:auto;padding:16px 0;scrollbar-width:thin}.score-sport{white-space:nowrap;border:0;border-radius:28px;background:#171f3b;color:#eaf1ff;padding:11px 18px;font:700 15px inherit;cursor:pointer}.score-sport.active{background:#f6f8ff;color:#081025}.score-dates{display:flex;gap:18px;overflow-x:auto;padding:8px 0 20px;color:var(--score-muted)}.score-date{background:none;border:0;color:inherit;white-space:nowrap;cursor:pointer;font:inherit}.score-date.active{color:var(--score-cyan);font-weight:800}.score-date small{display:block}.score-section-title{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:12px 0}.score-section-title h3{margin:0;font-size:1.55rem}.score-section-title a{color:var(--score-cyan);text-decoration:none;font-weight:700}.score-game{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(270px,1fr);gap:14px;padding:16px 0;border-bottom:1px solid var(--score-line)}.score-match{display:grid;grid-template-columns:1fr auto;gap:8px 12px;align-content:center}.score-team{font-size:1.1rem}.score-team .record{color:var(--score-muted);font-size:.9rem;margin-left:8px}.score-team.winner{color:var(--score-cyan)}.score-info{border-left:1px solid var(--score-line);padding:3px 0 3px 16px;color:var(--score-muted);display:flex;flex-direction:column;justify-content:space-between}.score-probs{display:grid;grid-template-columns:1fr 1fr;gap:9px}.score-prob{padding:10px;border-radius:12px;background:var(--score-card);border:1px solid var(--score-line)}.score-prob b{font-size:1.2rem;display:block}.score-prob small{color:var(--score-muted)}.score-data-note{color:var(--score-muted);font-size:12px;margin:8px 0 16px}.score-lower{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:24px}.score-lock-panel{background:var(--score-card);border:1px solid var(--score-line);border-radius:16px;padding:16px}.score-lock-panel h3{margin:0 0 10px}.score-lock-item{border-top:1px solid var(--score-line);padding:10px 0}.score-lock-item:first-of-type{border-top:0}.score-lock-item b{display:block}.score-lock-item small{color:var(--score-muted)}.score-setup{margin-top:18px;background:#101a31;border:1px solid var(--score-line);border-radius:16px;padding:16px}.score-setup summary{font-weight:800;cursor:pointer}.score-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.score-controls select,.score-controls input{max-width:180px}.score-badge{color:var(--score-cyan);font-weight:700}.score-empty{padding:16px;color:var(--score-muted)}
@media(max-width:700px){#live .score-app{padding:15px;border-radius:16px}.score-game{grid-template-columns:1fr}.score-info{border-left:0;border-top:1px solid var(--score-line);padding:10px 0 0}.score-lower{grid-template-columns:1fr}.score-probs{grid-template-columns:1fr 1fr}.score-section-title h3{font-size:1.25rem}.score-team{font-size:1rem}}
</style><script>
(function(){
 const sports=[['top','Top'],['nfl','NFL'],['nba','NBA'],['cfb','CFB'],['nhl','NHL'],['cbb','CBB'],['mlb','MLB'],['wnba','WNBA'],['epl','EPL']];
 const sportApi={nba:'basketball_nba',wnba:'basketball_wnba',nfl:'americanfootball_nfl',cfb:'americanfootball_ncaaf',cbb:'basketball_ncaab',mlb:'baseball_mlb',nhl:'icehockey_nhl',epl:'soccer_epl'};
 let selected='nba', propCache=[];
 const esc=value=>String(value==null?'':value).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
 const percent=value=>Number.isFinite(Number(value))?(Number(value)*100).toFixed(1)+'%':'—';
 const odds=value=>Number.isFinite(Number(value))?(Number(value)>0?'+'+value:String(value)):'—';
 const api=async url=>{const response=await fetch(url);const data=await response.json();if(!response.ok)throw new Error(data.error||'Request failed');return data;};
 const live=document.getElementById('live'); if(!live)return;
 live.innerHTML='<div class="score-app"><div class="score-head"><div class="score-brand"><div class="score-logo">E</div><div><h2>Scores</h2><div class="muted">Scores, market probabilities and research watchlists</div></div></div><div class="score-controls"><button class="btn" id="scoresRefresh">Refresh</button></div></div><div class="score-sports" id="scoreSports"></div><div class="score-dates" id="scoreDates"></div><div class="score-section-title"><h3 id="leagueHeading">NBA Games</h3><span class="score-badge" id="scoreUpdated">Loading…</span></div><div class="score-data-note" id="probNote">Probabilities are consensus no-vig market estimates, not guaranteed predictions.</div><div id="scoresGames" class="score-empty">Loading scores…</div><div class="score-lower"><section class="score-lock-panel"><h3>Moneyline watchlist</h3><div id="moneylineWatch" class="score-empty">Loading market prices…</div></section><section class="score-lock-panel"><h3>Player props watchlist</h3><div id="propWatch" class="score-empty">Props require a supported league and Odds API access.</div></section></div><details class="score-setup"><summary>Data setup — how to make stats appear</summary><ol><li>ESPN public scores load without a key; they include scores/schedule, not team records or full box-score stats.</li><li>Add <code>THE_ODDS_API_KEY</code> as an environment variable in your host (Render: Dashboard → service → Environment) to show moneyline probabilities, best prices, edges, and supported prop markets.</li><li>Restart/redeploy the service after adding the key. Check <code>/api/health</code> to confirm the Odds API is enabled.</li><li>Player prop data coverage depends on the Odds API plan and league. Player last-5/10/15 game logs need a licensed stats feed or user-entered game results; the current props endpoint does not supply historical player logs.</li></ol><p class="score-data-note">No sample/demo projections are presented as live stats. Missing provider data is shown as unavailable.</p></details></div>';
 const sportsEl=document.getElementById('scoreSports');
 sports.forEach(([key,label])=>{const button=document.createElement('button');button.className='score-sport'+(key===selected?' active':'');button.textContent=label;button.onclick=()=>{selected=key==='top'?'nba':key;sportsEl.querySelectorAll('button').forEach(item=>item.classList.toggle('active',item===button));loadScores();loadProps();};sportsEl.appendChild(button);});
 const datesEl=document.getElementById('scoreDates');
 for(let offset=-2;offset<=4;offset++){const date=new Date();date.setDate(date.getDate()+offset);const button=document.createElement('button');button.className='score-date'+(offset===0?' active':'');button.dataset.date=date.toISOString().slice(0,10).replace(/-/g,'');button.innerHTML=(offset===0?'TODAY':date.toLocaleDateString(undefined,{weekday:'short'}))+'<small>'+date.toLocaleDateString(undefined,{month:'short',day:'numeric'})+'</small>';button.onclick=()=>{datesEl.querySelectorAll('button').forEach(item=>item.classList.toggle('active',item===button));loadScores(button.dataset.date);};datesEl.appendChild(button);}
 function renderGame(event,game){
   const complete=Number.isFinite(Number(game.homeWinProbability))&&Number.isFinite(Number(game.awayWinProbability));
   const live=String(game.status||event.status||'').toLowerCase().includes('final')||String(game.status||'').toLowerCase().includes('quarter');
   const homeScore=game.homeScore===''?'—':game.homeScore, awayScore=game.awayScore===''?'—':game.awayScore;
   const prob=complete?'<div class="score-probs"><div class="score-prob"><b>'+percent(game.awayWinProbability)+'</b><small>'+esc(game.away)+' win chance</small><small>Best '+odds(game.awayBestOdds)+' '+(game.awayBestBook?'· '+esc(game.awayBestBook):'')+'</small><small>Price edge '+percent(game.awayPriceEdge)+'</small></div><div class="score-prob"><b>'+percent(game.homeWinProbability)+'</b><small>'+esc(game.home)+' win chance</small><small>Best '+odds(game.homeBestOdds)+' '+(game.homeBestBook?'· '+esc(game.homeBestBook):'')+'</small><small>Price edge '+percent(game.homePriceEdge)+'</small></div></div>':'<div class="score-probs"><div class="score-prob"><b>—</b><small>'+esc(game.away)+' win chance</small><small>Odds API key / market data needed</small></div><div class="score-prob"><b>—</b><small>'+esc(game.home)+' win chance</small><small>Odds API key / market data needed</small></div></div>';
   return '<article class="score-game"><div class="score-match"><div class="score-team">'+esc(game.away)+' <span class="record">'+esc(awayScore)+'</span></div><b>'+esc(game.status||event.status||'Scheduled')+'</b><div class="score-team">'+esc(game.home)+' <span class="record">'+esc(homeScore)+'</span></div><b>'+esc(game.venue||'')+'</b></div><div class="score-info">'+prob+'</div></article>';
 }
 async function loadScores(date){
   const target=document.getElementById('scoresGames');target.innerHTML='<div class="score-empty">Loading '+esc(selected.toUpperCase())+' scores…</div>';
   document.getElementById('leagueHeading').textContent=(selected==='cbb'?'College Basketball':selected.toUpperCase())+' Games';
   try{const data=await api('/api/espn/scoreboard?league='+encodeURIComponent(selected)+(date?'&date='+encodeURIComponent(date):''));const games=(data.events||[]).flatMap(event=>(event.competitions||[]).map(game=>renderGame(event,game))).join('');target.innerHTML=games||'<div class="score-empty">No games scheduled for this league and date.</div>';document.getElementById('scoreUpdated').textContent='Updated '+new Date(data.fetchedAt||Date.now()).toLocaleTimeString();document.getElementById('probNote').textContent=data.probabilityNote||'Market probabilities are estimates, not guarantees.';loadMoneylineWatch(data.events||[]);}catch(error){target.innerHTML='<div class="score-empty">Scores unavailable: '+esc(error.message)+'</div>';}
 }
 async function loadMoneylineWatch(events){const box=document.getElementById('moneylineWatch');const rows=(events||[]).flatMap(event=>(event.competitions||[]).map(game=>({game,event}))).filter(({game})=>Number.isFinite(Number(game.homeWinProbability))&&Number.isFinite(Number(game.awayWinProbability))).map(({game})=>({team:Number(game.homePriceEdge)>=Number(game.awayPriceEdge)?game.home:game.away,opponent:Number(game.homePriceEdge)>=Number(game.awayPriceEdge)?game.away:game.home,prob:Number(game.homePriceEdge)>=Number(game.awayPriceEdge)?game.homeWinProbability:game.awayWinProbability,edge:Math.max(Number(game.homePriceEdge)||0,Number(game.awayPriceEdge)||0),price:Number(game.homePriceEdge)>=Number(game.awayPriceEdge)?game.homeBestOdds:game.awayBestOdds,book:Number(game.homePriceEdge)>=Number(game.awayPriceEdge)?game.homeBestBook:game.awayBestBook})).sort((a,b)=>b.edge-a.edge).slice(0,5);box.innerHTML=rows.length?rows.map(row=>'<div class="score-lock-item"><b>'+esc(row.team)+' over '+esc(row.opponent)+' · '+percent(row.prob)+'</b><small>Price '+odds(row.price)+' · '+esc(row.book||'Best available')+' · price edge '+percent(row.edge)+'</small></div>').join(''):'<div class="score-empty">Moneyline watchlist appears when live odds are available. Add THE_ODDS_API_KEY to enable it.</div>';}
 async function loadProps(){const box=document.getElementById('propWatch'),sport=sportApi[selected];if(!sport){box.innerHTML='<div class="score-empty">Props are not currently mapped for this league.</div>';return;}box.innerHTML='<div class="score-empty">Loading available player props…</div>';try{const data=await api('/api/props?sport='+encodeURIComponent(sport));propCache=data.props||[];const items=propCache.slice(0,7);box.innerHTML=items.length?items.map(item=>'<div class="score-lock-item"><b>'+esc(item.player)+' · '+esc(item.market.replace(/^player_/,'').replace(/_/g,' '))+(item.point!==null?' '+esc(item.point):'')+'</b><small>'+esc(item.event)+' · '+esc(item.bookmaker)+' · '+odds(item.price)+'</small></div>').join(''):'<div class="score-empty">No player props returned for this sport or data plan.</div>'; }catch(error){box.innerHTML='<div class="score-empty">Player props unavailable: '+esc(error.message)+'<br>Configure THE_ODDS_API_KEY and confirm your provider plan supports these markets.</div>';}}
 window.loadScoreboard=loadScores;window.refreshLive=async function(){await loadScores();await loadProps();};
 document.getElementById('scoresRefresh').onclick=()=>{loadScores();loadProps();};
 loadScores();loadProps();
})();
</script>`;

async function handle(req,res) {
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(req.method==='GET'&&u.pathname==='/api/health')return send(res,200,{ok:true,version:'3.3.0',providers:{theOddsApi:{enabled:!!process.env.THE_ODDS_API_KEY},openai:{enabled:!!process.env.OPENAI_API_KEY},espn:{enabled:true,unofficial:true}}});
  if(req.method==='GET'&&u.pathname==='/api/espn/scoreboard'){
    const league=(u.searchParams.get('league')||'nba').toLowerCase(),mapping=leagues[league];if(!mapping)return send(res,400,{error:'Unsupported ESPN league key'});
    const date=u.searchParams.get('date'),cacheKey=`espn:${league}:${date||'today'}`,hit=cacheGet(cacheKey,20000);if(hit)return send(res,200,{...hit,cached:true});
    const url=new URL(`https://site.api.espn.com/apis/site/v2/sports/${mapping[0]}/${mapping[1]}/scoreboard`);if(date&&/^\d{8}$/.test(date))url.searchParams.set('dates',date);
    try{
      const [data,moneylines]=await Promise.all([jsonFetch(url),getMoneylines(league).catch(()=>new Map())]);
      const events=(data.events||[]).map(event=>({name:event.name,date:event.date,status:event.status?.type?.shortDetail||event.status?.type?.description||'Scheduled',competitions:(event.competitions||[]).map(competition=>{
        const home=competition.competitors?.find(team=>team.homeAway==='home'),away=competition.competitors?.find(team=>team.homeAway==='away');
        const homeName=home?.team?.displayName||home?.team?.name||'Home',awayName=away?.team?.displayName||away?.team?.name||'Away';
        const estimate=[...moneylines.entries()].find(([key])=>{const [h,a]=key.split('|');return eventTeamMatch(h,homeName)&&eventTeamMatch(a,awayName);})?.[1];
        return {home:homeName,away:awayName,homeScore:home?.score??'',awayScore:away?.score??'',venue:competition.venue?.fullName||'',status:competition.status?.type?.detail||competition.status?.type?.shortDetail||'Scheduled',...(estimate||{})};
      })}));
      const out={league,events,fetchedAt:new Date().toISOString(),probabilityNote:process.env.THE_ODDS_API_KEY?'Win chances are consensus no-vig market probabilities. Price edge is fair probability minus the best-price break-even probability; it is not a guaranteed prediction.':'ESPN scores load without a key. Configure THE_ODDS_API_KEY to display market win probabilities, best prices and edges.'};cacheSet(cacheKey,out);return send(res,200,out);
    }catch(error){return send(res,502,{error:`ESPN feed unavailable: ${error.message}`});}
  }
  if(req.method==='GET'&&u.pathname==='/api/espn/news'){
    const key='espn:news',hit=cacheGet(key,60000);if(hit)return send(res,200,{...hit,cached:true});
    try{const data=await jsonFetch('https://site.api.espn.com/apis/site/v2/sports/news?limit=15');const articles=(data.articles||[]).map(item=>({headline:item.headline,description:item.description,published:item.published,url:item.links?.web?.href||item.link||''}));const out={articles,fetchedAt:new Date().toISOString()};cacheSet(key,out);return send(res,200,out);}catch(error){return send(res,502,{error:`ESPN news unavailable: ${error.message}`});}
  }
  if(req.method==='GET'&&u.pathname==='/api/props'){
    const key=process.env.THE_ODDS_API_KEY;if(!key)return send(res,503,{error:'THE_ODDS_API_KEY is not configured. Add it to your host environment and restart the service.'});
    const sport=u.searchParams.get('sport')||'basketball_nba';if(!/^[a-z0-9_]+$/.test(sport))return send(res,400,{error:'Invalid sport key'});
    const markets=(u.searchParams.get('markets')||'player_points,player_rebounds,player_assists').trim(),cacheKey=`props:${sport}:${markets}`,hit=cacheGet(cacheKey,45000);if(hit)return send(res,200,{...hit,cached:true});
    try{const base=`https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sport)}`,events=await jsonFetch(`${base}/events?apiKey=${encodeURIComponent(key)}`);if(!Array.isArray(events))throw new Error('Unexpected events response');const rows=[];for(let i=0;i<Math.min(events.length,8);i+=4){const batch=events.slice(i,i+4);const responses=await Promise.all(batch.map(event=>{const url=new URL(`${base}/events/${encodeURIComponent(event.id)}/odds`);url.searchParams.set('apiKey',key);url.searchParams.set('regions','us');url.searchParams.set('markets',markets);return jsonFetch(url)}));responses.forEach(response=>rows.push(...flattenProps([response])));}const out={props:rows,eventsScanned:Math.min(events.length,8),eventsAvailable:events.length,provider:'The Odds API',fetchedAt:new Date().toISOString(),note:'Sportsbook prop markets are subject to provider plan coverage. These are not PrizePicks projections or player historical game logs.'};cacheSet(cacheKey,out);return send(res,200,out);}catch(error){return send(res,502,{error:`Player prop provider error: ${error.message}`});}
  }
  if(req.method==='POST'&&u.pathname==='/api/ai/analyze'){
    if(!process.env.OPENAI_API_KEY)return send(res,503,{error:'OPENAI_API_KEY is not configured.'});let body='';for await(const chunk of req){body+=chunk;if(body.length>60000)return send(res,413,{error:'Request too large'});}let parsed;try{parsed=JSON.parse(body)}catch{return send(res,400,{error:'Invalid JSON body.'});}
    try{const data=await jsonFetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o-mini',input:`Carefully analyze the supplied sports research data. Do not invent current facts, guarantee outcomes, or call a bet a lock. Explain uncertainty and missing data.\n\n${JSON.stringify(parsed,null,2)}`})});return send(res,200,{analysis:data.output_text||data.answer||JSON.stringify(data)});}catch(error){return send(res,502,{error:`OpenAI analysis failed: ${error.message}`});}
  }
  if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html')){
    const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');return send(res,200,html.replace('</body>',SCORES_UI+'\n</body>'),'text/html; charset=utf-8');
  }
  return send(res,404,{error:'Not found'});
}
const server=http.createServer((req,res)=>{handle(req,res).catch(error=>{console.error(error);if(!res.headersSent)send(res,500,{error:'Internal server error'});});});
server.listen(PORT,HOST,()=>console.log(`Elite Wagers running at http://${HOST}:${PORT}`));
