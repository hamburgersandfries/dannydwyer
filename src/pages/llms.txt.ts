// llms.txt — a plain-text index of the site for AI crawlers and answer
// engines (ChatGPT, Perplexity, Claude, Google AI Overviews) that increasingly
// check for this file the way search engines check robots.txt/sitemap.xml.
// See https://llmstxt.org. Generated at build time from live content so it
// never drifts from the actual video list.
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { site } from '../data/site';

export const GET: APIRoute = async ({ site: astroSite }) => {
  const videos = (await getCollection('videos', (v) => !v.data.hidden)).sort(
    (a, b) => new Date(b.data.uploadDate).getTime() - new Date(a.data.uploadDate).getTime()
  );
  const base = astroSite?.toString().replace(/\/$/, '') ?? '';

  const lines = [
    `# ${site.name}`,
    '',
    `> ${site.tagline}`,
    '',
    site.introCopy,
    '',
    `${site.name} is a ${site.role} based in ${site.location}. Contact: ${site.email}.`,
    '',
    '## Work',
    '',
    `Full catalog of ${videos.length} video projects, filterable by tag at ${base}/videos.`,
    '',
    ...videos.map((v) => {
      const facts = [
        v.data.projectName ? `Project: ${v.data.projectName}` : null,
        v.data.client ? `Client: ${v.data.client}` : null,
        `Role: ${v.data.role}`,
        `Tags: ${v.data.tags.join(', ')}`,
      ]
        .filter(Boolean)
        .join(' · ');
      return `- [${v.data.title}](${base}/videos/${v.data.urlSlug}): ${v.data.summary} (${facts})`;
    }),
    '',
    '## Pages',
    '',
    `- [Contact](${base}/contact)`,
    `- [Sitemap](${base}/sitemap-index.xml)`,
  ];

  return new Response(lines.join('\n') + '\n', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
