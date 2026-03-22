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

// ============================================================
// Parse Moneycontrol IPO page — extract from description text
// Pattern: "XYZ Ltd IPO price band is set at 375 to 395"
// Pattern: "opens for subscription on 2026-03-24 and closes on 2026-03-27"
// ============================================================
function parseMoneycontrolIPOs(html) {
  var ipos = [];
  
  // Split by IPO blocks — each IPO has description with dates and prices
  var descRegex = /(?:<p[^>]*>)?\s*([\w\s&.,'\-()]+(?:Ltd|Limited)[^<]*IPO)\s+(?:opens\s+for\s+subscription\s+on\s+(\d{4}-\d{2}-\d{2})\s+and\s+closes\s+on\s+(\d{4}-\d{2}-\d{2})[^<]*price\s+band\s+is\s+set\s+at\s+([\d,.]+)\s+to\s+([\d,.]+)(?:[^<]*per\s+share)?)/gi;
  
  var match;
  while ((match = descRegex.exec(html)) !== null) {
    var fullName = match[1].replace(/\s+IPO\s*$/i, '').replace(/\s+/g, ' ').trim();
    var openDate = match[2];
    var closeDate = match[3];
    var priceLow = match[4];
    var priceHigh = match[5];
    
    // Determine type from surrounding HTML
    var surroundStart = Math.max(0, match.index - 500);
    var surrounding = html.substring(surroundStart, match.index + match[0].length);
    var type = 'IPO';
    if (surrounding.match(/SME/i)) type = 'SME';
    if (surrounding.match(/Mainline/i)) type = 'Mainline';
    if (surrounding.match(/OFS/i)) type = 'OFS';
    
    // Extract issue size from nearby text
    var issueSize = '';
    var sizeBlock = html.substring(match.index, match.index + 2000);
    var sizeMatch = sizeBlock.match(/Issue\s*Size[\s\S]*?<td[^>]*>\s*([\s\S]*?)<\/td>/i);
    if (sizeMatch) issueSize = strip(sizeMatch[1]);
    
    // Format dates nicely
    var openFormatted = formatDateStr(openDate);
    var closeFormatted = formatDateStr(closeDate);
    
    ipos.push({
      name: fullName,
      issueType: type,
      priceBand: '₹' + priceLow + ' - ₹' + priceHigh,
      openDate: openFormatted,
      closeDate: closeFormatted,
      issueSize: issueSize
    });
  }
  
  return ipos;
}

function formatDateStr(dateStr) {
  if (!dateStr) return '';
  try {
    var d = new Date(dateStr);
    var day = String(d.getDate()).padStart(2, '0');
    var mon = String(d.getMonth() + 1).padStart(2, '0');
    var year = d.getFullYear();
    return day + '/' + mon + '/' + year;
  } catch(e) { return dateStr; }
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
// /movers — BSE India Official API (Government)
// ============================================================
app.get('/movers', async (req, res) => {
  try {
    var BSE = 'https://api.bseindia.com/BseIndiaAPI/api';
    var REF = 'https://www.bseindia.com/';
    var movers = [];

    try {
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
    } catch(e1) { console.log('BSE gainers failed:', e1.message); }

    try {
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
    } catch(e2) { console.log('BSE losers failed:', e2.message); }

    movers.sort(function(a, b) { return b.change - a.change; });
    res.json(movers);
  } catch(e) {
    console.error('Movers error:', e.message);
    res.json([]);
  }
});

// ============================================================
// /ipos/upcoming — Moneycontrol scraping + BSE fallback
// ============================================================
app.get('/ipos/upcoming', async (req, res) => {
  try {
    var ipos = [];

    // Source 1: Moneycontrol upcoming IPOs page
    try {
      var html = await fetchText('https://www.moneycontrol.com/ipo/', 'https://www.moneycontrol.com/');
      ipos = parseMoneycontrolIPOs(html);
      console.log('MC upcoming IPOs found:', ipos.length);
    } catch(mcErr) { console.log('MC upcoming failed:', mcErr.message); }

    // Also try the upcoming-ipos page
    if (ipos.length < 3) {
      try {
        var html2 = await fetchText('https://www.moneycontrol.com/ipo/upcoming-ipos/', 'https://www.moneycontrol.com/');
        var more = parseMoneycontrolIPOs(html2);
        more.forEach(function(ipo) {
          var exists = ipos.some(function(e) { return e.name.substring(0, 15) === ipo.name.substring(0, 15); });
          if (!exists) ipos.push(ipo);
        });
        console.log('MC upcoming-ipos page found:', more.length);
      } catch(e) { console.log('MC upcoming-ipos page failed'); }
    }

    // Source 2: BSE API fallback
    if (ipos.length === 0) {
      try {
        var data = await fetchJSON('https://api.bseindia.com/BseIndiaAPI/api/IPODetail/w?type=upcoming', 'https://www.bseindia.com/');
        if (Array.isArray(data)) {
          data.forEach(function(ipo) {
            ipos.push({
              name: ipo.Issue_Name || '',
              issueType: ipo.Issue_Type || 'IPO',
              priceBand: ipo.Price_Band || '',
              openDate: ipo.Issue_Open || '',
              closeDate: ipo.Issue_Close || '',
              issueSize: ipo.Issue_Size || ''
            });
          });
        }
      } catch(bseErr) { console.log('BSE IPO failed:', bseErr.message); }
    }

    console.log('Total upcoming IPOs:', ipos.length);
    res.json(ipos);
  } catch(e) {
    console.error('IPOs upcoming error:', e.message);
    res.json([]);
  }
});

// ============================================================
// /ipos/recent — BSE API
// ============================================================
app.get('/ipos/recent', async (req, res) => {
  try {
    var ipos = [];
    try {
      var data = await fetchJSON('https://api.bseindia.com/BseIndiaAPI/api/IPODetail/w?type=recent', 'https://www.bseindia.com/');
      if (Array.isArray(data)) {
        data.forEach(function(ipo) {
          ipos.push({
            name: ipo.Issue_Name || '',
            issueType: ipo.Issue_Type || 'IPO',
            priceBand: ipo.Price_Band || '',
            openDate: ipo.Issue_Open || '',
            closeDate: ipo.Issue_Close || '',
            issueSize: ipo.Issue_Size || ''
          });
        });
      }
    } catch(bseErr) { console.log('BSE recent IPO failed:', bseErr.message); }
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
      } catch(e) { console.log('Picks source ' + i + ' failed'); }
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
    service: 'SRJahir Stocks API v4',
    endpoints: ['/news', '/movers', '/ipos/upcoming', '/ipos/recent', '/picks'],
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => console.log('SRJahir Stocks API v4 running on port ' + PORT));
