// Cloudflare Worker — handles the admin panel's write endpoints.
//
// Static pages are served directly from dist/ by Cloudflare's asset
// handling (see wrangler.jsonc); this Worker only runs for requests that
// don't match a built file, which in practice means /api/videos and
// /api/settings. It reads and writes markdown/JSON files straight to this
// GitHub repo via the Contents API — no database.
//
// SECURITY: /admin and /api/* must be protected by Cloudflare Access (see
// README). GITHUB_TOKEN is a secret set as a Worker environment variable —
// it is never exposed to the browser.

export interface Env {
  ASSETS: Fetcher;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string; // e.g. "hamburgersandfries/dannydwyer"
  GITHUB_BRANCH: string; // e.g. "main"
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

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

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
    const { pathname } = new URL(request.url);

    if (pathname === '/api/videos') {
      if (request.method === 'GET') return handleVideosGet(request, env);
      if (request.method === 'POST') return handleVideosPost(request, env);
    }

    if (pathname === '/api/settings') {
      if (request.method === 'GET') return handleSettingsGet(request, env);
      if (request.method === 'POST') return handleSettingsPost(request, env);
    }

    // Static asset requests are served automatically before this Worker
    // runs; reaching here means nothing matched, so fall back to the asset
    // binding's own 404 handling.
    return env.ASSETS.fetch(request);
  },
};
