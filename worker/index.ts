// Cloudflare Worker — handles the admin panel's write endpoints and its
// login gate.
//
// wrangler.jsonc sets `run_worker_first: true`, so every request reaches
// this Worker before Cloudflare's static asset handling — that's what lets
// it gate /admin* itself, not just the /api/* write endpoints. Anything not
// explicitly handled below falls through to env.ASSETS.fetch() at the
// bottom, which serves the static build from dist/ exactly as before.
//
// Auth is a single shared password (ADMIN_PASSWORD, a Worker secret) behind
// an HMAC-signed, HttpOnly session cookie (SESSION_SECRET, another Worker
// secret) — this is a one-admin portfolio site, not a multi-user app, so a
// full accounts system would be overkill. GITHUB_TOKEN is a third secret;
// none of the three are ever exposed to the browser.

export interface Env {
  ASSETS: Fetcher;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string; // e.g. "hamburgersandfries/dannydwyer"
  GITHUB_BRANCH: string; // e.g. "main"
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
}

const SESSION_COOKIE = 'session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

async function hmac(env: Env, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('Cookie');
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return false;
  const [expiryStr, sig] = token.split('.');
  if (!expiryStr || !sig) return false;
  const expected = await hmac(env, expiryStr);
  if (!timingSafeEqual(sig, expected)) return false;
  const expiry = Number(expiryStr);
  return Number.isFinite(expiry) && Date.now() < expiry;
}

async function sessionCookieHeader(env: Env): Promise<string> {
  const expiry = Date.now() + SESSION_TTL_MS;
  const sig = await hmac(env, String(expiry));
  return `${SESSION_COOKIE}=${expiry}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

function clearedCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

const VIDEOS_DIR = 'src/content/videos';

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function toFrontmatter(fields: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
      // JSON is a valid subset of YAML flow style, so this round-trips cleanly
      // through both the astro:content YAML parser and the admin panel's own
      // JSON.parse-based raw editor.
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

async function githubRequest(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dannydwyer-admin',
      ...(init.headers ?? {}),
    },
  });
}

async function getFile(env: Env, path: string) {
  const res = await githubRequest(env, `${path}?ref=${env.GITHUB_BRANCH}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { content: string; sha: string };
  const content = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
  return { content, sha: data.sha };
}

async function putFile(env: Env, path: string, content: string, sha: string | undefined, message: string) {
  return githubRequest(env, path, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      branch: env.GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
}

const json = (data: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });

async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_PASSWORD) {
    return json({ error: 'ADMIN_PASSWORD is not configured on this deployment.' }, 500);
  }
  const body = (await request.json().catch(() => ({}))) as { password?: string };
  const password = body.password ?? '';
  if (!timingSafeEqual(password, env.ADMIN_PASSWORD)) {
    return json({ error: 'Incorrect password.' }, 401);
  }
  return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookieHeader(env) });
}

function handleLogout(): Response {
  return json({ ok: true }, 200, { 'Set-Cookie': clearedCookieHeader() });
}

async function handleVideosGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');

  if (slug) {
    const res = await githubRequest(env, `${VIDEOS_DIR}/${slug}.md?ref=${env.GITHUB_BRANCH}`);
    if (!res.ok) return json({ error: 'Video not found' }, 404);
    const data = (await res.json()) as { content: string };
    const raw = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
    return json({ slug, raw });
  }

  const res = await githubRequest(env, `${VIDEOS_DIR}?ref=${env.GITHUB_BRANCH}`);
  if (!res.ok) return json({ error: 'Could not list videos' }, 502);
  const files = (await res.json()) as { name: string }[];
  const slugs = files.filter((f) => f.name.endsWith('.md')).map((f) => f.name.replace(/\.md$/, ''));
  return json({ slugs });
}

async function handleVideosPost(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Record<string, any>;
  const slug = slugify(body.slug || body.title);
  const filePath = `${VIDEOS_DIR}/${slug}.md`;

  const frontmatter = toFrontmatter({
    title: body.title,
    summary: body.summary,
    platform: body.platform === 'vimeo' ? 'vimeo' : 'youtube',
    videoId: body.videoId,
    thumbnailUrl: body.thumbnailUrl || undefined,
    role: body.role || 'Director of Photography',
    client: body.client || undefined,
    projectName: body.projectName || undefined,
    uploadDate: body.uploadDate,
    durationISO: body.durationISO || undefined,
    tags: body.tags || [],
    stills: body.stills || [],
    urlSlug: slug,
    featured: !!body.featured,
  });

  const fileContent = `${frontmatter}\n\n${body.description || ''}\n`;
  const existing = await githubRequest(env, `${filePath}?ref=${env.GITHUB_BRANCH}`);
  const sha = existing.ok ? ((await existing.json()) as { sha: string }).sha : undefined;

  const commitRes = await putFile(
    env,
    filePath,
    fileContent,
    sha,
    sha ? `Update video: ${body.title}` : `Add video: ${body.title}`
  );

  if (!commitRes.ok) {
    const err = await commitRes.text();
    return json({ error: 'GitHub commit failed', details: err }, 502);
  }

  return json({ ok: true, slug });
}

async function handleSettingsGet(_request: Request, env: Env): Promise<Response> {
  const settings = await getFile(env, 'src/data/site.json');
  const contact = await getFile(env, 'src/content/pages/contact.md');
  return json({
    settings: settings ? JSON.parse(settings.content) : null,
    contact: contact?.content ?? null,
  });
}

async function handleSettingsPost(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { settings?: Record<string, any>; contactMarkdown?: string };

  if (body.settings) {
    const existing = await getFile(env, 'src/data/site.json');
    const res = await putFile(
      env,
      'src/data/site.json',
      JSON.stringify(body.settings, null, 2) + '\n',
      existing?.sha,
      'Update site settings'
    );
    if (!res.ok) return json({ error: 'Failed to update settings' }, 502);
  }

  if (body.contactMarkdown) {
    const existing = await getFile(env, 'src/content/pages/contact.md');
    const res = await putFile(
      env,
      'src/content/pages/contact.md',
      body.contactMarkdown,
      existing?.sha,
      'Update contact page'
    );
    if (!res.ok) return json({ error: 'Failed to update contact page' }, 502);
  }

  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/login' && request.method === 'POST') return handleLogin(request, env);
    if (pathname === '/api/logout' && request.method === 'POST') return handleLogout();

    const isLoginPage = pathname === '/admin/login' || pathname === '/admin/login/';
    const isAdminPage = !isLoginPage && (pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin/'));
    const isProtectedApi = pathname === '/api/videos' || pathname === '/api/settings';

    if (isAdminPage || isProtectedApi) {
      const authed = await isAuthenticated(request, env);
      if (!authed) {
        if (isProtectedApi) return json({ error: 'Unauthorized' }, 401);
        return Response.redirect(`${url.origin}/admin/login`, 302);
      }
    }

    if (pathname === '/api/videos') {
      if (request.method === 'GET') return handleVideosGet(request, env);
      if (request.method === 'POST') return handleVideosPost(request, env);
    }

    if (pathname === '/api/settings') {
      if (request.method === 'GET') return handleSettingsGet(request, env);
      if (request.method === 'POST') return handleSettingsPost(request, env);
    }

    // Everything else — every static page, image, and the login page
    // itself — is served straight from the build.
    return env.ASSETS.fetch(request);
  },
};
