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
  const response = await fetch(url, { ...options, headers: {'User-Agent':'EliteWagersResearch/3.2', ...(options.headers || {})}, signal:AbortSignal.timeout(18000) });
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

// Consensus probabilities come from multiple books after removing each book's vig.
// Positive price edge means the fair probability exceeds the best-book break-even probability.
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
    const homeFair = [], awayFair = [], homePrices = [], awayPrices = [];
    for (const book of event.bookmakers || []) {
      const market = (book.markets || []).find(item => item.key === 'h2h');
      const homeOutcome = market?.outcomes?.find(item => item.name === home);
      const awayOutcome = market?.outcomes?.find(item => item.name === away);
      if (!homeOutcome || !awayOutcome) continue;
      const hp = americanProbability(homeOutcome.price), ap = americanProbability(awayOutcome.price);
      if (hp === null || ap === null || hp + ap === 0) continue;
      homeFair.push(hp / (hp + ap));
      awayFair.push(ap / (hp + ap));
      homePrices.push({price:Number(homeOutcome.price), book:book.title || 'Sportsbook'});
      awayPrices.push({price:Number(awayOutcome.price), book:book.title || 'Sportsbook'});
    }
    const homeProbability = median(homeFair), awayProbability = median(awayFair);
    if (homeProbability === null || awayProbability === null) continue;
    // Best payout corresponds to the lowest implied probability among available prices.
    const bestHome = homePrices.sort((a,b) => americanProbability(a.price) - americanProbability(b.price))[0];
    const bestAway = awayPrices.sort((a,b) => americanProbability(a.price) - americanProbability(b.price))[0];
    estimates.set(`${normalizedTeam(home)}|${normalizedTeam(away)}`, {
      homeWinProbability:homeProbability, awayWinProbability:awayProbability,
      homeBestOdds:bestHome?.price ?? null, awayBestOdds:bestAway?.price ?? null,
      homeBestBook:bestHome?.book || null, awayBestBook:bestAway?.book || null,
      homePriceEdge:bestHome ? homeProbability - americanProbability(bestHome.price) : null,
      awayPriceEdge:bestAway ? awayProbability - americanProbability(bestAway.price) : null,
      probabilitySource:'The Odds API consensus no-vig moneyline',
      edgeDefinition:'Consensus no-vig win probability minus the best available price break-even probability. Positive values indicate a price advantage, not a guarantee.'
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

// Lightweight enhancement kept in the gateway so the existing single-file UI stays intact.
const UI_ENHANCEMENT = `<script>
(function(){
  function safe(v){return String(v==null?'':v).replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]})}
  function pct(v){return Number.isFinite(Number(v))?(Number(v)*100).toFixed(1)+'%':'—'}
  function edgePct(v){return Number.isFinite(Number(v))?((Number(v)>=0?'+':'')+(Number(v)*100).toFixed(1)+'%'):'—'}
  function escOdds(v){var n=Number(v);return Number.isFinite(n)?(n>0?'+'+n:String(n)):'—'}

  // Add a small last-5/10/15 trend checker using actual results the user enters.
  var propsPage=document.getElementById('props');
  if(propsPage && !document.getElementById('propTrendTool')){
    var panel=document.createElement('div'); panel.className='panel'; panel.id='propTrendTool'; panel.style.marginTop='14px';
    panel.innerHTML='<h3>Player prop: last 5 / 10 / 15 games</h3><p class="muted">Enter this player’s results for the same prop (newest first) and the current line. Hit rates are descriptive, not predictions.</p><div class="formgrid"><div><label class="label">Player and prop</label><input class="field" id="trendPlayer" placeholder="Player · points"></div><div><label class="label">Current prop line</label><input class="field" id="trendLine" type="number" step="0.5" placeholder="e.g. 24.5"></div></div><label class="label" style="margin-top:10px">Game results, newest first (comma-separated)</label><input class="field" id="trendResults" placeholder="31, 28, 24, 35, 29, 22, ..."><div class="toolbar" style="margin-top:10px"><select class="field" id="trendDirection" style="max-width:160px"><option value="over">Over</option><option value="under">Under</option></select><button class="btn blue" id="trendRun">Calculate hit rates</button></div><div id="trendOutput" style="margin-top:12px"><div class="empty">Add recent game results to see the last-5, last-10, and last-15 rates.</div></div>';
    propsPage.appendChild(panel);
    document.getElementById('trendRun').addEventListener('click',function(){
      var line=Number(document.getElementById('trendLine').value);
      var results=document.getElementById('trendResults').value.split(/[,;\\s]+/).map(Number).filter(Number.isFinite);
      var direction=document.getElementById('trendDirection').value;
      var output=document.getElementById('trendOutput');
      if(!Number.isFinite(line)||!results.length){output.innerHTML='<div class="empty">Enter a valid line and at least one numeric result.</div>';return;}
      var rows=[5,10,15].map(function(n){var sample=results.slice(0,n);var wins=sample.filter(function(x){return direction==='under'?x<line:x>line}).length;var pushes=sample.filter(function(x){return x===line}).length;var settled=sample.length-pushes;return '<div class="stat"><strong>'+ (settled?((wins/settled)*100).toFixed(1)+'%':'—') +'</strong><span>Last '+Math.min(n,results.length)+' · '+wins+'/'+settled+' hits'+(pushes?' · '+pushes+' pushes':'')+'</span></div>';}).join('');
      output.innerHTML='<div class="grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">'+rows+'</div><p class="muted">'+safe(document.getElementById('trendPlayer').value||'Player prop')+' · '+safe(direction)+' '+line+' · Based only on results you entered.</p>';
    });
  }

  // The scoreboard response includes market probabilities and price edges; render them beside live scores.
  window.loadScoreboard=async function(){
    var box=document.getElementById('scoreboard'); if(!box)return;
    var league=document.getElementById('liveLeague')?.value||'nba';
    var date=document.getElementById('liveDate')?.value||'';
    box.innerHTML='<div class="empty">Loading scoreboard and market probabilities…</div>';
    try{
      var url='/api/espn/scoreboard?league='+encodeURIComponent(league)+(date?'&date='+encodeURIComponent(date):'');
      var response=await fetch(url); var data=await response.json();
      if(!response.ok)throw new Error(data.error||'Scoreboard request failed');
      var events=data.events||[];
      if(!events.length){box.innerHTML='<div class="empty">No games found for this league/date.</div>';return;}
      box.innerHTML=events.map(function(event){
        var competitions=event.competitions||[];
        return competitions.map(function(game){
          var available=Number.isFinite(Number(game.homeWinProbability))&&Number.isFinite(Number(game.awayWinProbability));
          var homeProbability=available?pct(game.homeWinProbability):'Not available';
          var awayProbability=available?pct(game.awayWinProbability):'Not available';
          var homeEdge=available?edgePct(game.homePriceEdge):'—';
          var awayEdge=available?edgePct(game.awayPriceEdge):'—';
          var note=available?'Consensus no-vig market estimate · best-price edge is fair probability minus best-price break-even probability.':'Add THE_ODDS_API_KEY to show market win probabilities.';
          return '<div class="panel" style="margin-bottom:12px"><div class="section" style="margin-top:0"><div><h3>'+safe(game.away)+' @ '+safe(game.home)+'</h3><p>'+safe(game.status||event.status||'Scheduled')+(game.venue?' · '+safe(game.venue):'')+'</p></div><span class="tag">'+safe(game.awayScore||'—')+' : '+safe(game.homeScore||'—')+'</span></div><div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr))"><div class="stat"><strong>'+safe(awayProbability)+'</strong><span>'+safe(game.away)+' win probability</span><small>Best price '+safe(escOdds(game.awayBestOdds))+' '+(game.awayBestBook?'· '+safe(game.awayBestBook):'')+' · price edge '+safe(awayEdge)+'</small></div><div class="stat"><strong>'+safe(homeProbability)+'</strong><span>'+safe(game.home)+' win probability</span><small>Best price '+safe(escOdds(game.homeBestOdds))+' '+(game.homeBestBook?'· '+safe(game.homeBestBook):'')+' · price edge '+safe(homeEdge)+'</small></div></div><small class="muted">'+note+'</small></div>';
        }).join('');
      }).join('');
      var meta=document.getElementById('scoreMeta'); if(meta)meta.textContent=(league.toUpperCase()+' · '+(data.fetchedAt?'Updated '+new Date(data.fetchedAt).toLocaleTimeString():''));
    }catch(error){box.innerHTML='<div class="empty">Scoreboard unavailable: '+safe(error.message)+'</div>';}
  };
})();
</script>`;

async function handle(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && u.pathname === '/api/health') {
    return send(res,200,{ok:true,version:'3.2.0',providers:{theOddsApi:{enabled:!!process.env.THE_ODDS_API_KEY},openai:{enabled:!!process.env.OPENAI_API_KEY},espn:{enabled:true,unofficial:true}}});
  }
  if (req.method === 'GET' && u.pathname === '/api/espn/scoreboard') {
    const league=(u.searchParams.get('league')||'nba').toLowerCase(), mapping=leagueMap[league];
    if(!mapping)return send(res,400,{error:'Unsupported ESPN league key'});
    const date=u.searchParams.get('date'), cacheKey=`espn:${league}:${date||'today'}`, hit=cacheGet(cacheKey,20000);
    if(hit)return send(res,200,{...hit,cached:true});
    const url=new URL(`https://site.api.espn.com/apis/site/v2/sports/${mapping[0]}/${mapping[1]}/scoreboard`);
    if(date&&/^\d{8}$/.test(date))url.searchParams.set('dates',date);
    try {
      const [data,estimates]=await Promise.all([jsonFetch(url),getMoneylineEstimates(league).catch(()=>new Map())]);
      const events=(data.events||[]).map(event=>({name:event.name,date:event.date,status:event.status?.type?.shortDetail||event.status?.type?.description||'Scheduled',competitions:(event.competitions||[]).map(competition=>{
        const home=competition.competitors?.find(team=>team.homeAway==='home'),away=competition.competitors?.find(team=>team.homeAway==='away');
        const homeName=home?.team?.displayName||home?.team?.name||'Home',awayName=away?.team?.displayName||away?.team?.name||'Away';
        const estimate=estimates.get(`${normalizedTeam(homeName)}|${normalizedTeam(awayName)}`)||null;
        return {home:homeName,away:awayName,homeScore:home?.score??'',awayScore:away?.score??'',venue:competition.venue?.fullName||'',status:competition.status?.type?.detail||competition.status?.type?.shortDetail||'Scheduled',...(estimate||{})};
      })}));
      const out={league,events,fetchedAt:new Date().toISOString(),probabilityNote:process.env.THE_ODDS_API_KEY?'Win probability is consensus no-vig market pricing, not a guaranteed prediction. Positive price edge means the fair probability exceeds the best-price break-even probability.':'Add THE_ODDS_API_KEY to show market-based win probabilities.'};
      cacheSet(cacheKey,out);return send(res,200,out);
    }catch(error){return send(res,502,{error:`ESPN feed unavailable: ${error.message}`});}
  }
  if(req.method==='GET'&&u.pathname==='/api/espn/news'){
    const key='espn:news',hit=cacheGet(key,60000);if(hit)return send(res,200,{...hit,cached:true});
    try{const data=await jsonFetch('https://site.api.espn.com/apis/site/v2/sports/news?limit=15');const articles=(data.articles||[]).map(article=>({headline:article.headline,description:article.description,published:article.published,url:article.links?.web?.href||article.link||''}));const out={articles,fetchedAt:new Date().toISOString()};cacheSet(key,out);return send(res,200,out);}catch(error){return send(res,502,{error:`ESPN news unavailable: ${error.message}`});}
  }
  if(req.method==='GET'&&u.pathname==='/api/props'){
    const key=process.env.THE_ODDS_API_KEY;if(!key)return send(res,503,{error:'THE_ODDS_API_KEY is not configured. Add it to .env and restart the server.'});
    const sport=u.searchParams.get('sport')||'basketball_nba';if(!/^[a-z0-9_]+$/.test(sport))return send(res,400,{error:'Invalid sport key'});
    const markets=(u.searchParams.get('markets')||'player_points,player_rebounds,player_assists').trim(),cacheKey=`oddsprops:${sport}:${markets}`,hit=cacheGet(cacheKey,45000);if(hit)return send(res,200,{...hit,cached:true});
    try{const base=`https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sport)}`,events=await jsonFetch(`${base}/events?apiKey=${encodeURIComponent(key)}`);if(!Array.isArray(events))throw new Error('Unexpected events response from provider');const rows=[];for(let i=0;i<Math.min(events.length,12);i+=4){const batch=events.slice(i,i+4),responses=await Promise.all(batch.map(event=>{const oddsUrl=new URL(`${base}/events/${encodeURIComponent(event.id)}/odds`);oddsUrl.searchParams.set('apiKey',key);oddsUrl.searchParams.set('regions','us');oddsUrl.searchParams.set('markets',markets);return jsonFetch(oddsUrl)}));responses.forEach(response=>rows.push(...flattenProps([response])));}const out={props:rows,eventsScanned:Math.min(events.length,12),eventsAvailable:events.length,provider:'The Odds API',fetchedAt:new Date().toISOString(),note:'Sportsbook prop lines are not PrizePicks projections.'};cacheSet(cacheKey,out);return send(res,200,out);}catch(error){return send(res,502,{error:`Player prop provider error: ${error.message}`});}
  }
  if(req.method==='POST'&&u.pathname==='/api/ai/analyze'){
    if(!process.env.OPENAI_API_KEY)return send(res,503,{error:'OPENAI_API_KEY is not configured in .env.'});let body='';for await(const chunk of req){body+=chunk;if(body.length>60000)return send(res,413,{error:'Request too large'});}let parsed;try{parsed=JSON.parse(body)}catch{return send(res,400,{error:'Invalid JSON body.'});}
    try{const data=await jsonFetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o-mini',input:`Carefully analyze the supplied sports research data. Do not invent current facts, guarantee outcomes, or claim a bet is a lock. Explain uncertainty and missing context.\n\n${JSON.stringify(parsed,null,2)}`})});return send(res,200,{analysis:data.output_text||data.answer||JSON.stringify(data)});}catch(error){return send(res,502,{error:`OpenAI analysis failed: ${error.message}`});}
  }
  if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html')){
    const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
    return send(res,200,html.replace('</body>',UI_ENHANCEMENT+'\n</body>'),'text/html; charset=utf-8');
  }
  return send(res,404,{error:'Not found'});
}

const server=http.createServer((req,res)=>{handle(req,res).catch(error=>{console.error(error);if(!res.headersSent)send(res,500,{error:'Internal server error'});});});
server.listen(PORT,HOST,()=>console.log(`Elite Wagers running at http://${HOST}:${PORT}`));
