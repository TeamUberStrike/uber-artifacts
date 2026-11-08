# UberStrike Artifacts

A static dashboard plus a Cloudflare Worker that lists GitHub Actions artifacts and streams downloads without a GitHub account.

```
Browser (GitHub Pages / Cloudflare Pages)
  |-- GET /api/artifacts/:owner/:repo  --> Worker --> GitHub REST (list, runs, jobs) + GraphQL (PR titles)
  |-- GET /download/:owner/:repo/:id   --> Worker --> GitHub API --> signed blob (streamed)
```

The GitHub token lives only in the Worker as a secret. The static site contains no credentials. List responses are cached for 60 seconds at Cloudflare's edge and in the Worker cache, so GitHub is only queried once per minute at most.

## Setup

1. Create the repository and push this code.
2. Create a fine-grained personal access token:
   - Resource owner: `TeamUberStrike`
   - Repository access: only `uber-client-4-3-8`
   - Permissions: `Actions: Read-only` and `Metadata: Read-only`
3. Deploy the Worker proxy to Cloudflare (see [Deploying the Worker to Cloudflare](#deploying-the-worker-to-cloudflare)).
4. Set `proxyBase` in `site/config.js` to the deployed Worker URL.
5. Enable Pages as a branch deployment from `gh-pages` (see [Deploying the site](#deploying-the-site)).

## Deploying the site

The site is deployed with GitHub Pages as a branch deployment from `gh-pages` (repository Settings -> Pages -> Source: Deploy from a branch -> branch `gh-pages`, folder `/`).

1. Put the contents of `site/` at the root of `gh-pages`, with the real Worker URL baked into `site/config.js` as `proxyBase`.
2. Include a `CNAME` file containing `artifacts.uberstrike.com` and an empty `.nojekyll`.
3. Push `gh-pages`; GitHub Pages rebuilds automatically.

Alternatively, `.github/workflows/pages.yml` deploys `site/` from `main` using GitHub Actions (Pages -> Source: GitHub Actions). With that setup, leave the `YOUR-SUBDOMAIN` placeholder in `site/config.js` and set the Worker URL as an Actions variable named `ARTIFACTS_PROXY_URL` instead of editing `config.js`.

## Deploying the Worker to Cloudflare

The proxy runs on Cloudflare Workers and requires Node.js 22+.

1. Authenticate with Cloudflare:

```bash
cd worker
npx wrangler login
```

2. Store the GitHub token as a secret:

```bash
npx wrangler secret put GITHUB_TOKEN
```

3. Edit `worker/wrangler.toml`:

```toml
[vars]
ALLOWED_REPOS = "TeamUberStrike/uber-client-4-3-8"
ALLOWED_ORIGINS = "*"
```

`ALLOWED_ORIGINS` controls CORS for the list endpoint. The list data is public, so `*` is safe; set explicit origins to restrict which sites may read it.

4. Deploy:

```bash
npx wrangler deploy
```

The Worker is now live at `https://uber-artifacts-proxy.<your-subdomain>.workers.dev`. Redeploy after changing variables.

5. (Optional) attach a custom domain to the Worker (e.g. `proxy.uberstrike.com`), then add it to the `connect-src` directive of the site CSP in `site/index.html`.

## Custom domain

The Pages site is configured for `artifacts.uberstrike.com`. With a branch deployment GitHub Pages reads the `CNAME` file in `gh-pages` (already present); the domain is also stored in the repository Pages settings.

1. In the Cloudflare DNS dashboard for `uberstrike.com`, create:

```
Type:  CNAME
Name:  artifacts
Target: teamuberstrike.github.io
Proxy: DNS only (grey cloud)
```

The record must not be proxied; GitHub needs to see the DNS record directly to verify the domain and issue the TLS certificate.

2. Wait for GitHub to verify the domain and provision HTTPS, then enable "Enforce HTTPS" in Settings -> Pages.

## Local development

```bash
cd worker
cp .dev.vars.example .dev.vars
npx wrangler dev

python3 -m http.server 8080 -d site
```

The site CSP allows `https://*.workers.dev` (the Worker serves both listing and downloads) by default. For local download testing against `http://127.0.0.1:8787`, temporarily add `http://127.0.0.1:8787` to the `connect-src` directive in `site/index.html`.

## Endpoints

- `GET /health`
- `GET /api/artifacts/:owner/:repo` - artifact list with build type, branch, commit, run, and pull request title metadata
- `GET /download/:owner/:repo/:artifactId` - streams the artifact zip (`HEAD` supported)

## Behavior and limits

### Why so many GitHub requests?

The REST API keeps each piece in a separate endpoint with no joins:

1. `/actions/artifacts` - list (name, size, dates, run id, branch, sha). No PRs, no build type.
2. `/actions/runs/{id}` - per run: PR numbers and run name/display title. Fetched once per new run.
3. `/actions/runs/{id}/jobs` - job/step names used to detect the build type. No bulk endpoint, so one call per run - only when the run name does not reveal the build type.
4. `/pulls/{number}` or GraphQL - PR titles. GraphQL batches up to 100 titles into one request.

GraphQL would be ideal but it does not expose artifacts or workflow runs (`Field 'artifacts' doesn't exist on type 'Repository'`), so REST is used for those and GraphQL only for PR titles. Build types are detected from workflow run names and job/step names (Windows, Android, iOS, Linux, macOS, WebGL).

### How the data stays fresh

A cron trigger runs the Worker every minute, without needing visitors:

1. Fetch the artifact list pages (up to 5) - this is the source of truth and the only recurring fetch; it detects new, deleted, and expired artifacts.
2. For every run the artifacts belong to, check the 30-day metadata cache. Known runs are reused and cost **zero GitHub calls**.
3. For **new** runs: one `/actions/runs/{id}` call for the PR numbers and run name, plus one jobs call only if the build type is not in the run name. The result (`buildType` + `pullRequests`) is cached for 30 days.
4. For **new** PRs: titles are fetched in one batched GraphQL request and cached for 30 days.
5. Assemble the full enriched list and store it in the 60-second list cache.

So in steady state the cron makes only the 5 list calls per minute (300/hour of the 5,000/hour token limit). New runs from a build burst are drained at up to 20 per minute; deleted or expired artifacts disappear from the site within a minute because they are missing from the fresh list. Their download links return `404`/`410` immediately, checked live.

Visitors are served from the cache only. A visitor-triggered GitHub fetch happens only when the cache has no entry (e.g. right after a deploy), using the smaller cold-start caps below.

### Relevant limits

**Cloudflare Workers Free plan - 50 subrequests per invocation.** One Worker invocation (a single HTTP request or a single scheduled cron run) may make at most **50 subrequests** - every outbound `fetch()` the Worker code performs against another server (here: `api.github.com`) counts as one, and the invocation is cut off when the 50th is reached.

What counts and what does not:

- Each GitHub API call (list page, run detail, jobs, GraphQL) = 1 subrequest
- Redirects followed by the runtime also count toward the budget
- Cache API reads/writes (`caches.default`) do **not** count - that is why serving known runs costs nothing
- The 50 limit applies per invocation, not per minute: two requests right after each other get two fresh budgets

That is why every cap in this project (20/20 for the cron, 15/15/12 for cold-start visitor builds) exists: each total budget is sized to stay under 50, and everything else is served from the free-to-read cache.

The other limits in play:

- **Cloudflare Workers Free plan**: 100,000 requests/day, 10 ms CPU per request. Downloads are streamed and have no enforced response body limit.
- **GitHub API (fine-grained token)**: 5,000 requests/hour - shared by all visitors. Steady state (300/hour) and even the worst case (2,880/hour) stay under it.
- **Per-IP rate limits in the Worker**: 30 list requests/minute and 10 downloads/minute, returning `429` with `Retry-After`.
- **Cache TTLs**: 60 seconds for the artifact list (Cloudflare edge + Worker Cache API), 30 days for immutable run metadata (`buildType` + PR numbers) and PR titles.

### How many GitHub calls does a cold-start list build make?

Worst case per artifact count (all active artifacts, each from its own run, build type not visible in run names, GraphQL unavailable so the REST title fallback is used):

| Artifacts | List pages | Run details | Job lookups | GraphQL titles | REST title fallback | Total |
|---|---|---|---|---|---|---|
| 10 | 1 | 10 | 10 | 1 | 10 | **32** |
| 50 | 1 | 15 (cap) | 15 (cap) | 1 | 12 (cap) | **44** |
| 200 | 2 | 15 (cap) | 15 (cap) | 1 | 12 (cap) | **45** |
| 500 | 5 | 15 (cap) | 15 (cap) | 1 | 12 (cap) | **48** |

Typical case (GraphQL works, build types visible in run names): 10 artifacts = ~12, 50 = ~17, 200 = ~18, 500 = ~21.

Notes:

- The artifact list endpoint returns 100 per page; up to 500 artifacts are listed (5 pages of 100) and expired artifacts are excluded. Runs are deduplicated, so 50 artifacts from one run cost a single run-detail and at most one jobs lookup.
- These tables describe a cold start. With the cron running, builds are rare and start from warm 30-day caches, so the numbers shrink toward zero per build.
- Cache hits cost zero GitHub calls. The cron's own budget per pass: 5 list pages + 20 run details + 20 job lookups + 1 GraphQL = 46 subrequests, under Cloudflare's 50-subrequest limit.
- Nothing above is per visitor: users make one request to the Worker and get a cache hit almost every time.

### Per user or global?

Global, server-side. Visitors never call GitHub - each makes one request to the Worker, usually a cache hit with 0 GitHub calls. The heavy calls happen once per cache miss, and the cron keeps the cache warm every minute regardless of traffic.

### When does a cache miss happen?

When there is no valid entry for that repo: first request after a deploy, after the 60-second TTL expired, a repo never requested before, or eviction. With the cron filling the cache every minute, misses effectively occur only for the first minute after a deploy.

### Will my ~10 users ever see a rate limit?

No. Listing is served from cache or by the Worker's shared token (5,000/hour), not by per-visitor anonymous limits. Downloads are the only thing that could be rate-limited, at 10/minute per IP.

## Security notes

- Never commit a token into `site/` or any other file.
- Keep `ALLOWED_REPOS` minimal, even though the token is already repo-scoped.
- The token never reaches the browser; download links do not contain credentials.
- Per-IP rate limits (30 list/min, 10 downloads/min) return `429`. The 60-second edge cache absorbs repeated list requests without touching the Worker or GitHub.
- For hard anti-abuse protection, add a Cloudflare WAF rate-limiting rule (e.g. on a custom domain attached to the Worker) and/or enable Bot Fight Mode.
- The site CSP restricts scripts to same-origin files and network access to `*.workers.dev`. Update `connect-src` if you attach a custom domain to the Worker.

