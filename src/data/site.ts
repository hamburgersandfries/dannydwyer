// Thin typed wrapper around site.json. The admin panel writes to site.json
// directly (via the GitHub API), so keep this file's shape in sync with it.
import raw from './site.json';

export const site = raw as {
  name: string;
  role: string;
  tagline: string;
  introCopy: string;
  email: string;
  location: string;
  socials: Record<string, string>;
  homeReelSlug: string;
};
