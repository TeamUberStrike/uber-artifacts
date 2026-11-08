# UberStrike Artifacts

A static dashboard plus a Cloudflare Worker proxy that lists GitHub Actions artifacts and lets anyone download them without a GitHub account.

```
Browser (GitHub Pages / Cloudflare Pages)
  |-- GET /api/artifacts/:owner/:repo  --> Worker --> GitHub API (server-side token)
  |-- GET /download/:owner/:repo/:id   --> Worker --> GitHub API --> signed blob (streamed)
```

The GitHub token lives only in the Worker as a secret. The static site contains no credentials.

## Private repository caveat

The repository can be private, but the published site and the downloads are public by design ("downloads for everyone"). A private repository does not make the Pages site private.

GitHub Pages inside a private repository requires GitHub Pro, Team, or Enterprise Cloud. If the account does not have that, deploy the `site/` directory to Cloudflare Pages instead, which supports private repositories for free and still publishes a public site.

## Setup

1. Create the repository (private is fine) and push this code.
2. Create a fine-grained personal access token:
   - Resource owner: `TeamUberStrike`
   - Repository access: only `uber-client-4-3-8`
   - Permissions: `Actions: Read-only` and `Metadata: Read-only`
3. Deploy the Worker:

```bash
cd worker
npx wrangler login
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```

4. Edit `worker/wrangler.toml`:

```toml
[vars]
ALLOWED_REPOS = "TeamUberStrike/uber-client-4-3-8"
ALLOWED_ORIGINS = "https://teamuberstrike.github.io"
```

Redeploy after changing variables.

5. Set the deployed Worker URL as a repository Actions variable named `ARTIFACTS_PROXY_URL` (Settings -> Secrets and variables -> Actions -> Variables). The Pages workflow injects it into `site/config.js` during deployment. You can also edit `site/config.js` directly.

6. Enable Pages: repository Settings -> Pages -> Source: GitHub Actions, then push to `main`.

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

Use Cloudflare Pages with the private repository, build command empty, output directory `site`. No GitHub Pages plan is needed.

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

- Artifact lists are cached for 60 seconds using the Workers Cache API.
- Up to 500 artifacts are listed (5 pages of 100).
- Build types are detected from workflow job and step names (Windows, Android, iOS, Linux, macOS, WebGL).
- Metadata is resolved for up to 15 distinct runs, 15 job lists, and 10 pull requests per list request to stay within the Workers Free plan subrequest limit.
- Cloudflare Workers Free plan: 100,000 requests/day, 10 ms CPU per request; downloads are streamed and have no enforced response body limit.
- Expired artifacts are excluded from the list. The download endpoint also returns `410` for an expired artifact.

## Security notes

- Never commit a token into `site/` or any other file.
- Keep `ALLOWED_REPOS` minimal, even though the token is already repo-scoped.
- Set `ALLOWED_ORIGINS` to the Pages origin; use `*` only if the list endpoint should be readable from any site.
- The token never reaches the browser; download links do not contain credentials.
- The site CSP restricts scripts to same-origin files and network access to `*.workers.dev`. Update `connect-src` if you attach a custom domain to the Worker.
- Consider Cloudflare rate limiting or WAF rules if the download endpoint gets abused.
