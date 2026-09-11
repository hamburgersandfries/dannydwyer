// Cloudflare Pages Function — handles /api/settings
// Reads/writes src/data/site.json (global settings) and
// src/content/pages/contact.md (the Contact page copy).

interface Env {
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
}

async function githubRequest(env: Env, path: string, init: RequestInit = {}) {
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

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const settings = await getFile(env, 'src/data/site.json');
  const contact = await getFile(env, 'src/content/pages/contact.md');
  return new Response(
    JSON.stringify({
      settings: settings ? JSON.parse(settings.content) : null,
      contact: contact?.content ?? null,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await request.json<{ settings?: Record<string, any>; contactMarkdown?: string }>();

  if (body.settings) {
    const existing = await getFile(env, 'src/data/site.json');
    const res = await putFile(
      env,
      'src/data/site.json',
      JSON.stringify(body.settings, null, 2) + '\n',
      existing?.sha,
      'Update site settings'
    );
    if (!res.ok) return new Response(JSON.stringify({ error: 'Failed to update settings' }), { status: 502 });
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
    if (!res.ok) return new Response(JSON.stringify({ error: 'Failed to update contact page' }), { status: 502 });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
};
