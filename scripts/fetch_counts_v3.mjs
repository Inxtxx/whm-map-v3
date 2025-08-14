// scripts/fetch_counts_v3.mjs
// 只使用官方站：Workforce Australia
// 目标：按 POA（四位邮编）统计“近10天、且符合 462 行业口径”的岗位数，并收集清单（title/company/location/age/url）

import fs from 'fs/promises';
import { chromium } from 'playwright';

const ELG_FILE = 'rules/eligibility-462.json';
const OUT_FILE = 'data/jobs-last10d.json';
const WINDOW_DAYS = 10;

// 调试参数（由工作流传入）：LIMIT_POAS=逗号分隔邮编列表，MAX_PAGES=每次最多翻几页
const LIMIT_POAS = (process.env.LIMIT_POAS || '').split(',').map(s=>s.trim()).filter(Boolean);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '5', 10); // 生产默认 5；调试工作流里会传 1 覆盖

const RULES = JSON.parse(await fs.readFile(ELG_FILE,'utf8'));

const stateByPc = (pc)=>{
  const p = String(pc).padStart(4,'0')[0];
  if(p==='2')return'NSW'; if(p==='3')return'VIC'; if(p==='4')return'QLD';
  if(p==='5')return'SA'; if(p==='6')return'WA'; if(p==='7')return'TAS';
  if(p==='0'||p==='8'||p==='9')return'NT'; return'Other';
};

const expandRanges = (ranges=[])=>{
  const out=new Set();
  for(const s0 of ranges){
    const s=String(s0).trim();
    if(!s) continue;
    if(s==='ALL'){ out.add('ALL'); continue; }
    if(s.includes('-')){
      const [a,b]=s.split('-').map(x=>parseInt(x,10));
      for(let n=a;n<=b;n++) out.add(String(n).padStart(4,'0'));
    }else{
      out.add(String(s).padStart(4,'0'));
    }
  }
  return Array.from(out);
};

const inRegional = (pc)=>{
  const st=stateByPc(pc); const segs=RULES.definitions.regionalAustralia[st]||[];
  if(segs.includes('ALL')) return true;
  return new Set(expandRanges(segs)).has(String(pc).padStart(4,'0'));
};

const inRemoteVR = (pc)=>{
  const st=stateByPc(pc); const segs=RULES.definitions.remoteVeryRemoteByState[st]||[];
  if(segs.includes('ALL')) return true;
  const set=new Set([...expandRanges(segs), ...RULES.definitions.tourismExtraPostcodes]);
  return set.has(String(pc).padStart(4,'0'));
};

const inNorthern = (pc)=>{
  const s=stateByPc(pc);
  if(s==='NT' && RULES.definitions.northernAustralia.ntAll) return true;
  return new Set(RULES.definitions.northernAustralia.postcodes).has(String(pc).padStart(4,'0'));
};

// 462 行业关键词（用于筛掉无关职位）
const PACKS = {
  hospo: ['hotel','hostel','motel','resort','housekeeping','reception','bartender','barista','waiter','kitchen hand','chef','cook','restaurant','cafe','front of house','housekeeper'],
  cultivation: ['farm','farmhand','harvest','picker','picking','packing','horticulture','orchard','vineyard','pruning','nursery','dairy','cattle','shear','abattoir'],
  construction: ['construction','labourer','laborer','scaffolder','concreter','bricklayer','carpenter','painter','plasterer','tiler'],
  fishing: ['fishing','deckhand','aquaculture','pearling','hatchery'],
  forestry: ['forestry','silviculture','logging','tree felling','chainsaw','plantation']
};

function keywordSetsForPOA(pc){
  const sets=[];
  if(inNorthern(pc) || inRemoteVR(pc)) sets.push(PACKS.hospo);
  if(inNorthern(pc) || inRegional(pc)){ sets.push(PACKS.cultivation); sets.push(PACKS.construction); }
  if(inNorthern(pc)){ sets.push(PACKS.fishing); sets.push(PACKS.forestry); }
  return sets;
}

function within10Days(text){
  const t=(text||'').toLowerCase();
  if(/hour/.test(t)) return true;
  if(/today|yesterday/.test(t)) return true;
  const m=t.match(/(\d+)\s+day/);
  return m ? (parseInt(m[1],10) <= WINDOW_DAYS) : false;
}

