import { glob } from 'astro/loaders';
import { defineCollection, z } from 'astro:content';

// A single "blog" collection. Each post is a Markdown file in src/content/blog/.
// The `id` of each post is derived from its filename (e.g. hello-world.md -> "hello-world").
const blog = defineCollection({
  loader: glob({ base: './src/content/blog', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
  }),
});

export const collections = { blog };
