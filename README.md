# UberStrike Artifacts

A static dashboard that lists GitHub Actions artifacts straight from the public GitHub API, plus a Cloudflare Worker that streams downloads without a GitHub account.

```
Browser (GitHub Pages / Cloudflare Pages)
  |-- GET api.github.com/repos/...     --> artifact list + metadata (public, no token)
  |-- GET /download/:owner/:repo/:id   --> Worker --> GitHub API --> signed blob (streamed)
```

The GitHub token lives only in the Worker as a secret and is used only for downloads. The static site contains no credentials.

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
```

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

## Deploying the site to Cloudflare Pages instead

Use Cloudflare Pages, build command empty, output directory `site`. No GitHub Pages plan is needed.

## Local development

```bash
cd worker
cp .dev.vars.example .dev.vars
npx wrangler dev

python3 -m http.server 8080 -d site
```

The site CSP allows `https://*.workers.dev` (downloads) and `https://api.github.com` (listing) by default. For local download testing against `http://127.0.0.1:8787`, temporarily add `http://127.0.0.1:8787` to the `connect-src` directive in `site/index.html`.

## Endpoints

- `GET /health`
- `GET /download/:owner/:repo/:artifactId` - streams the artifact zip (`HEAD` supported)

The artifact list and its metadata are fetched client-side from the GitHub API; no Worker endpoint is involved.

## Behavior and limits

- Listing and metadata (build type, branch, commit, PR number and title) are fetched directly from `api.github.com` in the browser. Anonymous GitHub API rate limit: 60 requests/hour per IP.
- Up to 500 artifacts are listed (5 pages of 100). Expired artifacts are excluded.
- Build types are detected from workflow job and step names (Windows, Android, iOS, Linux, macOS, WebGL).
- Cloudflare Workers Free plan: 100,000 requests/day, 10 ms CPU per request; downloads are streamed and have no enforced response body limit.
- The download endpoint returns `410` for an expired artifact.

## Security notes

- Never commit a token into `site/` or any other file.
- Keep `ALLOWED_REPOS` minimal, even though the token is already repo-scoped.
- The token never reaches the browser; download links do not contain credentials.
- The site CSP restricts scripts to same-origin files and network access to `*.workers.dev` and `https://api.github.com`. Update `connect-src` if you attach a custom domain to the Worker.
- Consider Cloudflare rate limiting or WAF rules if the download endpoint gets abused.
