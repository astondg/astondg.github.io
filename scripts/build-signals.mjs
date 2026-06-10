#!/usr/bin/env node
/**
 * build-signals.mjs
 *
 * Produces signals.json — the shared "living portfolio" data contract.
 * Consumed today by the website (client-side fetch) and, later, by the
 * astondean.com MCP server, which can serve this same shape to any AI.
 *
 * v1 signals: GitHub activity, app/deploy status (reachability), last-updated stamp.
 *
 * Runs in GitHub Actions (Node 20, global fetch). GITHUB_TOKEN is optional but
 * recommended — it lifts the API rate limit from 60 to 5000 req/hr.
 * No secrets are required for v1. (To add Vercel deploy state later, read a
 * VERCEL_TOKEN env var here and populate app.deploy — see note below.)
 */

const GH_USER = "astondg";
const UA = "astondean-signals (+https://astondean.com)";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

// Source of truth for products shown on the site.
const APPS = [
  { name: "aitrips.io",      url: "https://aitrips.io",                          status: "live",          check: true  },
  { name: "JotCal",          url: "https://jotcal.app",                          status: "in_development", check: false },
  { name: "TribeRide",       url: null,                                          status: "in_development", check: false },
  { name: "Next Departure",  url: "https://github.com/astondg/next-departure",   status: "open_source",   check: false },
];

const ghHeaders = {
  "User-Agent": UA,
  "Accept": "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers: ghHeaders });
  if (!res.ok) throw new Error(`GitHub ${path} -> ${res.status}`);
  return res.json();
}

async function withTimeout(promise, ms, fallback) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await promise(ctrl.signal); }
  catch { return fallback; }
  finally { clearTimeout(t); }
}

async function reachable(url) {
  return withTimeout(async (signal) => {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal, headers: { "User-Agent": UA } });
    return res.ok;
  }, 8000, false);
}

async function buildGitHub() {
  let repos = [];
  try {
    const raw = await gh(`/users/${GH_USER}/repos?per_page=100&sort=pushed&direction=desc&type=owner`);
    repos = raw
      .filter((r) => !r.fork && !r.archived)
      .map((r) => ({
        name: r.name,
        full: r.full_name,
        url: r.html_url,
        description: r.description || "",
        language: r.language || null,
        stars: r.stargazers_count || 0,
        pushedAt: r.pushed_at,
      }));
  } catch (e) {
    console.error("repos:", e.message);
  }

  // Recent commits across the most-recently-pushed repos.
  const recent = [];
  for (const repo of repos.slice(0, 5)) {
    try {
      const commits = await gh(`/repos/${repo.full}/commits?per_page=3`);
      for (const c of commits) {
        const msg = (c.commit?.message || "").split("\n")[0].slice(0, 120);
        if (!msg || msg.startsWith("chore: update signals")) continue; // skip our own bot commits
        recent.push({
          repo: repo.full,
          message: msg,
          url: c.html_url,
          at: c.commit?.author?.date || c.commit?.committer?.date,
        });
      }
    } catch (e) {
      console.error(`commits ${repo.full}:`, e.message);
    }
  }
  recent.sort((a, b) => new Date(b.at) - new Date(a.at));

  return { user: GH_USER, repos: repos.slice(0, 8), recent: recent.slice(0, 6) };
}

async function buildApps() {
  return Promise.all(
    APPS.map(async (a) => {
      const out = { name: a.name, url: a.url, status: a.status };
      if (a.check && a.url) {
        out.reachable = await reachable(a.url);
        out.checkedAt = new Date().toISOString();
      }
      // To add Vercel deploy state later:
      //   if (process.env.VERCEL_TOKEN) out.deploy = await fetchVercelDeploy(a, process.env.VERCEL_TOKEN);
      return out;
    })
  );
}

async function main() {
  const [github, apps] = await Promise.all([buildGitHub(), buildApps()]);
  const signals = {
    generatedAt: new Date().toISOString(),
    version: 1,
    github,
    apps,
  };
  const { writeFile } = await import("node:fs/promises");
  await writeFile("signals.json", JSON.stringify(signals, null, 2) + "\n");
  console.log(`Wrote signals.json — ${github.recent.length} activity items, ${apps.length} apps.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
