const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// ============================================================
// HELPERS
// ============================================================
function fetchJSON(url, referer) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': referer || 'https://www.bseindia.com/',
      'Origin': referer ? new URL(referer).origin : 'https://www.bseindia.com'
    };
    https.get(url, { headers, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJSON(res.headers.location, referer).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse failed')); }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchText(url, referer) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
      'Referer': referer || 'https://www.google.com/'
    };
    https.get(url, { headers, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchText(res.headers.location, referer).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

function cleanCDATA(str) {
  return (str || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();
}

function strip(str) {
  return (str || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#8377;/g, '₹').trim();
}

function parseRSSItems(xml) {
  var items = [];
  var regex = /<item>([\s\S]*?)<\/item>/g;
  var m;
  while ((m = regex.exec(xml)) !== null) {
    var block = m[1];
    var title = cleanCDATA((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    var link = cleanCDATA((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
    var pubDate = cleanCDATA((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]);
    if (title) items.push({ title: title, link: link, pubDate: pubDate });
  }
  return items;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    var d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
  } catch(e) { return dateStr; }
}

// ============================================================
// Extract Moneycontrol embedded JSON from HTML
// ============================================================
function extractMCIpos(html) {
  var ipos = [];
  var jsonRegex = /\[\s*\{[^[\]]*?"company_name"\s*:\s*"[^"]*"[^[\]]*?"ipo_status"\s*:\s*"[^"]*"[\s\S]*?\}\s*\]/g;
  var match;
  while ((match = jsonRegex.exec(html)) !== null) {
    try {
      var arr = JSON.parse(match[0]);
      if (Array.isArray(arr)) {
        arr.forEach(function(ipo) {
          ipos.push({
            name: (ipo.company_name || '').replace(/\s*Ltd\.?\s*$/i, ' Ltd').trim(),
            issueType: ipo.ipo_type || 'IPO',
            priceBand: (ipo.from_issue_price && ipo.to_issue_price) 
              ? '₹' + ipo.from_issue_price + ' - ₹' + ipo.to_issue_price : '',
            openDate: formatDate(ipo.open_date) || '',
            closeDate: formatDate(ipo.close_date) || '',
            issueSize: ipo.issue_size ? '₹' + (ipo.issue_size / 10000000).toFixed(2) + ' Cr' : '',
            lotSize: ipo.lot_size || '',
            listingDate: formatDate(ipo.listing_date) || '',
            totalSubs: ipo.total_subs || '',
            status: ipo.ipo_status || ''
          });
        });
      }
    } catch(e) {}
  }
  var seen = {};
  return ipos.filter(function(i) {
    var key = i.name.toLowerCase().substring(0, 20);
    if (seen[key]) return false;
    seen[key] = true; return true;
  });
}

// ============================================================
// Extract gainers/losers from Moneycontrol HTML tables
// MC pages have <table> with stock data
// ============================================================
function extractMCMovers(html, type) {
  var movers = [];
  
  // Method 1: Look for JSON data embedded in page (like IPOs)
  var jsonRegex = /\[\s*\{[^[\]]*?"[Ss]tock[Nn]ame"\s*:\s*"[^"]*"[\s\S]*?\}\s*\]/g;
  var match;
  while ((match = jsonRegex.exec(html)) !== null) {
    try {
      var arr = JSON.parse(match[0]);
      if (Array.isArray(arr)) {
        arr.forEach(function(s) {
          movers.push({
            stock: s.stockName || s.StockName || s.company || '',
            price: parseFloat(s.price || s.Price || s.ltp || s.LTP || 0),
            change: parseFloat(s.perChange || s.pChange || s.change_per || 0),
            pe: '', mcap: 0
          });
        });
      }
    } catch(e) {}
  }
  
  // Method 2: Parse HTML table rows
  if (movers.length === 0) {
    var trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    var trMatch;
    while ((trMatch = trRegex.exec(html)) !== null && movers.length < 30) {
      var tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      var cells = [];
      var td;
      while ((td = tdRegex.exec(trMatch[1])) !== null) {
        cells.push(strip(td[1]));
      }
      // Typical MC table: Stock Name, Price, Change, Change%, ...
      if (cells.length >= 3) {
        var name = cells[0];
        // Skip header rows
        if (name && !name.match(/stock|name|company|sr/i) && name.length > 2) {
          var price = parseFloat((cells[1] || '0').replace(/,/g, ''));
          var changePct = 0;
          // Find the % change cell
          for (var c = 2; c < cells.length; c++) {
            var val = cells[c].replace(/[()%,]/g, '').trim();
            if (val.match(/^-?\d+\.?\d*$/) && Math.abs(parseFloat(val)) < 100) {
              changePct = parseFloat(val);
              break;
            }
          }
          if (name && price > 0) {
            movers.push({
              stock: name,
              price: price,
              change: changePct,
              pe: '', mcap: 0
            });
          }
        }
      }
    }
  }
  
  return movers;
}

// ============================================================
// /news — ET Stock News RSS
// ============================================================
app.get('/news', async (req, res) => {
  try {
    var xml = await fetchText(
      'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms',
      'https://economictimes.indiatimes.com/'
    );
    var items = parseRSSItems(xml);
    res.json(items.slice(0, 20).map(function(item) {
      return { headline: item.title, title: item.title, link: item.link, date: item.pubDate };
    }));
  } catch(e) {
    console.error('News error:', e.message);
    res.json([]);
  }
});

// ============================================================
// /movers — Moneycontrol Gainers + Losers
// ============================================================
app.get('/movers', async (req, res) => {
  try {
    var movers = [];

    // Source 1: Moneycontrol Top Gainers NSE
    try {
      var ghtml = await fetchText('https://www.moneycontrol.com/stocks/marketstats/nsegainer/index.php', 'https://www.moneycontrol.com/');
      var gainers = extractMCMovers(ghtml, 'gainer');
      console.log('MC gainers found:', gainers.length);
      movers = movers.concat(gainers);
    } catch(e) { console.log('MC gainers failed:', e.message); }

    // Source 2: Moneycontrol Top Losers NSE
    try {
      var lhtml = await fetchText('https://www.moneycontrol.com/stocks/marketstats/nseloser/index.php', 'https://www.moneycontrol.com/');
      var losers = extractMCMovers(lhtml, 'loser');
      console.log('MC losers found:', losers.length);
      movers = movers.concat(losers);
    } catch(e) { console.log('MC losers failed:', e.message); }

    // Fallback: Try alternate MC URLs
    if (movers.length === 0) {
      try {
        var ghtml2 = await fetchText('https://www.moneycontrol.com/stocks/market-stats/top-gainers-nse/', 'https://www.moneycontrol.com/');
        var gainers2 = extractMCMovers(ghtml2, 'gainer');
        movers = movers.concat(gainers2);
      } catch(e) {}
      
      try {
        var lhtml2 = await fetchText('https://www.moneycontrol.com/stocks/market-stats/top-losers-nse/', 'https://www.moneycontrol.com/');
        var losers2 = extractMCMovers(lhtml2, 'loser');
        movers = movers.concat(losers2);
      } catch(e) {}
    }

    // Fallback 2: BSE API (in case it works sometimes)
    if (movers.length === 0) {
      try {
        var BSE = 'https://api.bseindia.com/BseIndiaAPI/api';
        var REF = 'https://www.bseindia.com/';
        var data = await fetchJSON(BSE + '/StockReachGraph/w?scripcode=&flag=0&fromdate=&todate=&seession=&type=gainer', REF);
        if (data && Array.isArray(data.Table)) {
          data.Table.slice(0, 25).forEach(function(g) {
            movers.push({
              stock: g.scripname || g.scrip_nm || '',
              price: parseFloat(g.ltradert || g.LTP || 0),
              change: parseFloat(g.perchg || g.Perchg || 0),
              pe: '', mcap: 0
            });
          });
        }
        var data2 = await fetchJSON(BSE + '/StockReachGraph/w?scripcode=&flag=0&fromdate=&todate=&seression=&type=loser', REF);
        if (data2 && Array.isArray(data2.Table)) {
          data2.Table.slice(0, 25).forEach(function(l) {
            movers.push({
              stock: l.scripname || l.scrip_nm || '',
              price: parseFloat(l.ltradert || l.LTP || 0),
              change: parseFloat(l.perchg || l.Perchg || 0),
              pe: '', mcap: 0
            });
          });
        }
      } catch(e) { console.log('BSE movers fallback failed:', e.message); }
    }

    // Sort: gainers first (high change), then losers (low change)
    movers.sort(function(a, b) { return b.change - a.change; });
    
    // Deduplicate
    var seen = {};
    movers = movers.filter(function(m) {
      var key = m.stock.toLowerCase().substring(0, 15);
      if (seen[key]) return false;
      seen[key] = true; return true;
    });

    console.log('Total movers:', movers.length);
    res.json(movers);
  } catch(e) {
    console.error('Movers error:', e.message);
    res.json([]);
  }
});

// ============================================================
// /ipos/upcoming — Moneycontrol JSON + BSE fallback
// ============================================================
app.get('/ipos/upcoming', async (req, res) => {
  try {
    var ipos = [];

    try {
      var html = await fetchText('https://www.moneycontrol.com/ipo/', 'https://www.moneycontrol.com/');
      ipos = extractMCIpos(html);
      ipos = ipos.filter(function(i) {
        var s = (i.status || '').toLowerCase();
        return s === 'open' || s === 'upcoming';
      });
      console.log('MC upcoming IPOs found:', ipos.length);
    } catch(mcErr) { console.log('MC upcoming failed:', mcErr.message); }

    if (ipos.length < 3) {
      try {
        var html2 = await fetchText('https://www.moneycontrol.com/ipo/upcoming-ipos/', 'https://www.moneycontrol.com/');
        var more = extractMCIpos(html2);
        more = more.filter(function(i) {
          var s = (i.status || '').toLowerCase();
          return s === 'open' || s === 'upcoming';
        });
        more.forEach(function(ipo) {
          var exists = ipos.some(function(e) { return e.name.substring(0,15) === ipo.name.substring(0,15); });
          if (!exists) ipos.push(ipo);
        });
      } catch(e) {}
    }

    if (ipos.length === 0) {
      try {
        var data = await fetchJSON('https://api.bseindia.com/BseIndiaAPI/api/IPODetail/w?type=upcoming', 'https://www.bseindia.com/');
        if (Array.isArray(data)) {
          data.forEach(function(ipo) {
            ipos.push({
              name: ipo.Issue_Name || '', issueType: ipo.Issue_Type || 'IPO',
              priceBand: ipo.Price_Band || '', openDate: ipo.Issue_Open || '',
              closeDate: ipo.Issue_Close || '', issueSize: ipo.Issue_Size || ''
            });
          });
        }
      } catch(bseErr) {}
    }

    res.json(ipos);
  } catch(e) {
    res.json([]);
  }
});

// ============================================================
// /ipos/recent — Moneycontrol + BSE fallback
// ============================================================
app.get('/ipos/recent', async (req, res) => {
  try {
    var ipos = [];

    try {
      var html = await fetchText('https://www.moneycontrol.com/ipo/listed-ipos/', 'https://www.moneycontrol.com/');
      ipos = extractMCIpos(html);
      console.log('MC recent IPOs found:', ipos.length);
    } catch(mcErr) {}

    if (ipos.length === 0) {
      try {
        var data = await fetchJSON('https://api.bseindia.com/BseIndiaAPI/api/IPODetail/w?type=recent', 'https://www.bseindia.com/');
        if (Array.isArray(data)) {
          data.forEach(function(ipo) {
            ipos.push({
              name: ipo.Issue_Name || '', issueType: ipo.Issue_Type || 'IPO',
              priceBand: ipo.Price_Band || '', openDate: ipo.Issue_Open || '',
              closeDate: ipo.Issue_Close || '', issueSize: ipo.Issue_Size || ''
            });
          });
        }
      } catch(bseErr) {}
    }

    res.json(ipos);
  } catch(e) {
    res.json([]);
  }
});

// ============================================================
// /picks — ET Recommendations + News Fallback
// ============================================================
app.get('/picks', async (req, res) => {
  try {
    var picks = [];
    var urls = [
      { url: 'https://economictimes.indiatimes.com/markets/stocks/recos/rssfeeds/2146844.cms', tag: 'ET Recommend' },
      { url: 'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms', tag: 'Market News' }
    ];
    for (var i = 0; i < urls.length && picks.length < 10; i++) {
      try {
        var xml = await fetchText(urls[i].url, 'https://economictimes.indiatimes.com/');
        var items = parseRSSItems(xml);
        items.slice(0, 10 - picks.length).forEach(function(item) {
          picks.push({ stock: item.title, reason: urls[i].tag, link: item.link });
        });
      } catch(e) {}
    }
    res.json(picks);
  } catch(e) {
    res.json([]);
  }
});

// ============================================================
// Health check
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SRJahir Stocks API v6',
    sources: {
      movers: 'Moneycontrol + BSE fallback',
      ipos: 'Moneycontrol + BSE fallback',
      news: 'Economic Times RSS',
      picks: 'ET Recommendations RSS'
    },
    endpoints: ['/news', '/movers', '/ipos/upcoming', '/ipos/recent', '/picks'],
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => console.log('SRJahir Stocks API v6 running on port ' + PORT));
