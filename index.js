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
    https.get(url, { headers, timeout: 15000 }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        fetchJSON(resp.headers.location, referer).then(resolve).catch(reject);
        return;
      }
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse failed: ' + data.substring(0, 100))); }
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
    https.get(url, { headers, timeout: 20000 }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        fetchText(resp.headers.location, referer).then(resolve).catch(reject);
        return;
      }
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

function cleanCDATA(str) {
  return (str || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();
}

function strip(str) {
  return (str || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#8377;/g, '₹').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').trim();
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

const BSE = 'https://api.bseindia.com/BseIndiaAPI/api';
const BSE_REF = 'https://www.bseindia.com/';

// Parse BSE StockReachGraph response
function parseBSEStocks(data) {
  var stocks = [];
  if (data && Array.isArray(data.Table)) {
    data.Table.forEach(function(s) {
      stocks.push({
        stock: s.scripname || s.scrip_nm || s.SCRIP_CD || '',
        price: parseFloat(s.ltradert || s.LTP || s.ltp || 0),
        change: parseFloat(s.perchg || s.Perchg || s.PERCHG || 0),
        volume: parseInt(s.trd_qty || s.nooftrades || 0),
        high52: parseFloat(s.hi_52_wk || s['52_wk_hi'] || 0),
        low52: parseFloat(s.lo_52_wk || s['52_wk_lo'] || 0),
        pe: '', mcap: 0
      });
    });
  }
  return stocks;
}

// ============================================================
// Extract Moneycontrol embedded JSON (for IPOs)
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
// /movers — BSE API Primary (reliable JSON) + MC fallback
// ============================================================
app.get('/movers', async (req, res) => {
  try {
    var movers = [];

    // PRIMARY: BSE API — returns proper JSON with price + change%
    try {
      var gainData = await fetchJSON(BSE + '/StockReachGraph/w?scripcode=&flag=0&fromdate=&todate=&seression=&type=gainer', BSE_REF);
      var gainers = parseBSEStocks(gainData);
      console.log('BSE gainers:', gainers.length);
      movers = movers.concat(gainers.slice(0, 25));
    } catch(e) { console.log('BSE gainers failed:', e.message); }

    try {
      var loseData = await fetchJSON(BSE + '/StockReachGraph/w?scripcode=&flag=0&fromdate=&todate=&seression=&type=loser', BSE_REF);
      var losers = parseBSEStocks(loseData);
      console.log('BSE losers:', losers.length);
      movers = movers.concat(losers.slice(0, 25));
    } catch(e) { console.log('BSE losers failed:', e.message); }

    // FALLBACK: Moneycontrol HTML tables (if BSE empty)
    if (movers.length === 0) {
      try {
        var ghtml = await fetchText('https://www.moneycontrol.com/stocks/marketstats/nsegainer/index.php', 'https://www.moneycontrol.com/');
        // Parse table rows
        var trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        var trMatch;
        while ((trMatch = trRegex.exec(ghtml)) !== null && movers.length < 30) {
          var tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
          var cells = [];
          var td;
          while ((td = tdRegex.exec(trMatch[1])) !== null) cells.push(strip(td[1]));
          if (cells.length >= 5) {
            var name = cells[0];
            if (!name || name.length < 2 || /^(company|stock|name|sr)/i.test(name)) continue;
            var price = parseFloat((cells[1]||'0').replace(/,/g,''));
            // Last numeric cell that's < 100 is likely change%
            var changePct = 0;
            for (var c = cells.length - 1; c >= 2; c--) {
              var v = parseFloat(cells[c].replace(/[,%()]/g,''));
              if (!isNaN(v) && Math.abs(v) < 100) { changePct = v; break; }
            }
            if (name && price > 0) movers.push({ stock: name, price: price, change: changePct, pe: '', mcap: 0 });
          }
        }
        console.log('MC gainers fallback:', movers.length);
      } catch(e) { console.log('MC fallback failed:', e.message); }
    }

    // Sort & deduplicate
    movers.sort(function(a, b) { return b.change - a.change; });
    var seen = {};
    movers = movers.filter(function(m) {
      var key = (m.stock || '').toLowerCase().substring(0, 15);
      if (!key || seen[key]) return false;
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
      console.log('MC upcoming IPOs:', ipos.length);
    } catch(e) {}

    if (ipos.length < 3) {
      try {
        var html2 = await fetchText('https://www.moneycontrol.com/ipo/upcoming-ipos/', 'https://www.moneycontrol.com/');
        var more = extractMCIpos(html2);
        more.filter(function(i) { var s=(i.status||'').toLowerCase(); return s==='open'||s==='upcoming'; })
          .forEach(function(ipo) {
            if (!ipos.some(function(e) { return e.name.substring(0,15) === ipo.name.substring(0,15); }))
              ipos.push(ipo);
          });
      } catch(e) {}
    }

    if (ipos.length === 0) {
      try {
        var data = await fetchJSON(BSE + '/IPODetail/w?type=upcoming', BSE_REF);
        if (Array.isArray(data)) data.forEach(function(ipo) {
          ipos.push({ name: ipo.Issue_Name||'', issueType: ipo.Issue_Type||'IPO', priceBand: ipo.Price_Band||'', openDate: ipo.Issue_Open||'', closeDate: ipo.Issue_Close||'', issueSize: ipo.Issue_Size||'' });
        });
      } catch(e) {}
    }
    res.json(ipos);
  } catch(e) { res.json([]); }
});

// ============================================================
// /ipos/recent
// ============================================================
app.get('/ipos/recent', async (req, res) => {
  try {
    var ipos = [];
    try {
      var html = await fetchText('https://www.moneycontrol.com/ipo/listed-ipos/', 'https://www.moneycontrol.com/');
      ipos = extractMCIpos(html);
      console.log('MC listed IPOs:', ipos.length);
    } catch(e) {}

    if (ipos.length < 3) {
      try {
        var html2 = await fetchText('https://www.moneycontrol.com/ipo/', 'https://www.moneycontrol.com/');
        var all = extractMCIpos(html2);
        all.filter(function(i) { var s=(i.status||'').toLowerCase(); return s==='listed'||s==='closed'||s==='allotted'; })
          .forEach(function(ipo) {
            if (!ipos.some(function(e) { return e.name.substring(0,15) === ipo.name.substring(0,15); }))
              ipos.push(ipo);
          });
      } catch(e) {}
    }

    if (ipos.length === 0) {
      try {
        var data = await fetchJSON(BSE + '/IPODetail/w?type=recent', BSE_REF);
        if (Array.isArray(data)) data.forEach(function(ipo) {
          ipos.push({ name: ipo.Issue_Name||'', issueType: ipo.Issue_Type||'IPO', priceBand: ipo.Price_Band||'', openDate: ipo.Issue_Open||'', closeDate: ipo.Issue_Close||'', issueSize: ipo.Issue_Size||'' });
        });
      } catch(e) {}
    }
    res.json(ipos);
  } catch(e) { res.json([]); }
});

// ============================================================
// /picks — ET RSS (FIXED: better filtering, skip generic titles)
// ============================================================
app.get('/picks', async (req, res) => {
  try {
    var picks = [];
    var seenTitles = {};

    // Source 1: ET Stock Recommendations
    try {
      var xml = await fetchText('https://economictimes.indiatimes.com/markets/stocks/recos/rssfeeds/2146844.cms', 'https://economictimes.indiatimes.com/');
      var items = parseRSSItems(xml);
      items.forEach(function(item) {
        var t = (item.title || '').trim();
        // SKIP generic/broken titles
        if (t.length < 15) return;
        if (/^share price$/i.test(t)) return;
        if (/^stock$/i.test(t)) return;
        if (/^market$/i.test(t)) return;
        if (seenTitles[t.toLowerCase()]) return;
        seenTitles[t.toLowerCase()] = true;
        picks.push({ stock: t, reason: 'ET Recommend', link: item.link });
      });
    } catch(e) { console.log('Picks RSS1 failed:', e.message); }

    // Source 2: ET Expert Views
    if (picks.length < 8) {
      try {
        var xml2 = await fetchText('https://economictimes.indiatimes.com/markets/expert-view/rssfeeds/2146849.cms', 'https://economictimes.indiatimes.com/');
        var items2 = parseRSSItems(xml2);
        items2.forEach(function(item) {
          if (picks.length >= 12) return;
          var t = (item.title || '').trim();
          if (t.length < 15 || seenTitles[t.toLowerCase()]) return;
          seenTitles[t.toLowerCase()] = true;
          picks.push({ stock: t, reason: 'Expert View', link: item.link });
        });
      } catch(e) {}
    }

    // Source 3: ET Stock News (only pick-worthy articles)
    if (picks.length < 6) {
      try {
        var xml3 = await fetchText('https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms', 'https://economictimes.indiatimes.com/');
        var items3 = parseRSSItems(xml3);
        items3.forEach(function(item) {
          if (picks.length >= 12) return;
          var t = (item.title || '').trim();
          var tl = t.toLowerCase();
          if (t.length < 15 || seenTitles[tl]) return;
          // Only stock-recommendation-type articles
          if (tl.includes('buy') || tl.includes('target') || tl.includes('multibagger') || tl.includes('pick') || tl.includes('breakout') || tl.includes('bullish')) {
            seenTitles[tl] = true;
            picks.push({ stock: t, reason: 'Market News', link: item.link });
          }
        });
      } catch(e) {}
    }

    console.log('Picks total:', picks.length);
    res.json(picks.slice(0, 12));
  } catch(e) { res.json([]); }
});

// ============================================================
// /52week — BSE API: 52 Week High & Low Stocks
// ============================================================
app.get('/52week', async (req, res) => {
  try {
    var result = { high: [], low: [] };

    // BSE API 52 Week High
    try {
      var hData = await fetchJSON(BSE + '/StockReachGraph/w?scripcode=&flag=0&fromdate=&todate=&seression=&type=52high', BSE_REF);
      result.high = parseBSEStocks(hData).slice(0, 20).map(function(s) {
        return { stock: s.stock, price: s.price, high52: s.high52 || s.price, change: s.change };
      });
      console.log('BSE 52W high:', result.high.length);
    } catch(e) { console.log('BSE 52W high failed:', e.message); }

    // BSE API 52 Week Low
    try {
      var lData = await fetchJSON(BSE + '/StockReachGraph/w?scripcode=&flag=0&fromdate=&todate=&seression=&type=52low', BSE_REF);
      result.low = parseBSEStocks(lData).slice(0, 20).map(function(s) {
        return { stock: s.stock, price: s.price, low52: s.low52 || s.price, change: s.change };
      });
      console.log('BSE 52W low:', result.low.length);
    } catch(e) { console.log('BSE 52W low failed:', e.message); }

    // Fallback: ET RSS for 52-week related news
    if (result.high.length === 0 && result.low.length === 0) {
      try {
        var xml = await fetchText('https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms', 'https://economictimes.indiatimes.com/');
        var items = parseRSSItems(xml);
        items.forEach(function(item) {
          var t = (item.title || '').toLowerCase();
          if (t.includes('52') || t.includes('52-week') || t.includes('year high') || t.includes('year low') || t.includes('all-time')) {
            if (t.includes('high') || t.includes('rally')) {
              result.high.push({ stock: item.title, price: 0, high52: 0, change: 0, link: item.link });
            } else {
              result.low.push({ stock: item.title, price: 0, low52: 0, change: 0, link: item.link });
            }
          }
        });
      } catch(e) {}
    }

    res.json(result);
  } catch(e) { res.json({ high: [], low: [] }); }
});

// ============================================================
// /active — BSE API: Most Active by Volume
// ============================================================
app.get('/active', async (req, res) => {
  try {
    var stocks = [];

    // BSE API — Most Active by Value
    try {
      var data = await fetchJSON(BSE + '/StockReachGraph/w?scripcode=&flag=0&fromdate=&todate=&seression=&type=volume', BSE_REF);
      stocks = parseBSEStocks(data).slice(0, 25).map(function(s) {
        return { stock: s.stock, price: s.price, volume: s.volume, change: s.change };
      });
      console.log('BSE most active:', stocks.length);
    } catch(e) { console.log('BSE active failed:', e.message); }

    // Try alternate BSE endpoint
    if (stocks.length === 0) {
      try {
        var data2 = await fetchJSON(BSE + '/StockReachGraph/w?scripcode=&flag=0&fromdate=&todate=&seression=&type=value', BSE_REF);
        stocks = parseBSEStocks(data2).slice(0, 25).map(function(s) {
          return { stock: s.stock, price: s.price, volume: s.volume, change: s.change };
        });
        console.log('BSE active (value):', stocks.length);
      } catch(e) {}
    }

    res.json(stocks);
  } catch(e) { res.json([]); }
});

// ============================================================
// /fiidii — FII/DII Activity
// Source: MoneyControl AJAX endpoint + NSDL fallback
// ============================================================
app.get('/fiidii', async (req, res) => {
  try {
    var result = { fii: [], dii: [], summary: {} };

    // Try MC FII/DII page and extract from HTML
    try {
      var html = await fetchText('https://www.moneycontrol.com/stocks/marketstats/fii_dii_activity/index.php', 'https://www.moneycontrol.com/');
      
      // Try to find FII/DII data in embedded JSON or script tags
      var scriptRegex = /var\s+(?:fiiData|diiData|fii_data|dii_data|chartData)\s*=\s*(\[[\s\S]*?\]);/g;
      var sm;
      while ((sm = scriptRegex.exec(html)) !== null) {
        try {
          var arr = JSON.parse(sm[1]);
          if (Array.isArray(arr) && arr.length > 0) {
            arr.forEach(function(r) {
              var entry = { date: r.date || r.Date || '', buy: parseFloat(r.buy || r.Buy || r.gross_purchase || 0), sell: parseFloat(r.sell || r.Sell || r.gross_sales || 0), net: parseFloat(r.net || r.Net || 0) };
              if (!entry.net) entry.net = entry.buy - entry.sell;
              if (sm[0].toLowerCase().includes('fii')) result.fii.push(entry);
              else result.dii.push(entry);
            });
          }
        } catch(e) {}
      }

      // Fallback: parse HTML tables
      if (result.fii.length === 0) {
        var trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        var trMatch;
        while ((trMatch = trRegex.exec(html)) !== null) {
          var tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
          var cells = [];
          var td;
          while ((td = tdRegex.exec(trMatch[1])) !== null) cells.push(strip(td[1]));
          if (cells.length >= 4) {
            var label = (cells[0] || '').toLowerCase();
            var nums = [];
            for (var c = 1; c < cells.length; c++) {
              var v = cells[c].replace(/[₹,()]/g, '').trim();
              if (/^-?\d+\.?\d*$/.test(v)) nums.push(parseFloat(v));
            }
            if (nums.length >= 2) {
              var entry = { date: cells[0], buy: nums[0], sell: nums[1], net: nums[2] || (nums[0] - nums[1]) };
              if (label.includes('fii') || label.includes('fpi') || label.includes('foreign')) result.fii.push(entry);
              else if (label.includes('dii') || label.includes('domestic') || label.includes('mutual')) result.dii.push(entry);
            }
          }
        }
      }
      console.log('FII entries:', result.fii.length, 'DII entries:', result.dii.length);
    } catch(e) { console.log('MC FII/DII failed:', e.message); }

    // Fallback: Generate from NSDL
    if (result.fii.length === 0) {
      try {
        var nHtml = await fetchText('https://www.fpi.nsdl.co.in/web/StaticReports/Fortnightly/FPIFortnightlyReport.html', 'https://www.fpi.nsdl.co.in/');
        var trR = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        var trM;
        while ((trM = trR.exec(nHtml)) !== null && result.fii.length < 10) {
          var tdR = /<td[^>]*>([\s\S]*?)<\/td>/gi;
          var cells2 = [];
          var td2;
          while ((td2 = tdR.exec(trM[1])) !== null) cells2.push(strip(td2[1]));
          if (cells2.length >= 3) {
            var nums2 = [];
            for (var c2 = 0; c2 < cells2.length; c2++) {
              var v2 = cells2[c2].replace(/[₹,()]/g, '').trim();
              if (/^-?\d+\.?\d*$/.test(v2)) nums2.push(parseFloat(v2));
            }
            if (nums2.length >= 2) {
              result.fii.push({ date: cells2[0], buy: nums2[0], sell: nums2[1], net: nums2[2] || (nums2[0]-nums2[1]) });
            }
          }
        }
        console.log('NSDL FII entries:', result.fii.length);
      } catch(e) { console.log('NSDL failed:', e.message); }
    }

    // Summary
    if (result.fii.length > 0) {
      result.summary.fiiNet = result.fii[0].net;
      result.summary.fiiStatus = result.fii[0].net >= 0 ? 'Buying' : 'Selling';
    }
    if (result.dii.length > 0) {
      result.summary.diiNet = result.dii[0].net;
      result.summary.diiStatus = result.dii[0].net >= 0 ? 'Buying' : 'Selling';
    }

    res.json(result);
  } catch(e) { res.json({ fii: [], dii: [], summary: {} }); }
});

// ============================================================
// /premarket — Pre-open Market Data (BSE + MC)
// ============================================================
app.get('/premarket', async (req, res) => {
  try {
    var stocks = [];

    // Try MC pre-open
    try {
      var html = await fetchText('https://www.moneycontrol.com/stocks/marketstats/pre_open/nifty.html', 'https://www.moneycontrol.com/');
      var trR = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      var trM;
      while ((trM = trR.exec(html)) !== null && stocks.length < 50) {
        var tdR = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        var cells = [];
        var td;
        while ((td = tdR.exec(trM[1])) !== null) cells.push(strip(td[1]));
        if (cells.length >= 3) {
          var name = cells[0];
          if (!name || name.length < 2 || /^(company|stock|name|sr|s\.no|#|symbol)/i.test(name)) continue;
          var nums = [];
          for (var c = 1; c < cells.length; c++) {
            var v = cells[c].replace(/[₹,%()]/g, '').replace(/,/g, '').trim();
            if (/^-?\d+\.?\d*$/.test(v)) nums.push(parseFloat(v));
          }
          if (nums.length >= 1) {
            var price = nums.find(function(n) { return n > 5; }) || 0;
            var change = 0;
            for (var i = nums.length - 1; i >= 0; i--) {
              if (Math.abs(nums[i]) < 100 && nums[i] !== price) { change = nums[i]; break; }
            }
            stocks.push({ stock: name, price: price, change: change, prevClose: 0 });
          }
        }
      }
      console.log('MC pre-market:', stocks.length);
    } catch(e) { console.log('MC premarket failed:', e.message); }

    res.json(stocks);
  } catch(e) { res.json([]); }
});

// ============================================================
// Health check
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SRJahir Stocks API v8',
    sources: { movers: 'BSE API + MC fallback', ipos: 'Moneycontrol + BSE', news: 'ET RSS', picks: 'ET Recos + Expert Views', '52week': 'BSE API', active: 'BSE API', fiidii: 'MC + NSDL', premarket: 'MC Pre-open' },
    endpoints: ['/news', '/movers', '/ipos/upcoming', '/ipos/recent', '/picks', '/52week', '/active', '/fiidii', '/premarket'],
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => console.log('SRJahir Stocks API v8 running on port ' + PORT));