async function fetchCounts(){
  // 组合候选 POA（来自规则）
  const poaSet=new Set([
    ...RULES.definitions.tourismExtraPostcodes,
    ...RULES.definitions.northernAustralia.postcodes
  ]);
  for(const [_,segs] of Object.entries(RULES.definitions.regionalAustralia)){
    if(segs.includes('ALL')) continue;
    expandRanges(segs).forEach(x=>poaSet.add(x));
  }
  for(const [_,segs] of Object.entries(RULES.definitions.remoteVeryRemoteByState)){
    if(segs.includes('ALL')) continue;
    expandRanges(segs).forEach(x=>poaSet.add(x));
  }

  let poaList=Array.from(poaSet);
  if(LIMIT_POAS.length){
    const wanted=new Set(LIMIT_POAS);
    poaList=poaList.filter(pc=>wanted.has(pc));
    if(poaList.length===0) poaList = LIMIT_POAS; // 允许手工列表
  }

  const browser=await chromium.launch({headless:true, args:['--no-sandbox','--disable-setuid-sandbox']});
  const page=await browser.newPage({ viewport:{width:1280, height:900} });

  const result={};

  for(const poa of poaList){
    const packs=keywordSetsForPOA(poa);
    const items=[]; const seen=new Set();
    if(!packs.length){ result[poa]={count:0,items:[]}; continue; }

    for(const words of packs){
      const kw=words.join(' OR ');
      await page.goto('https://www.workforceaustralia.gov.au/individuals/jobs/search', {waitUntil:'load'});

      // 填写关键字与位置
      try{
        await page.waitForSelector('input[aria-label*="Keyword"], input[placeholder*="Keyword"]',{timeout:15000});
        await page.fill('input[aria-label*="Keyword"], input[placeholder*="Keyword"]', kw);
      }catch{};
      try{
        await page.waitForSelector('input[aria-label="Enter location"], input[aria-label*="location"], input[placeholder*="location"]',{timeout:15000});
        await page.fill('input[aria-label="Enter location"], input[aria-label*="location"], input[placeholder*="location"]', poa);
      }catch{};
      await page.keyboard.press('Enter');
      await page.waitForLoadState('networkidle', {timeout:20000}).catch(()=>{});
      await page.waitForTimeout(1200);

      // Job age => Past fortnight（站内两周），我们再做“≤10天”二次过滤
      try{
        await page.getByText(/Job age/i).click({timeout:10000});
        await page.getByRole('option',{name:/Past fortnight/i}).click({timeout:10000});
        await page.waitForTimeout(800);
      }catch{};

      for(let pg=0; pg<MAX_PAGES; pg++){
        await page.waitForTimeout(1000);
        const cards = await page.$$('[data-testid*="job-card"], article:has(a[href*="/jobs/"])');

        for(const c of cards){
          const txt=(await c.innerText().catch(()=>'')) || '';
          if(!within10Days(txt)) continue;

          // 抓链接
          let href=null;
          const as=await c.$$('a[href]');
          for(const a of as){
            const u=await a.getAttribute('href');
            if(u && /^https?:\/\//.test(u)){ href=u; break; }
          }
          if(!href || seen.has(href)) continue;
          seen.add(href);

          const title=(await (await c.$('h3, h2'))?.innerText().catch(()=>'')) || 'Job';
          const company=(await (await c.$('[data-testid*="company"], .company, .job-company'))?.innerText().catch(()=>'')) || '';
          const loc=(await (await c.$('[data-testid*="location"], .location'))?.innerText().catch(()=>'')) || '';
          const age=(txt.match(/Added [^\n]+/i)?.[0] || txt.match(/\d+\s+(?:day|hour)s?\s+ago/i)?.[0] || '').trim();

          items.push({ title:title.trim(), company:company.trim(), location:loc.trim(), age, url:href });
        }

        const next = await page.$('button[aria-label*="Next"], a[rel="next"]');
        if(!next) break;
        const dis = await next.getAttribute('disabled');
        if(dis!==null) break;
        await next.click();
      }
    }

    result[poa] = { count: items.length, items };
  }

  await fs.mkdir('data', {recursive:true});
  await fs.writeFile(OUT_FILE, JSON.stringify({
    generatedAtUTC: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    source: "Workforce Australia (official)",
    perPOA: result
  }, null, 2));

  await browser.close();
  console.log('DONE');
}

await fetchCounts().catch(async e=>{
  console.error('FAILED', e);
  try{ await fs.access(OUT_FILE); }
  catch{ await fs.writeFile(OUT_FILE, JSON.stringify({generatedAtUTC:new Date().toISOString(),windowDays:WINDOW_DAYS,source:"Workforce Australia (official)",perPOA:{}}, null, 2)); }
  process.exit(0);
});
