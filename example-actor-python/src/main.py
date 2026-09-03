import asyncio

from apify import Actor


async def main() -> None:
    async with Actor:
        for tick in range(1, 61):
            Actor.log.info(f'sample tick {tick}')
            await asyncio.sleep(1)
