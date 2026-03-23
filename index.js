const express = require('express');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;
app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });

function fetchJSON(url, referer) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': referer || 'https://www.bseindia.com/',
      'Origin': referer ? new URL(referer).origin : 'https://www.bseindia.com'
    }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJSON(res.headers.location, referer).then(resolve).catch(reject); return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('JSON parse failed')); } });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchText(url, referer) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': referer || 'https://www.google.com/'
    }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchText(res.headers.location, referer).then(resolve).catch(reject); return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

function cleanCDATA(s) { return (s||'').replace(/<!\[CDATA\[/g,'').replace(/\]\]>/g,'').trim(); }

function parseRSS(xml) {
  var items = [], r = /<item>([\s\S]*?)<\/item>/g, m;
  while ((m = r.exec(xml)) !== null) {
    var b = m[1];
    var t = cleanCDATA((b.match(/<title>([\s\S]*?)<\/title>/)||[])[1]);
    var l = cleanCDATA((b.match(/<link>([\s\S]*?)<\/link>/)||[])[1]);
    var p = cleanCDATA((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/)||[])[1]);
    if (t && t.length > 10) items.push({title:t,link:l,pubDate:p});
  }
  return items;
}

function fmtDate(d) {
  if (!d) return '';
  try { var x=new Date(d); if(isNaN(x)) return d; return String(x.getDate()).padStart(2,'0')+'/'+String(x.getMonth()+1).padStart(2,'0')+'/'+x.getFullYear(); }
  catch(e) { return d; }
}

function extractMCIpos(html) {
  var ipos = [], r = /\[\s*\{[^[\]]*?"company_name"\s*:\s*"[^"]*"[\s\S]*?\}\s*\]/g, m;
  while ((m = r.exec(html)) !== null) {
    try {
      var arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) arr.forEach(function(i) {
        ipos.push({
          name: (i.company_name||'').replace(/\s*Ltd\.?\s*$/i,' Ltd').trim(),
          issueType: i.ipo_type||'IPO',
          priceBand: (i.from_issue_price&&i.to_issue_price)?'₹'+i.from_issue_price+' - ₹'+i.to_issue_price:'',
          openDate: fmtDate(i.open_date), closeDate: fmtDate(i.close_date),
          issueSize: i.issue_size?'₹'+(i.issue_size/10000000).toFixed(2)+' Cr':'',
          status: i.ipo_status||''
        });
      });
    } catch(e) {}
  }
  var seen = {};
  return ipos.filter(function(i) { var k=i.name.toLowerCase().substring(0,20); if(seen[k]) return false; seen[k]=true; return true; });
}

// /news
app.get('/news', async (req, res) => {
  try {
    var xml = await fetchText('https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms','https://economictimes.indiatimes.com/');
    res.json(parseRSS(xml).slice(0,20).map(i => ({headline:i.title,title:i.title,link:i.link,date:i.pubDate})));
  } catch(e) { res.json([]); }
});

// /movers — Try multiple BSE endpoints
app.get('/movers', async (req, res) => {
  try {
    var BSE = 'https://api.bseindia.com/BseIndiaAPI/api', REF = 'https://www.bseindia.com/', movers = [];
    
    // Endpoint 1: StockReachGraph
    var endpoints = [
      {url: BSE+'/StockReachGraph/w?scripcode=&flag=0&fromdate=&todate=&seession=&type=gainer', type: 'gainer'},
      {url: BSE+'/StockReachGraph/w?scripcode=&flag=0&fromdate=&todate=&seression=&type=loser', type: 'loser'},
      {url: BSE+'/MktRGainer/w?GLession=1&Ession=1', type: 'gainer2'},
      {url: BSE+'/MktRGainer/w?GLession=2&Ession=1', type: 'loser2'}
    ];
    
    for (var ep of endpoints) {
      try {
        var data = await fetchJSON(ep.url, REF);
        var table = data.Table || data;
        if (Array.isArray(table)) {
          table.slice(0, 25).forEach(function(g) {
            var name = g.scripname || g.scrip_nm || g.SC_NAME || '';
            var price = parseFloat(g.ltradert || g.LTP || g.CLSPRI || 0);
            var change = parseFloat(g.perchg || g.Perchg || g.CHANGE || 0);
            if (name && !movers.some(m => m.stock === name)) {
              movers.push({stock:name, price:price, change:change, pe:'', mcap:0});
            }
          });
        }
      } catch(e) { console.log(ep.type + ' failed:', e.message); }
    }
    
    movers.sort((a,b) => b.change - a.change);
    res.json(movers);
  } catch(e) { res.json([]); }
});

