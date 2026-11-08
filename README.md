# UberStrike Artifacts

A static dashboard plus a Cloudflare Worker proxy that lists GitHub Actions artifacts and lets anyone download them without a GitHub account.

```
Browser (GitHub Pages / Cloudflare Pages)
  |-- GET /api/artifacts/:owner/:repo  --> Worker --> GitHub API (server-side token)
  |-- GET /download/:owner/:repo/:id   --> Worker --> GitHub API --> signed blob (streamed)
```

The GitHub token lives only in the Worker as a secret. The static site contains no credentials.

## Setup

1. Create the repository and push this code.
2. Create a fine-grained personal access token:
   - Resource owner: `TeamUberStrike`
   - Repository access: only `uber-client-4-3-8`
   - Permissions: `Actions: Read-only` and `Metadata: Read-only`
3. Deploy the Worker proxy to Cloudflare (see [Deploying the Worker to Cloudflare](#deploying-the-worker-to-cloudflare)).
4. Set the deployed Worker URL as a repository Actions variable named `ARTIFACTS_PROXY_URL` (Settings -> Secrets and variables -> Actions -> Variables). The Pages workflow injects it into `site/config.js` during deployment. Alternatively, put the Worker URL in `site/config.js` directly as `proxyBase` and commit it.
5. Enable Pages: repository Settings -> Pages -> Source: GitHub Actions, then push to `main`. The workflow in `.github/workflows/pages.yml` deploys `site/` on every push to `main`.

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
ALLOWED_ORIGINS = "https://teamuberstrike.github.io"
```

4. Deploy:

```bash
npx wrangler deploy
```

The Worker is now live at `https://uber-artifacts-proxy.<your-subdomain>.workers.dev`. Redeploy after changing variables.

5. (Optional) attach a custom domain to the Worker (e.g. `proxy.uberstrike.com`), then add it to `ALLOWED_ORIGINS` and to the `connect-src` directive of the site CSP in `site/index.html`.

## Custom domain

The Pages site is configured for `artifacts.uberstrike.com`. GitHub Pages with a custom Actions workflow ignores `CNAME` files, so the domain is stored in the repository Pages settings (already applied via the API).

1. In the Cloudflare DNS dashboard for `uberstrike.com`, create:

```
Type:  CNAME
Name:  artifacts
Target: teamuberstrike.github.io
Proxy: DNS only (grey cloud)
```

The record must not be proxied; GitHub needs to see the DNS record directly to verify the domain and issue the TLS certificate.

2. Wait for GitHub to verify the domain and provision HTTPS, then enable "Enforce HTTPS" in Settings -> Pages.
3. Keep `ALLOWED_ORIGINS` in `worker/wrangler.toml` in sync with the site origin(s).

## Deploying the site to Cloudflare Pages instead

Use Cloudflare Pages, build command empty, output directory `site`. No GitHub Pages plan is needed.

## Local development

```bash
cd worker
cp .dev.vars.example .dev.vars
npx wrangler dev

python3 -m http.server 8080 -d site
```

The site CSP only allows `https://*.workers.dev` by default. For local testing against `http://127.0.0.1:8787`, temporarily add `http://127.0.0.1:8787` to the `connect-src` directive in `site/index.html`.

## Endpoints

- `GET /health`
- `GET /api/artifacts/:owner/:repo` - artifact list with build type, branch, commit, run, and pull request title metadata
- `GET /download/:owner/:repo/:artifactId` - streams the artifact zip (`HEAD` supported)

## Behavior and limits

- Artifact lists are not cached; every request fetches fresh data from GitHub (`Cache-Control: no-store`), so deletions appear immediately.
- Up to 500 artifacts are listed (5 pages of 100).
- Build types are detected from workflow job and step names (Windows, Android, iOS, Linux, macOS, WebGL).
- Run details (build type, branch, commit, PR number and title) are resolved for up to 15 distinct runs, 15 job lists, and 10 pull requests per list request to stay within the Workers Free plan subrequest limit.
- Cloudflare Workers Free plan: 100,000 requests/day, 10 ms CPU per request; downloads are streamed and have no enforced response body limit.
- Expired artifacts are excluded from the list. The download endpoint also returns `410` for an expired artifact.

## Security notes

- Never commit a token into `site/` or any other file.
- Keep `ALLOWED_REPOS` minimal, even though the token is already repo-scoped.
- Set `ALLOWED_ORIGINS` to the Pages origin; use `*` only if the list endpoint should be readable from any site.
- The token never reaches the browser; download links do not contain credentials.
- The site CSP restricts scripts to same-origin files and network access to `*.workers.dev`. Update `connect-src` if you attach a custom domain to the Worker.
- Consider Cloudflare rate limiting or WAF rules if the download endpoint gets abused.
