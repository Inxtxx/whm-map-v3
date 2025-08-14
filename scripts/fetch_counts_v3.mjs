// scripts/fetch_counts_v3.mjs
// 只使用官方站：Workforce Australia
// 目标：按 POA（四位邮编）统计“近10天、且符合 462 行业口径”的岗位数，并收集清单（title/company/location/age/url）

import fs from 'fs/promises';
import { chromium } from 'playwright';

const ELG_FILE = 'rules/eligibility-462.json';
const OUT_FILE = 'data/jobs-last10d.json';
const WINDOW_DAYS = 10;

const RULES = JSON.parse(await fs.readFile(ELG_FILE,'utf8'));

const stateByPc = (pc)=>{
  const p = String(pc).padStart(4,'0')[0];
  if(p==='2')return'NSW'; if(p==='3')return'VIC'; if(p==='4')return'QLD';
  if(p==='5')return'SA'; if(p==='6')return'WA'; if(p==='7')return'TAS';
  if(p==='0'||p==='8'||p==='9')return'NT'; return'Other';
};
const expand = (ranges=[])=>{
  const out = new Set();
  for (const s of ranges){
    const t = String(s).trim();
    if (t==='ALL') { out.add('ALL'); continue; }
    if (t.includes('-')){ const [a,b]=t.split('-').map(x=>parseInt(x,10)); for(let n=a;n<=b;n++) out.add(String(n).padStart(4,'0')); }
    else out.add(String(t).padStart(4,'0'));
  }
  return Array.from(out);
};
const inRegional = (pc)=>{
  const st = stateByPc(pc); const segs = RULES.definitions.regionalAustralia[st]||[];
  if (segs.includes('ALL')) return true;
  const set = new Set(expand(segs)); return set.has(String(pc).padStart(4,'0'));
};
const inRemoteVR = (pc)=>{
  const st = stateByPc(pc); const segs = RULES.definitions.remoteVeryRemoteByState[st]||[];
  if (segs.includes('ALL')) return true;
  const set = new Set([...expand(segs), ...RULES.definitions.tourismExtraPostcodes]);
  return set.has(String(pc).padStart(4,'0'));
};
const inNorthern = (pc)=>{
  const s = stateByPc(pc);
  if (s==='NT' && RULES.definitions.northernAustralia.ntAll) return true;
  return new Set(RULES.definitions.northernAustralia.postcodes).has(String(pc).padStart(4,'0'));
};

// 针对不同 POA，决定 462 行业关键词范围
const PACKS = {
  hospo: ['hotel','hostel','motel','resort','housekeeping','reception','bartender','barista','waiter','kitchen hand','chef','cook','restaurant','cafe','front of house','housekeeper'],
  cultivation: ['farm','farmhand','harvest','picker','picking','packing','horticulture','orchard','vineyard','pruning','nursery','dairy','cattle','shear','abattoir'],
  construction: ['construction','labourer','laborer','scaffolder','concreter','bricklayer','carpenter','painter','plasterer','tiler'],
  fishing: ['fishing','deckhand','aquaculture','pearling','hatchery'],
  forestry: ['forestry','silviculture','logging','tree felling','chainsaw','plantation']
};

function keywordSetsForPOA(pc){
  const sets = [];
  if (inNorthern(pc) || inRemoteVR(pc)) sets.push(PACKS.hospo);
  if (inNorthern(pc) || inRegional(pc)) { sets.push(PACKS.cultivation); sets.push(PACKS.construction); }
  if (inNorthern(pc)) { sets.push(PACKS.fishing); sets.push(PACKS.forestry); }
  return sets;
}

function within10Days(text){
  const t = (text||'').toLowerCase();
  if (t.includes('hour')) return true;
  if (t.includes('today')) return true;
  if (t.includes('yesterday')) return true;
  const m = t.match(/(\d+)\s+day/); return m ? (parseInt(m[1],10) <= WINDOW_DAYS) : false;
}

