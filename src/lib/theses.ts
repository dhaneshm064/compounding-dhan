import { getCollection } from 'astro:content';
import thesisData from '../../worker/src/investment-theses.json';

type ThesisCard = (typeof thesisData.theses)[keyof typeof thesisData.theses][number];

export interface HoldingThesis {
  symbol: string;
  card: ThesisCard;
  href: string;
  researchHref: string | null;
}

export const thesisHref = (symbol: string) => `/posts/theses/${symbol.toLowerCase()}/`;

// The newest active thesis card per holding, joined with any blog deep-dive
// tagged with the same `ticker`. Shared by My Journey, the thesis pages and
// the portfolio holding cards so they never disagree on which version is live.
export async function activeTheses(): Promise<HoldingThesis[]> {
  const posts = await getCollection('blog');
  return Object.entries(thesisData.theses).flatMap(([symbol, cards]) => {
    const card = [...cards].filter((c) => c.status === 'active').sort((a, b) => b.version - a.version)[0];
    if (!card) return [];
    const post = posts.find((p) => p.data.ticker === symbol);
    return [{ symbol, card, href: thesisHref(symbol), researchHref: post ? `/blog/${post.id}/` : null }];
  });
}
