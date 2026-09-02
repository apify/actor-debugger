import { Actor, log } from 'apify';
await Actor.init();
const marker = 'sample-ts-actor-alive';
for (let i = 1; i <= 60; i++) {
    log.info(`sample tick ${i}`);
    await new Promise((r) => setTimeout(r, 1000));
}
await Actor.exit();
