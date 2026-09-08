"""Demo Actor for the browser debugger - deliberately structured to be fun to step through.

Try this once the debugger UI is open:
  * breakpoint inside `score_page` and watch `features` build up across ticks,
  * step INTO `extract_features` / OUT again,
  * evaluate `sum(features.values())` or mutate `page['depth']` in the console,
  * tick "break on raised exceptions" - `flaky_lookup` raises (and handles) KeyError
    every 5th tick, so the debugger will drop you on the raise site.
"""

import asyncio
import random

from apify import Actor

FAKE_PAGES = [
    {'url': 'https://example.com/', 'depth': 0, 'html': '<h1>Welcome</h1><a href=/a><a href=/b>'},
    {'url': 'https://example.com/a', 'depth': 1, 'html': '<h2>Products</h2><a href=/a/1>'},
    {'url': 'https://example.com/b', 'depth': 1, 'html': '<h2>Blog</h2><p>hello world</p>'},
    {'url': 'https://example.com/a/1', 'depth': 2, 'html': '<h3>Item 1</h3><b>$42</b>'},
]


def extract_features(page: dict) -> dict:
    html = page['html']
    return {
        'headings': sum(html.count(tag) for tag in ('<h1', '<h2', '<h3')),
        'links': html.count('<a '),
        'length': len(html),
        'has_price': '$' in html,
    }


def flaky_lookup(catalog: dict, key: str) -> str:
    try:
        return catalog[key]  # raises KeyError for unknown keys - nice exception-breakpoint demo
    except KeyError:
        return 'uncategorized'


def score_page(page: dict, tick: int) -> dict:
    features = extract_features(page)
    catalog = {'https://example.com/a': 'catalog', 'https://example.com/a/1': 'product'}
    category = flaky_lookup(catalog, page['url'])
    score = features['headings'] * 10 + features['links'] * 5 + features['length'] // 10
    if features['has_price']:
        score *= 2
    return {'url': page['url'], 'tick': tick, 'category': category, 'score': score, **features}


async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}
        ticks = int(actor_input.get('ticks', 120))
        Actor.log.info(f'Demo Actor started - will process pages for {ticks} ticks.')
        Actor.log.info('Open the debugger URL printed above by [actor-debugger].')

        for tick in range(1, ticks + 1):
            page = random.choice(FAKE_PAGES)
            result = score_page(page, tick)
            await Actor.push_data(result)
            Actor.log.info(f"tick {tick}: {result['url']} -> score {result['score']} ({result['category']})")
            await asyncio.sleep(2)

        Actor.log.info('Demo Actor finished.')
