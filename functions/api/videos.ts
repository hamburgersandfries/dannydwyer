// Cloudflare Pages Function — handles /api/videos
//
// This function is the "write" side of the admin panel. It never touches a
// database: it reads and writes markdown files in src/content/videos/ directly
// in your GitHub repo via the GitHub Contents API. Pushing a commit triggers
// a fresh Cloudflare Pages deploy automatically.
//
// SECURITY: this route must be protected by Cloudflare Access (see README).
// The GitHub token below is a secret set as a Cloudflare Pages environment
// variable — it is never exposed to the browser.

interface Env {
  GITHUB_TOKEN: string;
  GITHUB_REPO: string; // e.g. "yourusername/dp-portfolio"
  GITHUB_BRANCH: string; // e.g. "main"
}

const CONTENT_DIR = 'src/content/videos';

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

async function githubRequest(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dp-portfolio-admin',
      ...(init.headers ?? {}),
    },
  });
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');

  if (slug) {
    // Return one video's raw markdown so the admin edit form can pre-fill.
    const res = await githubRequest(env, `${CONTENT_DIR}/${slug}.md?ref=${env.GITHUB_BRANCH}`);
    if (!res.ok) {
      return new Response(JSON.stringify({ error: 'Video not found' }), { status: 404 });
    }
    const data = (await res.json()) as { content: string };
    const raw = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
    return new Response(JSON.stringify({ slug, raw }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const res = await githubRequest(env, `${CONTENT_DIR}?ref=${env.GITHUB_BRANCH}`);
  if (!res.ok) {
    return new Response(JSON.stringify({ error: 'Could not list videos' }), { status: 502 });
  }
  const files = (await res.json()) as { name: string }[];
  const slugs = files
    .filter((f) => f.name.endsWith('.md'))
    .map((f) => f.name.replace(/\.md$/, ''));
  return new Response(JSON.stringify({ slugs }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await request.json<Record<string, any>>();

  const slug = slugify(body.slug || body.title);
  const filePath = `${CONTENT_DIR}/${slug}.md`;

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

  // Check whether the file already exists, to get its sha for updates.
  const existing = await githubRequest(env, `${filePath}?ref=${env.GITHUB_BRANCH}`);
  const sha = existing.ok ? ((await existing.json()) as { sha: string }).sha : undefined;

  const commitRes = await githubRequest(env, filePath, {
    method: 'PUT',
    body: JSON.stringify({
      message: sha ? `Update video: ${body.title}` : `Add video: ${body.title}`,
      content: btoa(unescape(encodeURIComponent(fileContent))),
      branch: env.GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });

  if (!commitRes.ok) {
    const err = await commitRes.text();
    return new Response(JSON.stringify({ error: 'GitHub commit failed', details: err }), {
      status: 502,
    });
  }

  return new Response(JSON.stringify({ ok: true, slug }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
