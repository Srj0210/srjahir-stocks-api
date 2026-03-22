const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// ============================================================
// HELPER: Fetch with browser-like headers
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
        catch(e) { reject(new Error('JSON parse failed: ' + data.substring(0, 100))); }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchText(url, referer) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': referer || 'https://www.bseindia.com/'
    };

    https.get(url, { headers, timeout: 15000 }, (res) => {
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

// ============================================================
// /movers — BSE India Official API (Government Source)
// Returns real CMP, Change%, stock names
// ============================================================
app.get('/movers', async (req, res) => {
  try {
    const BSE_BASE = 'https://api.bseindia.com/BseIndiaAPI/api';
    const REF = 'https://www.bseindia.com/';

    // Fetch gainers and losers in parallel
    const [gainersData, losersData] = await Promise.allSettled([
      fetchJSON(BSE_BASE + '/MktRG498498498/w?Ession=1&Gession=1', REF),
      fetchJSON(BSE_BASE + '/MktRGainer/w?GLession=2&Ession=1', REF)
    ]);

    let movers = [];

    // Try primary BSE endpoints
    if (gainersData.status === 'fulfilled' && Array.isArray(gainersData.value?.Table)) {
      gainersData.value.Table.slice(0, 25).forEach(g => {
        movers.push({
          stock: g.scrip_nm || g.scripname || '',
          price: parseFloat(g.ltradert || g.LTP || 0),
          change: parseFloat(g.Perchg || g.perchg || 0),
          pe: '', mcap: 0
        });
      });
    }

    if (losersData.status === 'fulfilled' && Array.isArray(losersData.value?.Table)) {
      losersData.value.Table.slice(0, 25).forEach(l => {
        movers.push({
          stock: l.scrip_nm || l.scripname || '',
          price: parseFloat(l.ltradert || l.LTP || 0),
          change: parseFloat(l.Perchg || l.perchg || 0),
          pe: '', mcap: 0
        });
      });
    }

    // Fallback: BSE Top Gainers/Losers alternative endpoint
    if (movers.length === 0) {
      try {
        const topData = await fetchJSON(
          BSE_BASE + '/StockReachGraph/w?scripcode=&flag=0&fromdate=&todate=&seession=&type=gainer',
          REF
        );
        if (Array.isArray(topData?.Table)) {
          topData.Table.slice(0, 30).forEach((g, i) => {
            movers.push({
              stock: g.scripname || g.scrip_nm || '',
              price: parseFloat(g.ltradert || g.LTP || 0),
              change: parseFloat(g.perchg || g.Perchg || 0),
              pe: '', mcap: 0
            });
          });
        }
      } catch(e2) { console.log('BSE fallback failed:', e2.message); }
    }

    // Fallback 2: BSE market snapshot
    if (movers.length === 0) {
      try {
        const snapData = await fetchJSON(
          BSE_BASE + '/getScripHeaderData/w?Ession=1&scripcode=500325',
          REF
        );
        console.log('BSE snap response type:', typeof snapData);
      } catch(e3) { console.log('BSE snap failed'); }
    }

    // Sort: positive change first (gainers), then negative (losers)
    movers.sort((a, b) => b.change - a.change);

    res.json(movers);
  } catch(e) {
    console.error('Movers error:', e.message);
    res.json([]);
  }
});

// ============================================================
// /ipos/upcoming — BSE IPO data (Official Source)
// ============================================================
app.get('/ipos/upcoming', async (req, res) => {
  try {
    // BSE IPO endpoint
    const BSE_IPO = 'https://api.bseindia.com/BseIndiaAPI/api/IPODetail/w?type=upcoming';
    let ipos = [];

    try {
      const data = await fetchJSON(BSE_IPO, 'https://www.bseindia.com/');
      if (Array.isArray(data)) {
        ipos = data.map(ipo => ({
          name: ipo.Issue_Name || ipo.company || '',
          issueType: ipo.Issue_Type || 'IPO',
          priceBand: ipo.Price_Band || ipo.price || '',
          openDate: ipo.Issue_Open || ipo.open || '',
          closeDate: ipo.Issue_Close || ipo.close || '',
          issueSize: ipo.Issue_Size || ''
        }));
      }
    } catch(bseErr) {
      console.log('BSE IPO failed:', bseErr.message);
    }

    // Fallback: NSE upcoming issues
    if (ipos.length === 0) {
      try {
        const nseData = await fetchJSON(
          'https://www.nseindia.com/api/ipo-current-issue',
          'https://www.nseindia.com/'
        );
        if (Array.isArray(nseData)) {
          ipos = nseData.map(ipo => ({
            name: ipo.companyName || '',
            issueType: ipo.issueType || 'IPO',
            priceBand: (ipo.minPrice || '') + '-' + (ipo.maxPrice || ''),
            openDate: ipo.issueStartDate || '',
            closeDate: ipo.issueEndDate || '',
            issueSize: ipo.issueSize || ''
          }));
        }
      } catch(nseErr) {
        console.log('NSE IPO failed:', nseErr.message);
      }
    }

    res.json(ipos);
  } catch(e) {
    console.error('IPOs upcoming error:', e.message);
    res.json([]);
  }
});

// ============================================================
// /ipos/recent — Recent listed IPOs from BSE
// ============================================================
app.get('/ipos/recent', async (req, res) => {
  try {
    const BSE_IPO = 'https://api.bseindia.com/BseIndiaAPI/api/IPODetail/w?type=recent';
    let ipos = [];

    try {
      const data = await fetchJSON(BSE_IPO, 'https://www.bseindia.com/');
      if (Array.isArray(data)) {
        ipos = data.map(ipo => ({
          name: ipo.Issue_Name || ipo.company || '',
          issueType: ipo.Issue_Type || 'IPO',
          priceBand: ipo.Price_Band || ipo.price || '',
          openDate: ipo.Issue_Open || ipo.open || '',
          closeDate: ipo.Issue_Close || ipo.close || '',
          issueSize: ipo.Issue_Size || ''
        }));
      }
    } catch(bseErr) {
      console.log('BSE recent IPO failed:', bseErr.message);
    }

    res.json(ipos);
  } catch(e) {
    console.error('IPOs recent error:', e.message);
    res.json([]);
  }
});

// ============================================================
// /picks — ET Recommendations (RSS - only non-govt source)
// ============================================================
app.get('/picks', async (req, res) => {
  try {
    const xml = await fetchText(
      'https://economictimes.indiatimes.com/markets/stocks/recos/rssfeeds/2146844.cms',
      'https://economictimes.indiatimes.com/'
    );

    const picks = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && picks.length < 10) {
      const block = match[1];
      const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]>/) || block.match(/<title>(.*?)<\/title>/) || [])[1] || '';
      const link = (block.match(/<link>(.*?)<\/link>/) || [])[1] || '';
      if (title) picks.push({ stock: title, reason: 'ET Recommend', link: link });
    }

    res.json(picks);
  } catch(e) {
    console.error('Picks error:', e.message);
    res.json([]);
  }
});

// ============================================================
// /news — ET Stock Market News RSS
// ============================================================
app.get('/news', async (req, res) => {
  try {
    const xml = await fetchText(
      'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms',
      'https://economictimes.indiatimes.com/'
    );

    const news = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && news.length < 20) {
      const block = match[1];
      const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]>/) || block.match(/<title>(.*?)<\/title>/) || [])[1] || '';
      const link = (block.match(/<link>(.*?)<\/link>/) || [])[1] || '';
      const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
      if (title) news.push({ headline: title, title: title, link: link, date: pubDate });
    }

    res.json(news);
  } catch(e) {
    console.error('News error:', e.message);
    res.json([]);
  }
});

// ============================================================
// Health check
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SRJahir Stocks API',
    source: 'BSE India (Government) + ET RSS',
    endpoints: ['/news', '/movers', '/ipos/upcoming', '/ipos/recent', '/picks'],
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => console.log('SRJahir Stocks API running on port ' + PORT));