// /ipos/upcoming — Moneycontrol JSON + BSE
app.get('/ipos/upcoming', async (req, res) => {
  try {
    var ipos = [];
    try {
      var html = await fetchText('https://www.moneycontrol.com/ipo/','https://www.moneycontrol.com/');
      ipos = extractMCIpos(html).filter(i => {var s=(i.status||'').toLowerCase(); return s==='open'||s==='upcoming';});
    } catch(e) {}
    if (ipos.length < 3) {
      try {
        var h2 = await fetchText('https://www.moneycontrol.com/ipo/upcoming-ipos/','https://www.moneycontrol.com/');
        extractMCIpos(h2).filter(i => {var s=(i.status||'').toLowerCase(); return s==='open'||s==='upcoming';})
          .forEach(i => { if(!ipos.some(e=>e.name.substring(0,15)===i.name.substring(0,15))) ipos.push(i); });
      } catch(e) {}
    }
    if (ipos.length === 0) {
      try {
        var d = await fetchJSON('https://api.bseindia.com/BseIndiaAPI/api/IPODetail/w?type=upcoming','https://www.bseindia.com/');
        if (Array.isArray(d)) d.forEach(i => ipos.push({name:i.Issue_Name||'',issueType:i.Issue_Type||'IPO',priceBand:i.Price_Band||'',openDate:i.Issue_Open||'',closeDate:i.Issue_Close||'',issueSize:i.Issue_Size||''}));
      } catch(e) {}
    }
    res.json(ipos);
  } catch(e) { res.json([]); }
});

// /ipos/recent — Moneycontrol listed + BSE
app.get('/ipos/recent', async (req, res) => {
  try {
    var ipos = [];
    try {
      var html = await fetchText('https://www.moneycontrol.com/ipo/listed-ipos/','https://www.moneycontrol.com/');
      ipos = extractMCIpos(html).slice(0, 15);
    } catch(e) {}
    if (ipos.length === 0) {
      try {
        var d = await fetchJSON('https://api.bseindia.com/BseIndiaAPI/api/IPODetail/w?type=recent','https://www.bseindia.com/');
        if (Array.isArray(d)) d.forEach(i => ipos.push({name:i.Issue_Name||'',issueType:i.Issue_Type||'Listed',priceBand:i.Price_Band||'',openDate:i.Issue_Open||'',closeDate:i.Issue_Close||'',issueSize:i.Issue_Size||''}));
      } catch(e) {}
    }
    res.json(ipos);
  } catch(e) { res.json([]); }
});

// /picks — Filter out garbage titles like "Share price"
app.get('/picks', async (req, res) => {
  try {
    var picks = [];
    var urls = [
      {url:'https://economictimes.indiatimes.com/markets/stocks/recos/rssfeeds/2146844.cms',tag:'ET Recommend'},
      {url:'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms',tag:'Market News'}
    ];
    var badTitles = ['share price','stock price','market news','latest news','breaking news'];
    for (var u of urls) {
      if (picks.length >= 10) break;
      try {
        var xml = await fetchText(u.url,'https://economictimes.indiatimes.com/');
        parseRSS(xml).forEach(function(i) {
          if (picks.length >= 10) return;
          var lower = i.title.toLowerCase().trim();
          if (badTitles.some(b => lower === b || lower.length < 15)) return;
          picks.push({stock:i.title, reason:u.tag, link:i.link});
        });
      } catch(e) {}
    }
    res.json(picks);
  } catch(e) { res.json([]); }
});

app.get('/', (req, res) => {
  res.json({status:'ok',service:'SRJahir Stocks API v6',endpoints:['/news','/movers','/ipos/upcoming','/ipos/recent','/picks'],timestamp:new Date().toISOString()});
});

app.listen(PORT, () => console.log('SRJahir Stocks API v6 on port ' + PORT));