async function fetchCounts(){
  // 选取候选 POA：把规则中出现的全纳入；（也可改为从 POA GeoJSON 提取全量）
  const poaSet = new Set([
    ...RULES.definitions.tourismExtraPostcodes,
    ...RULES.definitions.northernAustralia.postcodes
  ]);
  for (const [st,segs] of Object.entries(RULES.definitions.regionalAustralia)){
    if (segs.includes('ALL')) continue;
    expand(segs).forEach(x=>poaSet.add(x));
  }
  for (const [st,segs] of Object.entries(RULES.definitions.remoteVeryRemoteByState)){
    if (segs.includes('ALL')) continue;
    expand(segs).forEach(x=>poaSet.add(x));
  }

  const browser = await chromium.launch({ args:['--no-sandbox'] });
  const page = await browser.newPage();

  const result = {};
  for (const poa of poaSet){
    const packs = keywordSetsForPOA(poa);
    if (!packs.length){ result[poa]={count:0,items:[]}; continue; }

    const seen = new Set();
    const items = [];

    for (const words of packs){
      const q = words.join(' OR ');
      await page.goto('https://www.workforceaustralia.gov.au/individuals/jobs/search', { waitUntil:'domcontentloaded' });
      // 试填关键字与位置（页面是 SPA，选择器可能会变；下面是通用兜底写法）
      const kwSel = 'input[aria-label="Keyword"], input[placeholder*="Keyword"]';
      const locSel = 'input[aria-label="Enter location"], input[placeholder*="location"]';
      try{
        await page.waitForSelector(kwSel, { timeout:15000 }); await page.fill(kwSel, q);
        await page.waitForSelector(locSel, { timeout:15000 }); await page.fill(locSel, poa);
        await page.keyboard.press('Enter');
      }catch(e){}

      // 等待结果加载
      await page.waitForTimeout(3000);

      // 尝试设置 Job age = Past fortnight（两周）；随后我们仍会做“<=10天”的二次过滤
      try{
        await page.getByText(/Job age/i).click({ timeout:10000 });
        await page.getByRole('option', { name:/Past fortnight/i }).click({ timeout:10000 });
        await page.waitForTimeout(1500);
      }catch(e){}

      // 抓取当前页的岗位卡片
      for (let pg=0; pg<5; pg++){ // 每组最多翻 5 页，控制时长
        await page.waitForTimeout(1500);
        const cards = await page.$$('[data-testid^="job-card"], .job-card');
        for (const c of cards){
          const txt = (await c.textContent()) || '';
          if (!within10Days(txt)) continue;

          // 链接、标题、公司（容错选择器）
          const a = await c.$('a[href^="http"]'); const href = a ? await a.getAttribute('href') : null;
          if (!href || seen.has(href)) continue;
          seen.add(href);
          const title = await (await c.$('h3, h2'))?.textContent() || 'Job';
          const company = await (await c.$('[data-testid*="company"], .job-company, .company'))?.textContent() || '';
          const loc = await (await c.$('[data-testid*="location"], .location'))?.textContent() || '';
          const age = (txt.match(/Added\s+[^\n]+/i) || [])[0] || '';

          items.push({ title:title.trim(), company:company.trim(), location:loc.trim(), age:age.trim(), url:href });
        }
        const next = await page.$('button[aria-label*="Next"], a[rel="next"]');
        if (!next) break;
        const disabled = await next.getAttribute('disabled');
        if (disabled!==null) break;
        await next.click();
      }
    }
    result[poa] = { count: items.length, items };
  }

  await browser.close();
  await fs.mkdir('data', { recursive:true });
  await fs.writeFile(OUT_FILE, JSON.stringify({
    generatedAtUTC: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    source: "Workforce Australia (official)",
    perPOA: result
  }, null, 2));
}

await fetchCounts().catch(async e=>{
  console.error(e);
  // 出错时保持文件存在
  try{ await fs.access(OUT_FILE); }catch{ await fs.writeFile(OUT_FILE, JSON.stringify({generatedAtUTC:new Date().toISOString(),windowDays:WINDOW_DAYS,source:"Workforce Australia (official)",perPOA:{}},null,2)); }
  process.exit(0);
});
