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

// ============================================================
// ROBUST TABLE PARSER — extracts rows from HTML tables
// Returns array of arrays (each sub-array = one row of cell text)
// ============================================================
function parseHTMLTable(html) {
  var rows = [];
  var trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  var trMatch;
  while ((trMatch = trRegex.exec(html)) !== null) {
    var tdRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    var cells = [];
    var td;
    while ((td = tdRegex.exec(trMatch[1])) !== null) {
      cells.push(strip(td[1]));
    }
    if (cells.length >= 2) rows.push(cells);
  }
  return rows;
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
// MOVERS PARSER — Extracts stocks from MC table HTML
// Improved: handles links inside cells, numeric detection
// ============================================================
function extractMovers(html) {
  var movers = [];
  var rows = parseHTMLTable(html);
  
  for (var r = 0; r < rows.length && movers.length < 30; r++) {
    var cells = rows[r];
    if (cells.length < 4) continue;
    
    // First cell = stock name (skip headers)
    var name = cells[0];
    if (!name || name.length < 2) continue;
    if (/^(company|stock|name|sr|s\.no|#|high|low)/i.test(name)) continue;
    
    // Find numeric cells for price and change%
    var price = 0, changePct = 0;
    var nums = [];
    for (var c = 1; c < cells.length; c++) {
      var val = cells[c].replace(/[₹,%()]/g, '').replace(/,/g, '').trim();
      if (/^-?\d+\.?\d*$/.test(val)) {
        nums.push({ idx: c, val: parseFloat(val) });
      }
    }
    
    // Typically: Price is the first large number, Change% is a small number
    if (nums.length >= 2) {
      // Find price (largest absolute value > 5)
      var priceNum = nums.find(n => Math.abs(n.val) > 5);
      if (priceNum) price = priceNum.val;
      
      // Find change% (between -100 and +100, different from price)
      var changeNum = nums.find(n => n !== priceNum && Math.abs(n.val) < 100);
      if (changeNum) changePct = changeNum.val;
      
      // If no good price found, use first number
      if (price === 0 && nums.length > 0) price = nums[0].val;
      if (changePct === 0 && nums.length > 1) {
        // Last number is often the %change
        var last = nums[nums.length - 1];
        if (Math.abs(last.val) < 100) changePct = last.val;
      }
    }
    
    if (name && (price > 0 || changePct !== 0)) {
      movers.push({ stock: name, price: price, change: changePct, pe: '', mcap: 0 });
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
// /movers — Moneycontrol Gainers + Losers (FIXED price extraction)
// ============================================================
app.get('/movers', async (req, res) => {
  try {
    var movers = [];

    // Source 1: MC Top Gainers
    try {
      var ghtml = await fetchText('https://www.moneycontrol.com/stocks/marketstats/nsegainer/index.php', 'https://www.moneycontrol.com/');
      var gainers = extractMovers(ghtml);
      console.log('MC gainers found:', gainers.length);
      movers = movers.concat(gainers);
    } catch(e) { console.log('MC gainers failed:', e.message); }

    // Source 2: MC Top Losers
    try {
      var lhtml = await fetchText('https://www.moneycontrol.com/stocks/marketstats/nseloser/index.php', 'https://www.moneycontrol.com/');
      var losers = extractMovers(lhtml);
      // Make sure losers have negative change
      losers.forEach(function(l) { if (l.change > 0) l.change = -l.change; });
      console.log('MC losers found:', losers.length);
      movers = movers.concat(losers);
    } catch(e) { console.log('MC losers failed:', e.message); }

    // Fallback: BSE API
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
      } catch(e) {}
    }

    // Sort: gainers first (high change), then losers
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

    // Try main MC IPO page
    try {
      var html = await fetchText('https://www.moneycontrol.com/ipo/', 'https://www.moneycontrol.com/');
      ipos = extractMCIpos(html);
      ipos = ipos.filter(function(i) {
        var s = (i.status || '').toLowerCase();
        return s === 'open' || s === 'upcoming';
      });
      console.log('MC upcoming IPOs found:', ipos.length);
    } catch(mcErr) { console.log('MC upcoming failed:', mcErr.message); }

    // Try upcoming-ipos page too
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

    // BSE fallback
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
// /ipos/recent — Moneycontrol listed + closed pages + BSE
// ============================================================
app.get('/ipos/recent', async (req, res) => {
  try {
    var ipos = [];

    // Try listed-ipos page
    try {
      var html = await fetchText('https://www.moneycontrol.com/ipo/listed-ipos/', 'https://www.moneycontrol.com/');
      ipos = extractMCIpos(html);
      console.log('MC listed IPOs found:', ipos.length);
    } catch(e) {}

    // Try main IPO page for closed ones
    if (ipos.length < 3) {
      try {
        var html2 = await fetchText('https://www.moneycontrol.com/ipo/', 'https://www.moneycontrol.com/');
        var all = extractMCIpos(html2);
        var closed = all.filter(function(i) {
          var s = (i.status || '').toLowerCase();
          return s === 'listed' || s === 'closed' || s === 'allotted';
        });
        closed.forEach(function(ipo) {
          var exists = ipos.some(function(e) { return e.name.substring(0,15) === ipo.name.substring(0,15); });
          if (!exists) ipos.push(ipo);
        });
      } catch(e) {}
    }

    // BSE fallback
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
      } catch(e) {}
    }

    res.json(ipos);
  } catch(e) {
    res.json([]);
  }
});

// ============================================================
// /picks — ET Recommendations RSS (FIXED: filter stock-specific)
// ============================================================
app.get('/picks', async (req, res) => {
  try {
    var picks = [];
    
    // Source 1: ET Stock Recommendations
    try {
      var xml = await fetchText(
        'https://economictimes.indiatimes.com/markets/stocks/recos/rssfeeds/2146844.cms',
        'https://economictimes.indiatimes.com/'
      );
      var items = parseRSSItems(xml);
      items.forEach(function(item) {
        // Filter: only stock-related picks (contains buy/sell/target/stock keywords)
        var t = item.title.toLowerCase();
        if (t.includes('buy') || t.includes('sell') || t.includes('target') || 
            t.includes('stock') || t.includes('share') || t.includes('invest') ||
            t.includes('nifty') || t.includes('market') || t.includes('rally') ||
            t.includes('bullish') || t.includes('bearish') || t.includes('portfolio')) {
          picks.push({ stock: item.title, reason: 'ET Recommend', link: item.link });
        }
      });
    } catch(e) {}

    // Source 2: ET Expert Views
    if (picks.length < 5) {
      try {
        var xml2 = await fetchText(
          'https://economictimes.indiatimes.com/markets/expert-view/rssfeeds/2146849.cms',
          'https://economictimes.indiatimes.com/'
        );
        var items2 = parseRSSItems(xml2);
        items2.slice(0, 10 - picks.length).forEach(function(item) {
          picks.push({ stock: item.title, reason: 'Expert View', link: item.link });
        });
      } catch(e) {}
    }

    // Source 3: Fallback to stock news
    if (picks.length < 5) {
      try {
        var xml3 = await fetchText(
          'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms',
          'https://economictimes.indiatimes.com/'
        );
        var items3 = parseRSSItems(xml3);
        items3.slice(0, 10 - picks.length).forEach(function(item) {
          var t = item.title.toLowerCase();
          if (t.includes('buy') || t.includes('target') || t.includes('stock pick') || t.includes('multibagger')) {
            picks.push({ stock: item.title, reason: 'Market News', link: item.link });
          }
        });
      } catch(e) {}
    }

    res.json(picks.slice(0, 12));
  } catch(e) {
    res.json([]);
  }
});

// ============================================================
// NEW: /52week — 52 Week High & Low stocks
// ============================================================
app.get('/52week', async (req, res) => {
  try {
    var result = { high: [], low: [] };

    // 52 Week Highs
    try {
      var hhtml = await fetchText('https://www.moneycontrol.com/stocks/marketstats/nsehigh/index.php', 'https://www.moneycontrol.com/');
      var hRows = parseHTMLTable(hhtml);
      for (var i = 0; i < hRows.length && result.high.length < 20; i++) {
        var cells = hRows[i];
        if (cells.length < 3) continue;
        var name = cells[0];
        if (!name || name.length < 2 || /^(company|stock|name|sr|s\.no|#)/i.test(name)) continue;
        var nums = [];
        for (var c = 1; c < cells.length; c++) {
          var val = cells[c].replace(/[₹,%()]/g, '').replace(/,/g, '').trim();
          if (/^-?\d+\.?\d*$/.test(val) && parseFloat(val) > 0) nums.push(parseFloat(val));
        }
        if (nums.length >= 1) {
          result.high.push({ stock: name, price: nums[0], high52: nums[1] || nums[0], change: nums.length > 2 ? nums[nums.length-1] : 0 });
        }
      }
      console.log('52W highs found:', result.high.length);
    } catch(e) { console.log('52W high failed:', e.message); }

    // 52 Week Lows
    try {
      var lhtml = await fetchText('https://www.moneycontrol.com/stocks/marketstats/nselow/index.php', 'https://www.moneycontrol.com/');
      var lRows = parseHTMLTable(lhtml);
      for (var i = 0; i < lRows.length && result.low.length < 20; i++) {
        var cells = lRows[i];
        if (cells.length < 3) continue;
        var name = cells[0];
        if (!name || name.length < 2 || /^(company|stock|name|sr|s\.no|#)/i.test(name)) continue;
        var nums = [];
        for (var c = 1; c < cells.length; c++) {
          var val = cells[c].replace(/[₹,%()]/g, '').replace(/,/g, '').trim();
          if (/^-?\d+\.?\d*$/.test(val) && parseFloat(val) > 0) nums.push(parseFloat(val));
        }
        if (nums.length >= 1) {
          result.low.push({ stock: name, price: nums[0], low52: nums[1] || nums[0], change: nums.length > 2 ? nums[nums.length-1] : 0 });
        }
      }
      console.log('52W lows found:', result.low.length);
    } catch(e) { console.log('52W low failed:', e.message); }

    res.json(result);
  } catch(e) {
    res.json({ high: [], low: [] });
  }
});

// ============================================================
// NEW: /active — Most Active Stocks by Volume
// ============================================================
app.get('/active', async (req, res) => {
  try {
    var stocks = [];

    try {
      var html = await fetchText('https://www.moneycontrol.com/stocks/marketstats/nsemact1/index.php', 'https://www.moneycontrol.com/');
      var rows = parseHTMLTable(html);
      for (var i = 0; i < rows.length && stocks.length < 25; i++) {
        var cells = rows[i];
        if (cells.length < 3) continue;
        var name = cells[0];
        if (!name || name.length < 2 || /^(company|stock|name|sr|s\.no|#)/i.test(name)) continue;
        var nums = [];
        for (var c = 1; c < cells.length; c++) {
          var val = cells[c].replace(/[₹,%()]/g, '').replace(/,/g, '').trim();
          if (/^-?\d+\.?\d*$/.test(val)) nums.push(parseFloat(val));
        }
        if (nums.length >= 2) {
          stocks.push({
            stock: name,
            price: nums[0] > 5 ? nums[0] : 0,
            volume: nums.find(n => n > 10000) || 0,
            change: nums.find(n => Math.abs(n) < 100 && n !== nums[0]) || 0
          });
        }
      }
      console.log('Most active found:', stocks.length);
    } catch(e) { console.log('Active stocks failed:', e.message); }

    res.json(stocks);
  } catch(e) {
    res.json([]);
  }
});

// ============================================================
// NEW: /fiidii — FII/DII Activity Data
// ============================================================
app.get('/fiidii', async (req, res) => {
  try {
    var result = { fii: [], dii: [], summary: {} };

    // Try Moneycontrol FII/DII page
    try {
      var html = await fetchText('https://www.moneycontrol.com/stocks/marketstats/fii_dii_activity/index.php', 'https://www.moneycontrol.com/');
      var rows = parseHTMLTable(html);
      
      for (var i = 0; i < rows.length; i++) {
        var cells = rows[i];
        if (cells.length < 3) continue;
        var label = cells[0].toLowerCase();
        
        // Look for FII/FPI rows
        if (label.includes('fii') || label.includes('fpi') || label.includes('foreign')) {
          var nums = [];
          for (var c = 1; c < cells.length; c++) {
            var val = cells[c].replace(/[₹,()]/g, '').trim();
            if (/^-?\d+\.?\d*$/.test(val)) nums.push(parseFloat(val));
          }
          if (nums.length >= 2) {
            result.fii.push({
              date: cells[0],
              buy: nums[0] || 0,
              sell: nums[1] || 0,
              net: nums[2] || (nums[0] - nums[1])
            });
          }
        }
        
        // Look for DII rows
        if (label.includes('dii') || label.includes('domestic') || label.includes('mutual')) {
          var nums2 = [];
          for (var c = 1; c < cells.length; c++) {
            var val = cells[c].replace(/[₹,()]/g, '').trim();
            if (/^-?\d+\.?\d*$/.test(val)) nums2.push(parseFloat(val));
          }
          if (nums2.length >= 2) {
            result.dii.push({
              date: cells[0],
              buy: nums2[0] || 0,
              sell: nums2[1] || 0,
              net: nums2[2] || (nums2[0] - nums2[1])
            });
          }
        }
      }
      console.log('FII entries:', result.fii.length, 'DII entries:', result.dii.length);
    } catch(e) { console.log('FII/DII MC failed:', e.message); }

    // Fallback: NSDL FPI data
    if (result.fii.length === 0) {
      try {
        var nsdlHtml = await fetchText('https://www.fpi.nsdl.co.in/web/StaticReports/Fortnightly/FPIFortnightlyReport.html', 'https://www.fpi.nsdl.co.in/');
        var nsdlRows = parseHTMLTable(nsdlHtml);
        for (var i = 0; i < nsdlRows.length && result.fii.length < 10; i++) {
          var cells = nsdlRows[i];
          if (cells.length >= 3) {
            var nums = [];
            for (var c = 0; c < cells.length; c++) {
              var val = cells[c].replace(/[₹,()]/g, '').trim();
              if (/^-?\d+\.?\d*$/.test(val)) nums.push(parseFloat(val));
            }
            if (nums.length >= 2) {
              result.fii.push({ date: cells[0], buy: nums[0], sell: nums[1], net: nums[2] || (nums[0]-nums[1]) });
            }
          }
        }
      } catch(e) {}
    }

    // Summary
    if (result.fii.length > 0) {
      var lastFii = result.fii[0];
      result.summary.fiiNet = lastFii.net;
      result.summary.fiiStatus = lastFii.net >= 0 ? 'Buying' : 'Selling';
    }
    if (result.dii.length > 0) {
      var lastDii = result.dii[0];
      result.summary.diiNet = lastDii.net;
      result.summary.diiStatus = lastDii.net >= 0 ? 'Buying' : 'Selling';
    }

    res.json(result);
  } catch(e) {
    res.json({ fii: [], dii: [], summary: {} });
  }
});

// ============================================================
// NEW: /premarket — Pre-market / Opening Stocks Data
// Source: Moneycontrol pre-open market data
// ============================================================
app.get('/premarket', async (req, res) => {
  try {
    var stocks = [];

    // Try MC pre-open market page
    try {
      var html = await fetchText('https://www.moneycontrol.com/stocks/marketstats/pre_open/nifty.html', 'https://www.moneycontrol.com/');
      var rows = parseHTMLTable(html);
      for (var i = 0; i < rows.length && stocks.length < 30; i++) {
        var cells = rows[i];
        if (cells.length < 3) continue;
        var name = cells[0];
        if (!name || name.length < 2 || /^(company|stock|name|sr|s\.no|#|symbol)/i.test(name)) continue;
        var nums = [];
        for (var c = 1; c < cells.length; c++) {
          var val = cells[c].replace(/[₹,%()]/g, '').replace(/,/g, '').trim();
          if (/^-?\d+\.?\d*$/.test(val)) nums.push(parseFloat(val));
        }
        if (nums.length >= 2) {
          var price = nums.find(n => n > 5) || 0;
          var change = nums.find(n => Math.abs(n) < 100 && n !== price) || 0;
          stocks.push({ stock: name, price: price, change: change, prevClose: 0 });
        }
      }
      console.log('Pre-market stocks found:', stocks.length);
    } catch(e) { console.log('Pre-market MC failed:', e.message); }

    // Fallback: BSE pre-open
    if (stocks.length === 0) {
      try {
        var bseHtml = await fetchText('https://www.bseindia.com/markets/equity/EQReports/pre-open.html', 'https://www.bseindia.com/');
        var bseRows = parseHTMLTable(bseHtml);
        for (var i = 0; i < bseRows.length && stocks.length < 30; i++) {
          var cells = bseRows[i];
          if (cells.length < 3) continue;
          var name = cells[0];
          if (!name || name.length < 2 || /^(company|stock|name|sr)/i.test(name)) continue;
          var nums = [];
          for (var c = 1; c < cells.length; c++) {
            var val = cells[c].replace(/[₹,%()]/g, '').replace(/,/g, '').trim();
            if (/^-?\d+\.?\d*$/.test(val)) nums.push(parseFloat(val));
          }
          if (nums.length >= 1) {
            stocks.push({ stock: name, price: nums[0], change: nums.length > 1 ? nums[nums.length-1] : 0, prevClose: 0 });
          }
        }
      } catch(e) {}
    }

    res.json(stocks);
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
    service: 'SRJahir Stocks API v7',
    sources: {
      movers: 'Moneycontrol + BSE fallback',
      ipos: 'Moneycontrol + BSE fallback',
      news: 'Economic Times RSS',
      picks: 'ET Recommendations + Expert Views',
      '52week': 'Moneycontrol 52W High/Low',
      active: 'Moneycontrol Most Active',
      fiidii: 'Moneycontrol FII/DII + NSDL',
      premarket: 'Moneycontrol Pre-open'
    },
    endpoints: ['/news', '/movers', '/ipos/upcoming', '/ipos/recent', '/picks', '/52week', '/active', '/fiidii', '/premarket'],
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => console.log('SRJahir Stocks API v7 running on port ' + PORT));
