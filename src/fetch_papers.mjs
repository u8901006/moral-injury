import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

const SEARCH_QUERIES = [
  '"moral injury"[Title/Abstract] OR "moral injuries"[Title/Abstract] OR "moral distress"[Title/Abstract] OR "moral trauma"[Title/Abstract] OR "potentially morally injurious event*"[Title/Abstract] OR PMIE[Title/Abstract] OR PMIEs[Title/Abstract]',
  '"moral pain"[Title/Abstract] OR "moral suffering"[Title/Abstract] OR "moral stress"[Title/Abstract] OR "morally injurious experience*"[Title/Abstract]',
  '"moral repair"[Title/Abstract] OR "moral resilience"[Title/Abstract] OR "moral healing"[Title/Abstract] OR "moral emotions"[Title/Abstract]',
  '"institutional betrayal"[Title/Abstract] OR "ethical transgression"[Title/Abstract] OR "violation of moral beliefs"[Title/Abstract]',
  '"second victim"[Title/Abstract] OR "moral residue"[Title/Abstract] OR "moral dissonance"[Title/Abstract]',
];

function buildDateFilter(days) {
  const lookback = new Date(Date.now() - days * 86400000);
  const yyyy = lookback.getFullYear();
  const mm = String(lookback.getMonth() + 1).padStart(2, "0");
  const dd = String(lookback.getDate()).padStart(2, "0");
  return `"${yyyy}/${mm}/${dd}"[Date - Publication] : "3000"[Date - Publication]`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, maxPapers: 40, output: "papers.json" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) opts.days = parseInt(args[++i], 10);
    else if (args[i] === "--max-papers" && args[i + 1]) opts.maxPapers = parseInt(args[++i], 10);
    else if (args[i] === "--output" && args[i + 1]) opts.output = args[++i];
  }
  return opts;
}

async function searchPapers(query, retmax) {
  const url = `${PUBMED_SEARCH}?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&sort=date&retmode=json`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "MoralInjuryResearchBot/1.0 (research aggregator)" },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`PubMed search HTTP ${resp.status}`);
  const data = await resp.json();
  return data?.esearchresult?.idlist || [];
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const ids = pmids.join(",");
  const url = `${PUBMED_FETCH}?db=pubmed&id=${ids}&retmode=xml`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "MoralInjuryResearchBot/1.0 (research aggregator)" },
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`PubMed fetch HTTP ${resp.status}`);
  const xml = await resp.text();

  const papers = [];
  const articleRegex = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let match;
  while ((match = articleRegex.exec(xml)) !== null) {
    const block = match[1];

    const pmidM = block.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    const pmid = pmidM ? pmidM[1] : "";

    const titleM = block.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
    let title = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : "";

    const journalM = block.match(/<Title>([\s\S]*?)<\/Title>/);
    const journal = journalM ? journalM[1].trim() : "";

    const abstractParts = [];
    const absRegex = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
    let absMatch;
    while ((absMatch = absRegex.exec(block)) !== null) {
      const labelM = absMatch[0].match(/Label="([^"]*)"/);
      const label = labelM ? labelM[1] : "";
      const text = absMatch[1].replace(/<[^>]+>/g, "").trim();
      if (text) abstractParts.push(label ? `${label}: ${text}` : text);
    }
    const abstract = abstractParts.join(" ").slice(0, 2000);

    const yearM = block.match(/<Year>(\d{4})<\/Year>/);
    const monthM = block.match(/<Month>([^<]+)<\/Month>/);
    const dayM = block.match(/<Day>(\d+)<\/Day>/);
    const dateParts = [yearM?.[1], monthM?.[1], dayM?.[1]].filter(Boolean);
    const dateStr = dateParts.join(" ");

    const keywords = [];
    const kwRegex = /<Keyword>([^<]+)<\/Keyword>/g;
    let kwMatch;
    while ((kwMatch = kwRegex.exec(block)) !== null) keywords.push(kwMatch[1].trim());

    const url = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "";

    if (title) {
      papers.push({ pmid, title, journal, date: dateStr, abstract, url, keywords });
    }
  }
  return papers;
}

async function main() {
  const opts = parseArgs();
  const dateFilter = buildDateFilter(opts.days);
  const allPmids = new Set();

  for (const q of SEARCH_QUERIES) {
    const fullQuery = `(${q}) AND ${dateFilter}`;
    try {
      const pmids = await searchPapers(fullQuery, Math.ceil(opts.maxPapers / SEARCH_QUERIES.length));
      pmids.forEach((id) => allPmids.add(id));
    } catch (err) {
      console.error(`[WARN] Query failed: ${err.message}`);
    }
  }

  const pmidList = [...allPmids].slice(0, opts.maxPapers);
  console.error(`[INFO] Found ${pmidList.length} unique papers`);

  let papers = [];
  if (pmidList.length > 0) {
    papers = await fetchDetails(pmidList);
    console.error(`[INFO] Fetched details for ${papers.length} papers`);
  }

  const tzOffset = 8 * 60 * 60 * 1000;
  const taipeiNow = new Date(Date.now() + tzOffset);
  const dateStr = taipeiNow.toISOString().slice(0, 10);

  const output = { date: dateStr, count: papers.length, papers };
  writeFileSync(opts.output, JSON.stringify(output, null, 2), "utf-8");
  console.error(`[INFO] Saved to ${opts.output}`);
}

main().catch((err) => {
  console.error(`[ERROR] ${err.message}`);
  process.exit(1);
});
