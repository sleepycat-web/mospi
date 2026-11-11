// Builds data.json for AnkSetu from the live MoSPI API (api.mospi.gov.in).
//
// Blocks sent (each is optional and independent; a failure in one never affects the others):
//   cpi    retail inflation: headline, index, food, 12 divisions, 36 states, top/bottom 5 items
//   iip    industrial output: overall, index, 3 sectors, 6 use-based, 23 NIC manufacturing groups
//   gdp    quarterly GDP: real/GVA/nominal growth, level, 3 broad sectors, 8 industries
//   plfs   monthly PLFS (All India): unemployment, LFPR, WPR by sex and rural/urban
//   plfsq  quarterly PLFS bulletin: LFPR, female LFPR, WPR for 22 states
//   peers  "states like X" k-means groupings, recomputed from the state tables above
//
// The app validates every block and only accepts periods at or after its embedded snapshot,
// so this always sends the latest data; there is nothing to keep in sync by hand.

const https = require('https');
const crypto = require('crypto');

const API = 'https://api.mospi.gov.in';
const SRC_URL = 'https://www.mospi.gov.in/';

// api.mospi.gov.in requires legacy TLS renegotiation, which Node's fetch refuses.
// This agent allows only that; certificate verification stays on.
const agent = new https.Agent({ keepAlive: true, maxSockets: 8, secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT });
function getJSON(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent, headers: { Accept: 'application/json' } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; if (buf.length > 8e6) req.destroy(new Error('response too large')); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${url}`));
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout ' + url)));
    req.on('error', reject);
  });
}

// MoSPI's server occasionally drops or stalls a connection; retry network errors and timeouts twice.
async function getRetry(url) {
  for (let attempt = 1; ; attempt++) {
    try { return await getJSON(url, attempt === 1 ? 12000 : 15000); }
    catch (e) {
      if (attempt >= 3 || /^HTTP 4/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
}

// Fetches every page of a paginated endpoint (page 1 first, the rest in parallel).
async function get(path, params, maxPages = 20) {
  const page = (p) => getRetry(`${API}${path}?${new URLSearchParams({ ...params, limit: '100', page: String(p) })}`);
  const first = await page(1);
  if (first && first.error) throw new Error(`${path}: ${first.error}`);
  const rows = Array.isArray(first.data) ? [...first.data] : [];
  const pages = Math.min((first.meta_data && first.meta_data.totalPages) || 1, maxPages);
  if (pages > 1) {
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => page(i + 2)));
    rest.forEach((j) => { if (Array.isArray(j.data)) rows.push(...j.data); });
  }
  return rows;
}

// ---------------------------------------------------------------- helpers
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const mIdx = (name) => MONTHS.indexOf(name) + 1;
const num = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const today = () => new Date().toISOString().slice(0, 10);
const cmpYM = (a, b) => (a.y - b.y) * 12 + (a.m - b.m);
const prevYM = (o) => (o.m === 1 ? { y: o.y - 1, m: 12 } : { y: o.y, m: o.m - 1 });
const cmpFQ = (a, b) => (a.fy - b.fy) * 4 + (a.q - b.q);
const fyStr = (fy) => `${fy}-${String((fy + 1) % 100).padStart(2, '0')}`;
const pad = (n) => String(n).padStart(2, '0');
const nowY = () => new Date().getUTCFullYear();
// Approximate release date `months` after the reference month, on `day`; never later than today.
function relDate(y, m, months, day) {
  const t = y * 12 + (m - 1) + months;
  const d = `${Math.floor(t / 12)}-${pad((t % 12) + 1)}-${pad(day)}`;
  return d > today() ? today() : d;
}
// Last month of a fiscal quarter: Q1 Apr-Jun → June of fy, ..., Q4 Jan-Mar → March of fy+1.
const fqEnd = (p) => (p.q === 4 ? { y: p.fy + 1, m: 3 } : { y: p.fy, m: 3 + p.q * 3 });
const head = (period, rel) => ({ source: 'api', asOf: today(), rel, url: SRC_URL, period });

// ---------------------------------------------------------------- CPI
const CPI_BASE = { base_year: '2024', series: 'Current' };
// API CPI state_code -> app state code (API codes 2..37 are alphabetical, same order as the app).
const CPI_STATES = ['AN','AP','AR','AS','BR','CH','CG','GA','GJ','HR','HP','JK','JH','KA','KL','LA','LD','MP','MH','MN','ML','MZ','NL','DL','OD','PY','PB','RJ','SK','TN','TG','DD','TR','UP','UK','WB'];
// App CPI division codes -> API division_code
const CPI_DIV = { '01':1,'02':2,'03':3,'04':4,'05':5,'06':6,'07':7,'08':8,'09':9,'10':10,'11':11,'13':12 };
// API item names whose app ids carry Hindi names and search keywords.
const CPI_ITEM_IDS = { 'onion':'onion', 'tomato':'tomato', 'potato':'potato', 'garlic':'garlic', 'ginger':'ginger', 'lemon':'lemon', 'coconut':'coconut', "lady's finger":'ladyfinger', 'silver jewellery':'silver', 'motor car and jeep':'car', 'motor car, jeep':'car' };
// Hindi names for items that often appear among the biggest movers (others fall back to English).
const CPI_ITEM_HI = {
  'coconut oil': 'नारियल तेल', 'peas, chickpeas': 'मटर, चना', 'cauliflower': 'फूलगोभी', 'cabbage': 'पत्तागोभी', 'brinjal': 'बैंगन',
  'green chilli': 'हरी मिर्च', 'banana': 'केला', 'apple': 'सेब', 'rice': 'चावल', 'wheat': 'गेहूँ', 'milk': 'दूध', 'sugar': 'चीनी',
  'mustard oil': 'सरसों का तेल', 'gold': 'सोना', 'gold jewellery': 'सोने के गहने', 'arhar, tur': 'अरहर (तूर)', 'moong': 'मूंग',
  'gram': 'चना', 'masur': 'मसूर', 'urad': 'उड़द', 'cucumber': 'खीरा', 'carrot': 'गाजर', 'spinach': 'पालक', 'pumpkin': 'कद्दू',
  'cauliflower, cabbage': 'फूलगोभी, पत्तागोभी', 'grapes': 'अंगूर', 'mango': 'आम', 'orange': 'संतरा', 'eggs': 'अंडे', 'chicken': 'चिकन'
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'item';

let _cpiFilters;
async function cpiFilters() {
  if (!_cpiFilters) _cpiFilters = (await getRetry(`${API}/api/cpi/getCpiFilterByLevelAndBaseYear?base_year=2024&level=null&series_code=Current`)).data[0];
  return _cpiFilters;
}

async function cpiBlock() {
  const y = nowY();
  const rows = await get('/api/cpi/getCPIData', { ...CPI_BASE, year: `${y - 1},${y}`, state_code: '1', division_code: '0' });
  if (!rows.length) return null;
  const latest = rows.map((r) => ({ y: +r.year, m: mIdx(r.month) })).filter((p) => p.m > 0).sort((a, b) => cmpYM(b, a))[0];
  const prev = prevYM(latest);
  const at = (p, sector) => rows.find((r) => +r.year === p.y && mIdx(r.month) === p.m && r.sector === sector);
  const S = { all: 'Combined', rural: 'Rural', urban: 'Urban' };
  const headline = {}, index = {};
  for (const k of Object.keys(S)) {
    const c = at(latest, S[k]), p = at(prev, S[k]);
    if (!c || !p || num(c.inflation) === null || num(p.inflation) === null) return null;
    headline[k] = [num(c.inflation), num(p.inflation)];
    index[k] = num(c.index);
  }
  const block = { ...head(latest, relDate(latest.y, latest.m, 1, 12)), data: { headline, index } };
  const month = { year: String(latest.y), month_code: String(latest.m) };

  const [food, div, states, items] = await Promise.allSettled([
    // Food inflation = CPI group "Food" (01.1), latest and previous month
    (async () => {
      const fr = await get('/api/cpi/getCPIData', { ...CPI_BASE, year: [...new Set([prev.y, latest.y])].join(','), month_code: `${prev.m},${latest.m}`, state_code: '1', division_code: '1' });
      const g = (p, sec) => num((fr.find((r) => +r.year === p.y && mIdx(r.month) === p.m && r.sector === sec && r.group === 'Food' && !r.class) || {}).inflation);
      const o = {};
      for (const k of Object.keys(S)) { o[k] = [g(latest, S[k]), g(prev, S[k])]; if (o[k].includes(null)) throw new Error('food ' + k); }
      return o;
    })(),
    // 12 divisions [rural, urban, combined]
    (async () => {
      const f = await cpiFilters();
      const names = Object.fromEntries(f.division.map((d) => [d.division_code, d.division_name]));
      const dr = await get('/api/cpi/getCPIData', { ...CPI_BASE, ...month, state_code: '1', division_code: Object.values(CPI_DIV).join(',') });
      const out = {};
      for (const [code, apiCode] of Object.entries(CPI_DIV)) {
        const g = (sec) => num((dr.find((r) => r.division === names[apiCode] && r.sector === sec && !r.group && !r.class) || {}).inflation);
        const o = { r: g('Rural'), u: g('Urban'), a: g('Combined') };
        if (o.r === null || o.u === null || o.a === null) throw new Error('div ' + code);
        out[code] = o;
      }
      return out;
    })(),
    // States [rural, urban, combined]
    (async () => {
      const f = await cpiFilters();
      const stateNames = Object.fromEntries(f.state.map((s) => [s.state_code, s.state_name]));
      const sr = await get('/api/cpi/getCPIData', { ...CPI_BASE, ...month, division_code: '0' });
      const tri = (st) => ['Rural', 'Urban', 'Combined'].map((sec) => { const r = sr.find((x) => x.state === st && x.sector === sec); return r ? num(r.inflation) : null; });
      const values = {};
      CPI_STATES.forEach((code, i) => { const t = tri(stateNames[i + 2]); if (t.some((v) => v !== null)) values[code] = t; });
      const india = tri('All India');
      if (Object.keys(values).length < 30 || india.includes(null)) throw new Error('states incomplete');
      return { india, values };
    })(),
    // Items: five biggest risers and five biggest fallers, all-India combined
    (async () => {
      const ir = await get('/api/cpi/getCPIData', { ...CPI_BASE, ...month, state_code: '1', sector_code: '3', division_code: Object.values(CPI_DIV).join(',') });
      const seen = new Set(), list = [];
      ir.filter((r) => r.item && num(r.inflation) !== null).forEach((r) => {
        const name = String(r.item).trim(); if (seen.has(name.toLowerCase())) return; seen.add(name.toLowerCase());
        list.push({ name, v: num(r.inflation) });
      });
      if (list.length < 20) throw new Error('items: only ' + list.length);
      list.sort((a, b) => b.v - a.v);
      const pick = [...list.slice(0, 5), ...list.slice(-5)];
      const ids = new Set();
      return pick.map((it) => {
        let id = CPI_ITEM_IDS[it.name.toLowerCase()] || slug(it.name);
        while (ids.has(id)) id = (id + '_x').slice(-30);
        ids.add(id);
        const o = { id, v: it.v, en: it.name.length > 60 ? it.name.slice(0, 57) + '...' : it.name };
        const hi = CPI_ITEM_HI[it.name.toLowerCase()];
        if (hi) o.hi = hi;
        return o;
      });
    })()
  ]);
  if (food.status === 'fulfilled') block.data.food = food.value;
  if (div.status === 'fulfilled') block.div = div.value;
  if (states.status === 'fulfilled') block.states = states.value;
  if (items.status === 'fulfilled') block.items = items.value;
  block._skipped = [['food', food], ['div', div], ['states', states], ['items', items]].filter((x) => x[1].status === 'rejected').map((x) => x[0] + ': ' + x[1].reason);
  return block;
}

// ---------------------------------------------------------------- IIP
const IIP_SECTORS = { 'Mining & Quarrying': 'Mining and quarrying', 'Manufacturing': 'Manufacturing', 'Electricity & Gas Supply': 'Electricity and gas supply' };
const IIP_USE = {
  'Capital Goods': 'Capital goods', 'Intermediate Goods': 'Intermediate goods', 'Consumer Durables': 'Consumer durables',
  'Infrastructure/ Construction Goods': 'Infrastructure and construction goods', 'Primary Goods': 'Primary goods',
  'Consumer Non-durables': 'Consumer non-durables'
};
// API manufacturing sub-categories -> NIC 2-digit codes used by the app
const IIP_NIC = {
  'Manufacture of Food Products': '10', 'Manufacture of Beverages': '11', 'Manufacture of Tobacco Products': '12',
  'Manufacture of Textiles': '13', 'Manufacture of Wearing Apparel': '14', 'Manufacture of Leather and Related Products': '15',
  'Manufacture of Wood and Products of Wood and Cork, Except Furniture; Manufacture of Articles of Straw and Plaiting Materials': '16',
  'Manufacture of Paper and Paper Products': '17', 'Printing and Reproduction of Recorded Media': '18',
  'Manufacture of Coke and Refined Petroleum Products': '19', 'Manufacture of Chemicals and Chemical Products': '20',
  'Manufacture of basic pharmaceutical products and pharmaceutical preparations': '21', 'Manufacture of Rubber and Plastics Products': '22',
  'Manufacture of Other Non-metallic Mineral Products': '23', 'Manufacture of Basic Metals': '24',
  'Manufacture of Fabricated Metal Products, Except Machinery and Equipment': '25', 'Manufacture of Computer, Electronic and Optical Products': '26',
  'Manufacture of Electrical Equipment': '27', 'Manufacture of Machinery and Equipment n.e.c.': '28',
  'Manufacture of Motor Vehicles, Trailers and Semi-trailers': '29', 'Manufacture of Other Transport Equipment': '30',
  'Manufacture of Furniture': '31', 'Other Manufacturing': '32'
};

async function iipBlock() {
  const y = nowY();
  const q = { base_year: '2022-23', frequency: 'Monthly' };
  const gen = await get('/api/iip/getIipData', { ...q, year: `${y - 1},${y}`, type: 'General' });
  if (!gen.length) return null;
  const at = (p) => gen.find((r) => +r.year === p.y && mIdx(r.month) === p.m);
  const latest = gen.map((r) => ({ y: +r.year, m: mIdx(r.month) })).sort((a, b) => cmpYM(b, a))[0];
  const ago = { y: latest.y - 1, m: latest.m };
  const cur = at(latest), prev = at(prevYM(latest));
  let yago = at(ago);
  if (!yago) yago = (await get('/api/iip/getIipData', { ...q, year: String(ago.y), month_code: String(ago.m), type: 'General' }))[0];
  if (!cur || !prev || !yago) return null;

  const mq = { ...q, year: String(latest.y), month_code: String(latest.m) };
  const [sec, use, secAgo] = await Promise.all([
    get('/api/iip/getIipData', { ...mq, type: 'Sectoral' }),
    get('/api/iip/getIipData', { ...mq, type: 'Use-based category' }),
    get('/api/iip/getIipData', { ...q, year: String(ago.y), month_code: String(ago.m), type: 'Sectoral' }).catch(() => [])
  ]);
  const sectors = {}, useOut = {};
  for (const [api, app] of Object.entries(IIP_SECTORS)) {
    const r = sec.find((x) => x.category === api && !x.sub_category);
    if (!r || num(r.growth_rate) === null) return null;
    sectors[app] = num(r.growth_rate);
  }
  for (const [api, app] of Object.entries(IIP_USE)) {
    const r = use.find((x) => x.category === api && !x.sub_category);
    if (!r || num(r.growth_rate) === null) return null;
    useOut[app] = num(r.growth_rate);
  }
  const block = {
    ...head(latest, relDate(latest.y, latest.m, 1, 28)),
    data: { overall: [num(cur.growth_rate), num(prev.growth_rate)], index: num(cur.index), indexYearAgo: num(yago.index), sectors, use: useOut }
  };

  // 23 NIC manufacturing groups (optional part): index [year ago, latest] and growth
  try {
    const mf = (rows, name) => rows.find((x) => x.category === 'Manufacturing' && (x.sub_category || '') === name);
    const groups = {};
    for (const [api, code] of Object.entries(IIP_NIC)) {
      const c = mf(sec, api), a = mf(secAgo, api);
      if (!c || !a || num(c.index) === null || num(a.index) === null || num(c.growth_rate) === null) throw new Error('nic ' + code);
      groups[code] = { i: [num(a.index), num(c.index)], g: num(c.growth_rate) };
    }
    const tc = mf(sec, ''), ta = mf(secAgo, '');
    if (!tc || !ta) throw new Error('nic total');
    block.groups = groups;
    block.total = { i: [num(ta.index), num(tc.index)], g: num(tc.growth_rate) };
  } catch (e) { block._skipped = ['groups: ' + e.message]; }
  return block;
}

// ---------------------------------------------------------------- GDP (NAS, quarterly)
const NAS_IND = {
  'Agriculture, Livestock, Forestry and Fishing': 'agri', 'Mining and Quarrying': 'mining', 'Manufacturing': 'manuf',
  'Electricity, Gas, Water Supply & Other Utility Services': 'util', 'Construction': 'constr',
  'Trade, Hotels, Transport, Communication & Services Related to Broadcasting': 'trade',
  'Financial, Real Estate & Professional Services': 'fin', 'Public Administration, Defence & Other Services': 'pub'
};
const BROAD = {
  'Primary sector': ['agri', 'mining'],
  'Secondary sector (industry)': ['manuf', 'util', 'constr'],
  'Tertiary sector (services)': ['trade', 'fin', 'pub']
};

async function gdpBlock() {
  const now = new Date(), fyNow = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  // One indicator per call: the API rejects several indicators combined with several years.
  const years = [fyNow - 2, fyNow - 1, fyNow].map(fyStr).join(',');
  const rows = (await Promise.all(['1', '5', '21', '22'].map((ic) =>
    get('/api/nas/getNASData', { base_year: '2022-23', series: 'Current', frequency_code: 'Quarterly', indicator_code: ic, year: years })))).flat();
  const fq = (r) => ({ fy: parseInt(r.year, 10), q: parseInt(String(r.quarter).replace(/\D/g, ''), 10) });
  const growth = rows.filter((r) => r.indicator === 'GDP Growth Rate' && num(r.constant_price) !== null);
  if (!growth.length) return null;
  const latest = growth.map(fq).sort((a, b) => cmpFQ(b, a))[0];
  const ago = { fy: latest.fy - 1, q: latest.q }, ago2 = { fy: latest.fy - 2, q: latest.q };
  const find = (ind, p, industry) => rows.find((r) => r.indicator === ind && cmpFQ(fq(r), p) === 0 && (industry === undefined || r.industry === industry));
  const v = (r, price = 'constant_price') => (r ? num(r[price]) : null);

  const gC = find('GDP Growth Rate', latest), gA = find('GDP Growth Rate', ago);
  const vC = find('GVA Growth Rate', latest, 'Total Gross Value Added'), vA = find('GVA Growth Rate', ago, 'Total Gross Value Added');
  const lvl = find('Gross Domestic Product', latest);
  const real = [v(gC), v(gA)], nominal = [v(gC, 'current_price'), v(gA, 'current_price')], gva = [v(vC), v(vA)];
  if ([...real, ...nominal, ...gva, v(lvl)].includes(null)) return null;

  // Industry levels (constant prices) for the latest quarter and the same quarter one and two years earlier
  const L = {};
  for (const [api, id] of Object.entries(NAS_IND)) {
    L[id] = [ago2, ago, latest].map((p) => v(find('Gross Value Added', p, api)));
  }
  const sectors = {};
  for (const [name, ids] of Object.entries(BROAD)) {
    const sum = (i) => ids.reduce((s, id) => s + (L[id][i] === null ? NaN : L[id][i]), 0);
    const cur = r1((sum(2) / sum(1) - 1) * 100), prev = r1((sum(1) / sum(0) - 1) * 100);
    if (!Number.isFinite(cur) || !Number.isFinite(prev)) return null;
    sectors[name] = [cur, prev];
  }
  const block = {
    ...head(latest, relDate(fqEnd(latest).y, fqEnd(latest).m, 2, 28)),
    data: { real, gva, nominal, level: r2(v(lvl) / 1e5), sectors }
  };

  // Industry detail (optional part): l = [level a year ago, latest level], g = [latest growth, growth a year ago]
  try {
    const industry = {};
    for (const [api, id] of Object.entries(NAS_IND)) {
      const g = [v(find('GVA Growth Rate', latest, api)), v(find('GVA Growth Rate', ago, api))];
      const l = [L[id][1], L[id][2]];
      if ([...g, ...l].includes(null)) throw new Error('industry ' + id);
      industry[id] = { l, g };
    }
    block.industry = industry;
  } catch (e) { block._skipped = ['industry: ' + e.message]; }
  return block;
}

// ---------------------------------------------------------------- PLFS monthly (All India, age 15+)
const PLFS_KEYS = {
  all: ['person', 'rural + urban'], rural: ['person', 'rural'], urban: ['person', 'urban'],
  male: ['male', 'rural + urban'], female: ['female', 'rural + urban'],
  ruralMale: ['male', 'rural'], ruralFemale: ['female', 'rural'], urbanMale: ['male', 'urban'], urbanFemale: ['female', 'urban']
};
const PLFS_SHAPE = {
  ur: ['all', 'rural', 'urban', 'male', 'female', 'ruralMale', 'ruralFemale', 'urbanMale', 'urbanFemale'],
  lfpr: ['all', 'rural', 'urban', 'female', 'ruralFemale', 'urbanFemale'],
  wpr: ['all', 'rural', 'urban', 'male', 'female', 'urbanFemale']
};

async function plfsBlock() {
  const y = nowY();
  const [lfpr, wpr, ur] = await Promise.all([1, 2, 3].map((ic) =>
    get('/api/plfs/getData', { indicator_code: String(ic), frequency_code: '3', year: `${y - 1},${y}`, state_code: '99', age_code: '1' })));
  const T = { lfpr, wpr, ur };
  const ym = (r) => ({ y: +r.year, m: mIdx(r.month) });
  const base = ur.filter((r) => r.gender === 'person' && r.sector === 'rural + urban' && num(r.value) !== null);
  if (!base.length) return null;
  const latest = base.map(ym).sort((a, b) => cmpYM(b, a))[0], prev = prevYM(latest);
  const val = (rows, p, [gender, sector]) => num((rows.find((r) => cmpYM(ym(r), p) === 0 && r.gender === gender && r.sector === sector) || {}).value);
  const data = {};
  for (const [f, keys] of Object.entries(PLFS_SHAPE)) {
    data[f] = {};
    for (const k of keys) data[f][k] = [val(T[f], latest, PLFS_KEYS[k]), val(T[f], prev, PLFS_KEYS[k])];
    if (data[f].all.includes(null)) return null;
  }
  return { ...head(latest, relDate(latest.y, latest.m, 1, 15)), data };
}

// ---------------------------------------------------------------- PLFS quarterly bulletin (states, age 15+)
const PLFS_STATES = {
  'Andhra Pradesh': 'AP', 'Assam': 'AS', 'Bihar': 'BR', 'Chhattisgarh': 'CG', 'Delhi': 'DL', 'Gujarat': 'GJ', 'Haryana': 'HR',
  'Himachal Pradesh': 'HP', 'Jammu & Kashmir': 'JK', 'Jharkhand': 'JH', 'Karnataka': 'KA', 'Kerala': 'KL', 'Madhya Pradesh': 'MP',
  'Maharashtra': 'MH', 'Odisha': 'OD', 'Punjab': 'PB', 'Rajasthan': 'RJ', 'Tamil Nadu': 'TN', 'Telangana': 'TG',
  'Uttarakhand': 'UK', 'Uttar Pradesh': 'UP', 'West Bengal': 'WB'
};
// Bulletin quarter (calendar year + months) -> fiscal quarter, and the API's quarter_code
const QTR = { 'Apr-Jun': { q: 1, dy: 0, code: 5 }, 'Jul-Sep': { q: 2, dy: 0, code: 2 }, 'Oct-Dec': { q: 3, dy: 0, code: 3 }, 'Jan-Mar': { q: 4, dy: -1, code: 4 } };

async function plfsqBlock() {
  const y = nowY();
  const idx = await get('/api/plfs/getData', { indicator_code: '1', frequency_code: '2', year: `${y - 1},${y}`, state_code: '99', gender_code: '3', age_code: '1', sector_code: '3' });
  const cand = idx.filter((r) => QTR[r.quarter] && num(r.value) !== null)
    .map((r) => ({ cal: +r.year, desc: r.quarter, p: { fy: +r.year + QTR[r.quarter].dy, q: QTR[r.quarter].q } }))
    .sort((a, b) => cmpFQ(b.p, a.p));
  if (!cand.length) return null;
  const { cal, desc, p } = cand[0];
  const [lf, wp] = await Promise.all([1, 2].map((ic) =>
    get('/api/plfs/getData', { indicator_code: String(ic), frequency_code: '2', year: String(cal), quarter_code: String(QTR[desc].code), gender_code: '2,3', age_code: '1' })));
  const tri = (rows, state, gender) => ['rural', 'urban', 'rural + urban'].map((sec) =>
    num((rows.find((r) => r.state === state && r.gender === gender && r.sector === sec && r.quarter === desc) || {}).value));
  const table = (rows, gender) => {
    const o = {};
    for (const [name, code] of Object.entries(PLFS_STATES)) { const t = tri(rows, name, gender); if (t.some((x) => x !== null)) o[code] = t; }
    return o;
  };
  const states = { lfpr: table(lf, 'person'), lfprF: table(lf, 'female'), wpr: table(wp, 'person') };
  const india = { lfpr: tri(lf, 'All India', 'person'), lfprF: tri(lf, 'All India', 'female'), wpr: tri(wp, 'All India', 'person') };
  for (const t of Object.keys(states)) if (Object.keys(states[t]).length < 15 || india[t].includes(null)) return null;
  return { ...head(p, relDate(fqEnd(p).y, fqEnd(p).m, 2, 15)), india, states };
}

// ---------------------------------------------------------------- "States like X" (k-means)
// Mirrors the method in the app: k-means on z-scored features; k = the largest of 2..5 whose silhouette
// is within 0.02 of the best and whose smallest group has at least 3 states; 200 restarts, seed 7.
const PEER_METHOD = 'k-means on z-scored features; k = the largest of 2..5 whose silhouette is within 0.02 of the best and whose smallest group has at least 3 states; 200 restarts, seed 7';
const LENS_NAMES = {
  prices: { en: ['Rural inflation', 'Urban inflation', 'Combined inflation'], hi: ['ग्रामीण महँगाई', 'शहरी महँगाई', 'संयुक्त महँगाई'] },
  labour: { en: ['Labour force participation', 'Women in the labour force', 'Worker population ratio'], hi: ['श्रम बल भागीदारी', 'श्रम बल में महिलाएँ', 'कार्यकर्ता जनसंख्या अनुपात'] }
};
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const dist = (a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0));
function kmeans(Z, k, rand) {
  let best = null;
  for (let rep = 0; rep < 200; rep++) {
    // k-means++ seeding
    const C = [Z[Math.floor(rand() * Z.length)]];
    while (C.length < k) {
      const d2 = Z.map((z) => Math.min(...C.map((c) => dist(z, c) ** 2)));
      let t = rand() * d2.reduce((a, b) => a + b, 0), i = 0;
      while (i < Z.length - 1 && (t -= d2[i]) > 0) i++;
      C.push(Z[i]);
    }
    let lab = [];
    for (let it = 0; it < 100; it++) {
      const nl = Z.map((z) => C.reduce((bi, c, ci) => (dist(z, c) < dist(z, C[bi]) ? ci : bi), 0));
      if (nl.join() === lab.join()) break;
      lab = nl;
      for (let ci = 0; ci < k; ci++) {
        const m = Z.filter((_, i) => lab[i] === ci);
        if (m.length) C[ci] = m[0].map((_, d) => m.reduce((s, z) => s + z[d], 0) / m.length);
      }
    }
    const inertia = Z.reduce((s, z, i) => s + dist(z, C[lab[i]]) ** 2, 0);
    if (!best || inertia < best.inertia - 1e-12) best = { lab, inertia };
  }
  return best.lab;
}
function silhouette(Z, lab, k) {
  let s = 0;
  Z.forEach((z, i) => {
    const mean = (c) => { const o = Z.filter((_, j) => j !== i && lab[j] === c); return o.length ? o.reduce((a, w) => a + dist(z, w), 0) / o.length : 0; };
    if (Z.filter((_, j) => lab[j] === lab[i]).length === 1) return;
    const a = mean(lab[i]);
    const b = Math.min(...Array.from({ length: k }, (_, c) => c).filter((c) => c !== lab[i] && lab.includes(c)).map(mean));
    s += (b - a) / Math.max(a, b);
  });
  return s / Z.length;
}
function peerLens(features, names) {
  const codes = Object.keys(features);
  const X = codes.map((c) => features[c]);
  const mean = [0, 1, 2].map((d) => X.reduce((s, x) => s + x[d], 0) / X.length);
  const sd = [0, 1, 2].map((d) => Math.sqrt(X.reduce((s, x) => s + (x[d] - mean[d]) ** 2, 0) / X.length) || 1);
  const Z = X.map((x) => x.map((v, d) => (v - mean[d]) / sd[d]));
  const rand = rng(7), runs = [];
  for (let k = 2; k <= 5 && k < codes.length; k++) {
    const lab = kmeans(Z, k, rand);
    const sizes = Array.from({ length: k }, (_, c) => lab.filter((l) => l === c).length);
    runs.push({ k, lab, sil: silhouette(Z, lab, k), minSize: Math.min(...sizes) });
  }
  const top = Math.max(...runs.map((r) => r.sil));
  const ok = runs.filter((r) => r.sil >= top - 0.02 && r.minSize >= 3);
  const run = ok.length ? ok[ok.length - 1] : runs.find((r) => r.sil === top);
  // Number groups by their mean on the first feature, highest first
  const order = Array.from({ length: run.k }, (_, c) => c)
    .map((c) => ({ c, m: X.filter((_, i) => run.lab[i] === c) }))
    .map((g) => ({ ...g, means: [0, 1, 2].map((d) => g.m.reduce((s, x) => s + x[d], 0) / g.m.length) }))
    .sort((a, b) => b.means[0] - a.means[0]);
  const assign = {}, groups = order.map((g, gi) => {
    const members = codes.filter((_, i) => run.lab[i] === g.c);
    members.forEach((c) => { assign[c] = gi + 1; });
    return { id: gi + 1, members, means: g.means.map(r2) };
  });
  const neighbors = {};
  codes.forEach((c, i) => {
    neighbors[c] = codes.map((o, j) => [o, dist(Z[i], Z[j])]).filter((x) => x[0] !== c).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([o, d]) => [o, r2(d)]);
  });
  return { k: run.k, silhouette: r3(run.sil), n: codes.length, names_en: names.en, names_hi: names.hi, mean: mean.map(r3), sd: sd.map(r3), assign, groups, neighbors, features };
}
// Only sent when both state tables come from this same response, so the groupings match what the app shows.
function peersFrom(cpi, plfsq) {
  if (!cpi || !cpi.states || !plfsq) return null;
  const complete = (t) => Array.isArray(t) && t.length === 3 && t.every((x) => typeof x === 'number');
  const prices = {}, labour = {};
  for (const [c, t] of Object.entries(cpi.states.values)) if (complete(t)) prices[c] = t;
  const S = plfsq.states;
  for (const c of Object.keys(S.lfpr)) {
    const t = [S.lfpr[c] && S.lfpr[c][2], S.lfprF[c] && S.lfprF[c][2], S.wpr[c] && S.wpr[c][2]];
    if (S.lfprF[c] && S.wpr[c] && complete(t)) labour[c] = t;
  }
  if (Object.keys(prices).length < 10 || Object.keys(labour).length < 10) return null;
  return { method: PEER_METHOD, lenses: { prices: peerLens(prices, LENS_NAMES.prices), labour: peerLens(labour, LENS_NAMES.labour) } };
}

// ---------------------------------------------------------------- handler
async function build() {
  const names = ['cpi', 'iip', 'gdp', 'plfs', 'plfsq'];
  const results = await Promise.allSettled([cpiBlock(), iipBlock(), gdpBlock(), plfsBlock(), plfsqBlock()]);
  const blocks = {}, errors = {}, skipped = {};
  results.forEach((r, i) => {
    const k = names[i];
    if (r.status === 'rejected') errors[k] = String(r.reason && r.reason.message || r.reason);
    else if (!r.value) errors[k] = 'incomplete data from the API';
    else {
      if (r.value._skipped && r.value._skipped.length) skipped[k] = r.value._skipped;
      delete r.value._skipped;
      blocks[k] = r.value;
    }
  });
  const body = { schema: 1, generated: new Date().toISOString(), blocks };
  try { const p = peersFrom(blocks.cpi, blocks.plfsq); if (p) body.peers = p; } catch (e) { errors.peers = String(e.message || e); }
  // Ignored by the app; handy for debugging
  if (Object.keys(errors).length) body.errors = errors;
  if (Object.keys(skipped).length) body.skipped = skipped;
  return body;
}

module.exports = async (req, res) => {
  const body = await build();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // No caching anywhere: every page load / refresh gets a fresh fetch from MoSPI (~1 s).
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.status(200).send(JSON.stringify(body));
};
module.exports.build = build;
